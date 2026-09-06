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
    this.stripe = config.stripeWebhookSecret
      ? new Stripe(
          config.stripeSecretKey || 'sk_test_placeholder_for_webhook_signature_verification',
        )
      : undefined;
  }
  async handleEvent(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<{
    status: string;
  }> {
    if (!this.stripe || !this.config.stripeWebhookSecret) {
      this.metrics.webhookInvalidSignatureTotal.inc({ provider: PROVIDER });
      throw new BadRequestException('Webhook signature could not be verified');
    }
    if (!rawBody || !signature) {
      this.metrics.webhookInvalidSignatureTotal.inc({ provider: PROVIDER });
      throw new BadRequestException('Webhook signature could not be verified');
    }
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.config.stripeWebhookSecret,
      );
    } catch (err) {
      this.logger.warn(`Rejected webhook: ${err instanceof Error ? err.message : String(err)}`);
      this.metrics.webhookInvalidSignatureTotal.inc({ provider: PROVIDER });
      throw new BadRequestException('Webhook signature could not be verified');
    }
    this.metrics.webhookReceivedTotal.inc({ provider: PROVIDER, type: event.type });
    const existing = await this.prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider: PROVIDER, eventId: event.id } },
    });
    if (existing?.processedAt) {
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
      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { error: message },
      });
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
        return;
    }
  }
  private async handleOutcome(
    intent: Stripe.PaymentIntent,
    outcome: 'approved' | 'declined',
  ): Promise<void> {
    const orderId = intent.metadata?.orderId;
    const payment = orderId
      ? await this.prisma.payment.findFirst({ where: { orderId } })
      : await this.prisma.payment.findFirst({ where: { providerRef: intent.id } });
    if (!payment) {
      this.logger.warn(`No payment found for PaymentIntent ${intent.id}, ignoring webhook`);
      return;
    }
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
        where: {
          id: payment.id,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
        },
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
    const settlement = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
        },
        data: {
          status: PaymentStatus.APPROVED,
          providerRef: intent.id,
          paidAt: new Date(),
          processingAt: null,
        },
      });
      if (claim.count === 0) {
        return { claimed: false, orderCancelledDuringPayment: false };
      }
      const orderStillPending = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PENDING },
        data: { status: OrderStatus.PAID },
      });
      if (orderStillPending.count === 0) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.REFUNDED },
        });
      }
      if (attempt) {
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: PaymentAttemptStatus.APPROVED,
            providerRef: intent.id,
            finishedAt: new Date(),
          },
        });
      }
      return { claimed: true, orderCancelledDuringPayment: orderStillPending.count === 0 };
    });
    if (!settlement.claimed) {
      return;
    }
    await this.audit.log({
      action: settlement.orderCancelledDuringPayment
        ? 'payment.webhook_reversed_order_cancelled'
        : 'payment.webhook_approved',
      entity: 'order',
      entityId: payment.orderId,
      metadata: { provider: PROVIDER, providerRef: intent.id } as Prisma.InputJsonValue,
    });
  }
}
