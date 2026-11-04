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
  // Provider doesn't know or couldn't be reached — caller must leave the
  // payment PROCESSING and retry later, not guess.
  | { status: 'unknown' };

export interface PaymentProvider {
  readonly name: string;
  // idempotencyKey = Payment.providerIdempotencyKey, same value on every
  // retry, so a real provider can dedupe instead of capturing the card twice.
  charge(amount: Decimal, reference: string, idempotencyKey: string): Promise<PaymentResult>;
  // Used by PaymentReconciliationService for a payment stuck in PROCESSING.
  // Same args as charge() because for a real provider it IS a charge call —
  // the repeated idempotency key returns the original outcome instead of
  // charging again.
  checkStatus(amount: Decimal, reference: string, idempotencyKey: string): Promise<PaymentStatusResult>;
}

// DI token: PaymentsService depends on this, not FakePaymentProvider directly,
// so swapping in a real gateway is a one-line change in PaymentsModule.
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
