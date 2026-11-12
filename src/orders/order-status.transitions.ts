import { OrderStatus } from '@prisma/client';
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
