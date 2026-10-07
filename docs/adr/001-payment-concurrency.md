# 001 — Payment concurrency via atomic `updateMany`, not a lock

## Context

Two requests can try to pay the same order at the same time (a double-click, a retried client request, a malicious replay). Whichever design handles this has to guarantee the provider is charged at most once, without serializing all payment traffic through a single point.

## Alternatives considered

- **`SELECT ... FOR UPDATE`** — locks the row for the transaction's duration. Works, but ties up a DB connection and a transaction slot for as long as the provider call takes (up to `PROVIDER_TIMEOUT_MS` = 15s) — under load, that's 15 seconds of a connection doing nothing but waiting on an external HTTP call.
- **A Redis distributed lock (`SETNX` + TTL)** — doesn't hold a DB connection hostage, but introduces a second system that has to be up for payments to work at all, and a TTL-based lock has its own correctness problem: if the process holding the lock is just slow (not dead), the TTL can expire and let a second request in while the first is still mid-charge. Getting that right needs a renewal/fencing scheme, which is a lot of machinery for a problem the database can already solve.
- **A boolean `locked` column, or a sentinel value stashed in an existing field** (this code used to do this — `providerRef = '__claiming__'`) — cheap to write, but overloads a field's meaning and doesn't compose: nothing stops a second code path from writing to that field without knowing about the sentinel convention.

## Decision

A single `updateMany` with the precondition in the `WHERE` clause, conditioned on `PaymentStatus`:

```ts
const claimed = await this.prisma.payment.updateMany({
  where: { id: payment.id, status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] } },
  data: { status: PaymentStatus.PROCESSING, processingAt: new Date() },
});
if (claimed.count !== 1) {
  throw new ConflictException('This payment is already being processed or has been settled');
}
```

This is a compare-and-swap at the database level: only one caller's `WHERE` clause matches the row's current state, so only one gets `count === 1`. No external system, no held connection beyond the single statement, no lock to expire or renew.

The same pattern — claim first via a conditional `updateMany`, check the count, only proceed if it succeeded — is reused everywhere else a payment or order status changes: `PaymentReconciliationService`, `StripeWebhookService`, and `OrdersService`'s cancel/status-transition paths. See `src/payments/payment-status.transitions.ts` and `src/orders/order-status.transitions.ts` for the centralized transition tables these checks are built from.

## Consequences

- **What it protects**: exactly one caller can transition a single row from one status to another at a time. That's the actual invariant needed here — "only one request gets to call the provider."
- **What it doesn't protect**: a crash between winning the claim (now `PROCESSING`) and recording the provider's response leaves the payment stuck at `PROCESSING` with no automatic recovery from *this* mechanism alone — that gap is what `PaymentReconciliationService` exists to close (see [004](004-payment-reconciliation.md)).
- **Scope limit**: this only guards a single row's status transition. Anything that needs to change more than one row atomically (the payment settling *and* the order being marked `PAID`) is wrapped in a `$transaction` — the claim still has to happen first inside it, otherwise a losing request could still mutate the order before checking whether it actually owns the payment (a real bug found and fixed in both `PaymentReconciliationService` and `StripeWebhookService` — see their git history).
