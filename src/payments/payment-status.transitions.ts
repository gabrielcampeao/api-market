import { PaymentStatus } from '@prisma/client';

// The domain-legal adjacency list — kept intentionally narrower than "every
// (from, to) pair some call site's where-clause has ever accepted". The
// Stripe webhook's decline/approve handlers also accept PENDING as a source
// for FAILED/APPROVED/REFUNDED, but only because of out-of-order external
// delivery (an event can arrive before this app's own claim-to-PROCESSING
// transition completes) — that's a webhook-specific carve-out documented at
// its call site, not a domain transition, so it isn't listed here. Reusing
// sourceStatusesFor() elsewhere should never accidentally permit skipping
// PROCESSING.
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

// The two transitions the roadmap names explicitly as provably impossible —
// asserted individually and via a full matrix in the test, not just "not
// observed yet".
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
