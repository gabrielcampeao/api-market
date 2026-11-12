import { PaymentStatus } from '@prisma/client';
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
