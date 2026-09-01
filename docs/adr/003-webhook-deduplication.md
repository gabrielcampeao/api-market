# 003 — Webhook deduplication via a persisted event row and a unique constraint

## Context

Stripe, and webhook senders generally, retry a delivery if they don't get a timely 2xx: the same event can arrive more than once, including genuinely concurrently if a slow first response causes a retry to fire before it returns. Processing the same `payment_intent.succeeded` event twice must not approve a payment or pay an order twice.

## Alternatives considered

- **In-memory dedup (a `Set` of seen event IDs)**: doesn't survive a restart, and doesn't work at all across multiple instances, which a single in-process `Set` can never account for.
- **Read-then-write dedup** (`SELECT` for the event ID, `INSERT` only if not found): has a TOCTOU gap. Two concurrent deliveries of the same event can both run the `SELECT` before either has inserted, both see "doesn't exist yet," and both proceed to process it.
- **Redis-based dedup (`SETNX` on the event ID)**: closes the race, but, for the same reasoning as [001](001-payment-concurrency.md), introduces a second system webhook processing now depends on, for a problem the database's own unique constraint already solves for free.

## Decision

Every event is persisted to `WebhookEvent` before processing, with a `@@unique([provider, eventId])` constraint doing the actual dedup:

```ts
const existing = await this.prisma.webhookEvent.findUnique({
  where: { provider_eventId: { provider: PROVIDER, eventId: event.id } },
});
if (existing?.processedAt) {
  return { status: 'duplicate' };
}
// ...
try {
  webhookEvent = await this.prisma.webhookEvent.create({ data: { provider, eventId, type, payload } });
} catch (err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    // Lost the create race — the winner's processing already covers this
    // event's outcome exactly once; nothing more for this delivery to do.
    return { status: 'duplicate' };
  }
  throw err;
}
```

The `findUnique` read is an optimization, skipping the write path entirely for the common "definitely already processed" case. The actual correctness guarantee is the `create()`'s unique constraint. Two concurrent deliveries that both pass the read (the TOCTOU gap above) both attempt the insert; the database allows exactly one to succeed, and the loser's `P2002` unique-violation error is caught and treated as "someone else is handling this," not an error.

Persisting before processing, not after, also means a crash mid-processing leaves a row with `processedAt: null`. Stripe's retry of the same event finds that row and reprocesses from a known state, instead of the event having vanished entirely.

## Consequences

- **What it guarantees**: the same `(provider, eventId)` is processed to completion exactly once, regardless of how many times it's delivered or how concurrently.
- **What it costs**: one extra table and one extra round-trip (the persist) before any actual payment logic runs, on every webhook delivery. Worth it for a guarantee this fundamental to the endpoint's job.
- **What it doesn't cover**: dedup is per event ID. Two different events for the same underlying payment (a stale `payment_intent.payment_failed` arriving after a later `payment_intent.succeeded`, say) are two distinct, both-valid deliveries. The terminal-state guard in `StripeWebhookService.handleOutcome()` (ignore events for a payment already `APPROVED` or `REFUNDED`) and the payment-claim-first ordering (see [001](001-payment-concurrency.md)) are what handle that class of problem; event-ID dedup alone wouldn't.
