import { OrderStatus } from '@prisma/client';

// PENDING -> PAID is listed here as domain-legal but is never reachable
// through OrdersService.updateStatus() (the admin PATCH endpoint explicitly
// rejects setting PAID directly) — it's only ever written by the payment
// flow's own atomic updateMany. The table still lists it because it IS a
// real transition the system performs, just through a different door.
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.PAID, OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.PAID]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function sourceStatusesForOrder(target: OrderStatus): OrderStatus[] {
  return (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).filter((from) =>
    ORDER_TRANSITIONS[from].includes(target),
  );
}
