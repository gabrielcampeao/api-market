import { OrderStatus } from '@prisma/client';
import { canTransitionOrder, sourceStatusesForOrder } from './order-status.transitions';

const { PENDING, PAID, SHIPPED, DELIVERED, CANCELLED } = OrderStatus;

// Hand-written, not derived from order-status.transitions.ts — same reasoning
// as payment-status.transitions.spec.ts: catches an accidental edit to the
// table rather than re-asserting the file against itself.
const EXPECTED: Record<OrderStatus, Record<OrderStatus, boolean>> = {
  [PENDING]: { PENDING: false, PAID: true, SHIPPED: true, DELIVERED: false, CANCELLED: true },
  [PAID]: { PENDING: false, PAID: false, SHIPPED: true, DELIVERED: false, CANCELLED: true },
  [SHIPPED]: { PENDING: false, PAID: false, SHIPPED: false, DELIVERED: true, CANCELLED: false },
  [DELIVERED]: { PENDING: false, PAID: false, SHIPPED: false, DELIVERED: false, CANCELLED: false },
  [CANCELLED]: { PENDING: false, PAID: false, SHIPPED: false, DELIVERED: false, CANCELLED: false },
};

describe('order-status.transitions', () => {
  it.each(Object.values(OrderStatus))('matches the expected transition table for %s', (from) => {
    for (const to of Object.values(OrderStatus)) {
      expect(canTransitionOrder(from, to)).toBe(EXPECTED[from][to]);
    }
  });

  it('DELIVERED and CANCELLED are terminal', () => {
    expect(sourceStatusesForOrder(DELIVERED)).toEqual([SHIPPED]);
    for (const target of Object.values(OrderStatus)) {
      expect(canTransitionOrder(DELIVERED, target)).toBe(false);
      expect(canTransitionOrder(CANCELLED, target)).toBe(false);
    }
  });

  it('allows PENDING -> PAID even though updateStatus() rejects it (only the payment flow writes it)', () => {
    expect(canTransitionOrder(PENDING, PAID)).toBe(true);
  });
});
