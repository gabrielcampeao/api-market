import { PaymentStatus } from '@prisma/client';

// Domain-legal adjacency list. The Stripe webhook also accepts PENDING as a
// source for FAILED/APPROVED (out-of-order external delivery) but that's a
// carve-out documented at its call site, not listed here — sourceStatusesFor()
// should never permit skipping PROCESSING.
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.PROCESSING],
  [PaymentStatus.PROCESSING]: [
    PaymentStatus.PENDING,
    PaymentStatus.FAILED,
    PaymentStatus.APPROVED,
    PaymentStatus.REFUNDED,
  ],
  [PaymentStatus.FAILED]: [PaymentStatus.PROCESSING],
  [PaymentStatus.APPROVED]: [PaymentStatus.REFUNDED],
  [PaymentStatus.REFUNDED]: [],
};

// Transitions the roadmap names as provably impossible, asserted individually
// and via a full matrix in the test.
export const IMPOSSIBLE_PAYMENT_TRANSITIONS: ReadonlyArray<[PaymentStatus, PaymentStatus]> = [
  [PaymentStatus.APPROVED, PaymentStatus.PROCESSING],
  [PaymentStatus.REFUNDED, PaymentStatus.APPROVED],
];

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function sourceStatusesFor(target: PaymentStatus): PaymentStatus[] {
  return (Object.keys(PAYMENT_TRANSITIONS) as PaymentStatus[]).filter((from) =>
    PAYMENT_TRANSITIONS[from].includes(target),
  );
}
