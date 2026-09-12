import { Decimal } from '@prisma/client/runtime/library';

export interface PaymentResult {
  approved: boolean;
  providerRef?: string;
  failureCode?: string;
  message?: string;
}

export type PaymentStatusResult =
  | { status: 'approved'; providerRef?: string }
  | { status: 'declined'; providerRef?: string; failureCode?: string; message?: string }
  // The provider itself doesn't know, or we couldn't reach it to ask — the
  // caller (PaymentReconciliationService) must leave the payment as
  // PROCESSING and try again later, not guess.
  | { status: 'unknown' };

export interface PaymentProvider {
  readonly name: string;
  // idempotencyKey is Payment.providerIdempotencyKey — the same value is
  // passed on every retry of the same payment, so a real provider can
  // dedupe a retried charge instead of capturing the card twice.
  charge(amount: Decimal, reference: string, idempotencyKey: string): Promise<PaymentResult>;
  // Used by PaymentReconciliationService for a payment stuck in PROCESSING
  // (the process crashed between the provider approving and this API
  // recording it). Takes the exact same arguments as charge() because for a
  // real provider this IS a charge call — Stripe recognizes the repeated
  // idempotency key and returns the original PaymentIntent's outcome instead
  // of charging again, which is what makes it safe to call here.
  checkStatus(amount: Decimal, reference: string, idempotencyKey: string): Promise<PaymentStatusResult>;
}

// DI token: PaymentsService depends on this, not on FakePaymentProvider
// directly. Swapping in a real gateway means changing the one `useClass`
// line in PaymentsModule — PaymentsService's orchestration logic (the
// PENDING->PROCESSING claim, the post-charge transaction) never changes.
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
