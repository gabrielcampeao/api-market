import { Decimal } from '@prisma/client/runtime/library';

export interface PaymentResult {
  approved: boolean;
  providerRef?: string;
  failureCode?: string;
  message?: string;
}

export interface PaymentProvider {
  readonly name: string;
  // idempotencyKey is Payment.providerIdempotencyKey — the same value is
  // passed on every retry of the same payment, so a real provider can
  // dedupe a retried charge instead of capturing the card twice.
  charge(amount: Decimal, reference: string, idempotencyKey: string): Promise<PaymentResult>;
}

// DI token: PaymentsService depends on this, not on FakePaymentProvider
// directly. Swapping in a real gateway means changing the one `useClass`
// line in PaymentsModule — PaymentsService's orchestration logic (the
// PENDING->PROCESSING claim, the post-charge transaction) never changes.
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
