import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import Stripe from 'stripe';
import { PaymentProvider, PaymentResult } from './payment-provider.interface';
import { AppConfigService } from '../../config/app-config.service';

// No real checkout UI collects a card in this project — orders are paid
// through a single backend endpoint, not a client-side Stripe Elements
// form. Using Stripe's dedicated test PaymentMethod tokens (rather than a
// real card) lets charge() stay a single synchronous call, matching the
// existing PaymentProvider contract, without building a frontend just to
// exercise the gateway. `sk_live_` keys reject these tokens outright, so
// this only works in Stripe test mode by construction.
const TEST_PAYMENT_METHOD = 'pm_card_visa';

@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly logger = new Logger(StripePaymentProvider.name);
  // Constructed even when STRIPE_SECRET_KEY is unset — Nest instantiates
  // every provider in PaymentsModule regardless of which one the
  // PAYMENT_PROVIDER factory ends up selecting (see payments.module.ts), so
  // this can't throw at construction time or the app would fail to boot
  // with the Fake provider active. `stripe` stays undefined instead, and
  // charge() throws only if this provider is actually called —
  // which the factory guarantees won't happen without a key.
  private readonly stripe: Stripe | undefined;

  constructor(config: AppConfigService) {
    this.stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : undefined;
  }

  private client(): Stripe {
    if (!this.stripe) {
      throw new Error('StripePaymentProvider requires STRIPE_SECRET_KEY to be set');
    }
    return this.stripe;
  }

  async charge(amount: Decimal, reference: string, idempotencyKey: string): Promise<PaymentResult> {
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
      return this.toResult(intent);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeCardError) {
        // A card decline is Stripe's normal response, not a failure of the
        // call itself — surface it as a declined PaymentResult like
        // FakePaymentProvider does, not as a thrown error. Everything else
        // (network error, 5xx, timeout) is a genuine "we don't know what
        // happened" case and must propagate so PaymentsService treats it as
        // such (revert to PENDING, not FAILED).
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
