import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import Stripe from 'stripe';
import { PaymentProvider, PaymentResult, PaymentStatusResult } from './payment-provider.interface';
import { AppConfigService } from '../../config/app-config.service';
import { MetricsService } from '../../metrics/metrics.service';

// No checkout UI collects a card here — orders are paid through a single
// backend endpoint. Stripe's test PaymentMethod token keeps charge() a single
// synchronous call; `sk_live_` keys reject it outright, so this is test-mode only.
const TEST_PAYMENT_METHOD = 'pm_card_visa';

@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly logger = new Logger(StripePaymentProvider.name);
  // Nest instantiates every provider in PaymentsModule regardless of which
  // one PAYMENT_PROVIDER selects, so this can't throw at construction when
  // unset — `stripe` stays undefined and charge()/checkStatus() throw only
  // if actually called.
  private readonly stripe: Stripe | undefined;

  constructor(
    config: AppConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : undefined;
  }

  private client(): Stripe {
    if (!this.stripe) {
      throw new Error('StripePaymentProvider requires STRIPE_SECRET_KEY to be set');
    }
    return this.stripe;
  }

  // charge() and checkStatus() both hit this same PaymentIntent-create call
  // (see checkStatus for why re-sending is safe) — the one network crossing,
  // so it's the one place the Stripe request metrics get recorded.
  private async createPaymentIntent(
    operation: 'charge' | 'checkStatus',
    amount: Decimal,
    reference: string,
    idempotencyKey: string,
  ): Promise<Stripe.PaymentIntent> {
    const stop = this.metrics.stripeRequestDurationSeconds.startTimer({ operation });
    try {
      const intent = await this.client().paymentIntents.create(
        {
          amount: toCents(amount),
          currency: 'usd',
          payment_method: TEST_PAYMENT_METHOD,
          confirm: true,
          off_session: true,
          description: `order:${reference}`,
          metadata: { orderId: reference },
        },
        { idempotencyKey },
      );
      stop();
      return intent;
    } catch (err) {
      stop();
      // Card decline is a normal response, not a call failure — only count
      // genuine transport/API errors, same distinction as payment_failed_total.
      if (!(err instanceof Stripe.errors.StripeCardError)) {
        this.metrics.stripeErrorsTotal.inc({ operation });
      }
      throw err;
    }
  }

  async charge(amount: Decimal, reference: string, idempotencyKey: string): Promise<PaymentResult> {
    try {
      const intent = await this.createPaymentIntent('charge', amount, reference, idempotencyKey);
      return this.toResult(intent);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeCardError) {
        // Surface as a declined PaymentResult, like FakePaymentProvider —
        // everything else (network/5xx/timeout) propagates so PaymentsService
        // reverts to PENDING, not FAILED.
        return {
          approved: false,
          providerRef: err.payment_intent?.id,
          failureCode: err.code,
          message: err.message,
        };
      }
      this.logger.warn(`Stripe charge failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async checkStatus(
    amount: Decimal,
    reference: string,
    idempotencyKey: string,
  ): Promise<PaymentStatusResult> {
    try {
      // Re-sending the same idempotency key returns the original PaymentIntent
      // instead of creating a new charge — a status check, not a second charge.
      const intent = await this.createPaymentIntent('checkStatus', amount, reference, idempotencyKey);
      const result = this.toResult(intent);
      return result.approved
        ? { status: 'approved', providerRef: result.providerRef }
        : {
            status: 'declined',
            providerRef: result.providerRef,
            failureCode: result.failureCode,
            message: result.message,
          };
    } catch (err) {
      if (err instanceof Stripe.errors.StripeCardError) {
        return {
          status: 'declined',
          providerRef: err.payment_intent?.id,
          failureCode: err.code,
          message: err.message,
        };
      }
      // Genuinely unknown, not a decline — reconciliation leaves it
      // PROCESSING and retries next run.
      this.logger.warn(
        `Stripe checkStatus failed, treating as unknown: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: 'unknown' };
    }
  }

  private toResult(intent: Stripe.PaymentIntent): PaymentResult {
    if (intent.status === 'succeeded') {
      return { approved: true, providerRef: intent.id };
    }
    const charge = intent.latest_charge;
    const failure =
      typeof charge === 'object' && charge !== null ? charge.failure_message : undefined;
    return {
      approved: false,
      providerRef: intent.id,
      message: failure ?? `Stripe PaymentIntent ended in status "${intent.status}"`,
    };
  }
}

function toCents(amount: Decimal): number {
  return Math.round(amount.toNumber() * 100);
}
