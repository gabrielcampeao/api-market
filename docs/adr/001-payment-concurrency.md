# 001 — Payment concurrency via atomic `updateMany`, not a lock

## Context

Two requests can hit "pay this order" at once — a double-click, a retried client call, a malicious replay. Whatever design handles it needs to guarantee the provider gets charged at most once, without funneling all payment traffic through a single serialization point.

## Alternatives considered

- **`SELECT ... FOR UPDATE`**: locks the row for the transaction's duration. It works, but ties up a DB connection and a transaction slot for as long as the provider call takes (up to `PROVIDER_TIMEOUT_MS` = 15s). Under load, that's 15 seconds of a connection sitting idle, waiting on an external HTTP call.
- **A Redis distributed lock (`SETNX` + TTL)**: doesn't hold a DB connection hostage, but pulls in a second system that now has to be up for payments to work at all. A TTL-based lock also carries its own correctness bug: if the lock-holder is just slow rather than dead, the TTL can expire and let a second request in while the first is still mid-charge. Fixing that properly needs renewal or fencing — a lot of machinery for something the database already solves.
- **A boolean `locked` column, or a sentinel value stuffed in an existing field** (this code used to do exactly that: `providerRef = '__claiming__'`): cheap to write, but overloads a field's meaning and doesn't compose. Nothing stops another code path from writing to that field without knowing the sentinel convention exists.

## Decision

A single `updateMany` with the precondition in the `WHERE` clause, gated on `PaymentStatus`:

```ts
const claimed = await this.prisma.payment.updateMany({
  where: { id: payment.id, status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] } },
  data: { status: PaymentStatus.PROCESSING, processingAt: new Date() },
});
if (claimed.count !== 1) {
  throw new ConflictException('This payment is already being processed or has been settled');
}
```

That's a compare-and-swap at the database level: only one caller's `WHERE` clause still matches the row's current state, so only that one gets `count === 1`. No external system, no connection held past a single statement, nothing to expire or renew.

The same shape — claim first via a conditional `updateMany`, check the count, only proceed on success — gets reused everywhere else a payment or order status changes: `PaymentReconciliationService`, `StripeWebhookService`, and `OrdersService`'s cancel and status-transition paths. See `src/payments/payment-status.transitions.ts` and `src/orders/order-status.transitions.ts` for the centralized transition tables backing these checks.

## Consequences

- **What it protects**: exactly one caller can move a single row from one status to another at a time. That's the actual invariant this needs — only one request gets to call the provider.
- **What it doesn't protect**: a crash between winning the claim (now `PROCESSING`) and recording the provider's response leaves the payment stuck at `PROCESSING`, with no automatic recovery from this mechanism alone. `PaymentReconciliationService` exists to close exactly that gap (see [004](004-payment-reconciliation.md)).
- **Scope limit**: this only guards one row's status transition. Anything touching more than one row atomically (settling the payment while marking the order `PAID`) gets wrapped in a `$transaction`, with the claim still happening first inside it. Skip that ordering and a losing request could mutate the order before ever checking whether it owns the payment — a real bug that showed up and got fixed in both `PaymentReconciliationService` and `StripeWebhookService` (see their git history).
