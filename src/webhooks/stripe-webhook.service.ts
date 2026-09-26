import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { OrderStatus, PaymentAttemptStatus, PaymentStatus, Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { AppConfigService } from '../config/app-config.service';
import { MetricsService } from '../metrics/metrics.service';

const PROVIDER = 'stripe';

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);
  private readonly stripe: Stripe | undefined;

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly metrics: MetricsService,
  ) {
    // constructEvent() below is pure local HMAC verification against
    // stripeWebhookSecret — it never calls the Stripe API, so the client
    // doesn't need a real (or even matching) STRIPE_SECRET_KEY. Gating this
    // on stripeSecretKey would incorrectly couple "can this API verify
    // webhook signatures" to "is this API configured to charge cards",
    // which are independent concerns (e.g. FakePaymentProvider active for
    // charges, but real Stripe webhooks still need verifying).
    this.stripe = config.stripeWebhookSecret
      ? new Stripe(config.stripeSecretKey || 'sk_test_placeholder_for_webhook_signature_verification')
      : undefined;
  }

  async handleEvent(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ status: string }> {
    if (!this.stripe || !this.config.stripeWebhookSecret) {
      // Deliberately not "not configured, skipping" — an attacker sending
      // requests here while this is unset should get the same rejection as
      // a bad signature, not a hint that the endpoint exists but is open.
      this.metrics.webhookInvalidSignatureTotal.inc({ provider: PROVIDER });
      throw new BadRequestException('Webhook signature could not be verified');
    }
    if (!rawBody || !signature) {
      this.metrics.webhookInvalidSignatureTotal.inc({ provider: PROVIDER });
      throw new BadRequestException('Webhook signature could not be verified');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.config.stripeWebhookSecret);
    } catch (err) {
      this.logger.warn(`Rejected webhook: ${err instanceof Error ? err.message : String(err)}`);
      this.metrics.webhookInvalidSignatureTotal.inc({ provider: PROVIDER });
      throw new BadRequestException('Webhook signature could not be verified');
    }
    this.metrics.webhookReceivedTotal.inc({ provider: PROVIDER, type: event.type });

    // Persisted before processing: if handling crashes below, the event is
    // on disk and a Stripe retry will find this row (via the unique
    // (provider, eventId) constraint) and pick up processing again, instead
    // of the event just vanishing.
    const existing = await this.prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider: PROVIDER, eventId: event.id } },
    });
    if (existing?.processedAt) {
      // Already fully handled — this is Stripe retrying a delivery it
      // considers unconfirmed (or the same event genuinely sent twice).
      // Same event, sent any number of times, must land on the same final
      // state; doing nothing here is what guarantees that.
      this.metrics.webhookDuplicateTotal.inc({ provider: PROVIDER });
      return { status: 'duplicate' };
    }

    let webhookEvent = existing;
    if (!webhookEvent) {
      try {
        webhookEvent = await this.prisma.webhookEvent.create({
          data: {
            provider: PROVIDER,
            eventId: event.id,
            type: event.type,
            payload: event as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // Same TOCTOU gap IdempotencyService guards against: the read
          // above and this create() aren't atomic, so two concurrent
          // deliveries of the same event can both see "doesn't exist yet".
          // The loser doesn't need to wait for the winner's result the way
          // IdempotencyService does — Stripe only needs a 2xx to stop
          // retrying, and the winner's processing already covers the
          // outcome exactly once.
          this.metrics.webhookDuplicateTotal.inc({ provider: PROVIDER });
          return { status: 'duplicate' };
        }
        throw err;
      }
    }

    try {
      await this.process(event);
      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processedAt: new Date() },
      });
      return { status: 'processed' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.webhookEvent.update({ where: { id: webhookEvent.id }, data: { error: message } });
      // Rethrow so the controller returns 5xx — Stripe interprets that as
      // "retry later". processedAt stays null, so the retry actually
      // reprocesses instead of short-circuiting on the duplicate check above.
      throw err;
    }
  }

  private async process(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handleOutcome(event.data.object as Stripe.PaymentIntent, 'approved');
        return;
      case 'payment_intent.payment_failed':
        await this.handleOutcome(event.data.object as Stripe.PaymentIntent, 'declined');
        return;
      default:
        // Unhandled event types are expected — Stripe sends far more event
        // types than this integration needs to react to. Not an error.
        return;
    }
  }

  private async handleOutcome(intent: Stripe.PaymentIntent, outcome: 'approved' | 'declined'): Promise<void> {
    // Correlating by our own providerRef would fail for exactly the case
    // this webhook exists to cover: a crash between the provider approving
    // and this API recording that PaymentIntent id locally means providerRef
    // is still null. StripePaymentProvider sets metadata.orderId on every
    // PaymentIntent it creates specifically so the webhook can find the
    // payment via the order instead — that field is on Stripe's side, not
    // ours, so it survives regardless of what we managed to persist.
    const orderId = intent.metadata?.orderId;
    const payment = orderId
      ? await this.prisma.payment.findFirst({ where: { orderId } })
      : await this.prisma.payment.findFirst({ where: { providerRef: intent.id } });
    if (!payment) {
      // A PaymentIntent this API never created (different environment
      // sharing the Stripe account, a stale test event) — nothing to
      // reconcile it against, and guessing would be worse than ignoring it.
      this.logger.warn(`No payment found for PaymentIntent ${intent.id}, ignoring webhook`);
      return;
    }
    // A payment already APPROVED or REFUNDED is terminal from this app's
    // perspective — a late "declined" event for an intent that our own
    // synchronous charge() call already resolved as approved is exactly the
    // out-of-order case this guard exists for. Downgrading it here would be
    // worse than ignoring a webhook we didn't strictly need.
    if (payment.status === PaymentStatus.APPROVED || payment.status === PaymentStatus.REFUNDED) {
      return;
    }

    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { paymentId: payment.id },
      orderBy: { startedAt: 'desc' },
    });

    if (outcome === 'declined') {
      if (attempt) {
        await this.prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: PaymentAttemptStatus.DECLINED,
            providerRef: intent.id,
            failureCode: intent.last_payment_error?.code ?? null,
            failureMessage: intent.last_payment_error?.message ?? null,
            finishedAt: new Date(),
          },
        });
      }
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] } },
        data: { status: PaymentStatus.FAILED, providerRef: intent.id, processingAt: null },
      });
      await this.audit.log({
        action: 'payment.webhook_declined',
        entity: 'order',
        entityId: payment.orderId,
        metadata: { provider: PROVIDER, providerRef: intent.id } as Prisma.InputJsonValue,
      });
      return;
    }

    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: payment.orderId } });
    await this.prisma.$transaction(async (tx) => {
      if (attempt) {
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: PaymentAttemptStatus.APPROVED, providerRef: intent.id, finishedAt: new Date() },
        });
      }
      const orderStillPending = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PENDING },
        data: { status: OrderStatus.PAID },
      });
      await tx.payment.updateMany({
        where: { id: payment.id, status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] } },
        data: {
          status: orderStillPending.count > 0 ? PaymentStatus.APPROVED : PaymentStatus.REFUNDED,
          providerRef: intent.id,
          paidAt: new Date(),
          processingAt: null,
        },
      });
    });
    await this.audit.log({
      action: 'payment.webhook_approved',
      entity: 'order',
      entityId: payment.orderId,
      metadata: { provider: PROVIDER, providerRef: intent.id } as Prisma.InputJsonValue,
    });
  }
}
