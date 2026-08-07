import { Decimal } from '@prisma/client/runtime/library';

export interface PaymentResult {
  approved: boolean;
  providerRef?: string;
  message?: string;
}

export interface PaymentProvider {
  readonly name: string;
  charge(amount: Decimal, reference: string): Promise<PaymentResult>;
}

// DI token: PaymentsService depends on this, not on FakePaymentProvider
// directly. Swapping in a real gateway means changing the one `useClass`
// line in PaymentsModule — PaymentsService's orchestration logic (the
// PENDING->PROCESSING claim, the post-charge transaction) never changes.
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
