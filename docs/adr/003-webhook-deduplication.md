# 003 — Webhook deduplication via a persisted event row and a unique constraint

## Context

Stripe, like webhook senders in general, retries a delivery when it doesn't get a timely 2xx: the same event can show up more than once, including genuinely concurrently if a slow first response triggers a retry before it returns. Processing the same `payment_intent.succeeded` event twice must not approve a payment or pay an order twice.

## Alternatives considered

- **In-memory dedup (a `Set` of seen event IDs)**: doesn't survive a restart, and doesn't work at all once there's more than one instance — a single in-process `Set` has no way to account for that.
- **Read-then-write dedup** (`SELECT` for the event ID, `INSERT` only if not found): has a TOCTOU gap. Two concurrent deliveries of the same event can both run the `SELECT` before either has inserted, both see "doesn't exist yet," and both proceed to process it.
- **Redis-based dedup (`SETNX` on the event ID)**: closes the race, but for the same reasoning as [001](001-payment-concurrency.md), drags in a second system webhook processing now depends on, for something the database's own unique constraint already solves for free.

## Decision

Every event gets persisted to `WebhookEvent` before processing, with a `@@unique([provider, eventId])` constraint doing the actual dedup work:

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

The `findUnique` read is just an optimization — it skips the write path entirely for the common "definitely already processed" case. The real correctness guarantee comes from `create()`'s unique constraint: two concurrent deliveries that both slip past the read (the TOCTOU gap above) both attempt the insert, the database lets exactly one succeed, and the loser's `P2002` unique-violation error gets caught and read as "someone else has this," not an error.

Persisting before processing rather than after also means a crash mid-processing leaves a row with `processedAt: null`. Stripe's retry of the same event finds that row and reprocesses from a known state instead of the event vanishing entirely.

## Consequences

- **What it guarantees**: the same `(provider, eventId)` gets processed to completion exactly once, no matter how many times or how concurrently it's delivered.
- **What it costs**: one extra table and one extra round-trip (the persist) ahead of any actual payment logic, on every webhook delivery. Worth it for a guarantee this fundamental to the endpoint's job.
- **What it doesn't cover**: dedup happens per event ID. Two different events tied to the same underlying payment — a stale `payment_intent.payment_failed` arriving after a later `payment_intent.succeeded`, say — are two distinct, both-valid deliveries. The terminal-state guard in `StripeWebhookService.handleOutcome()` (ignore events for a payment already `APPROVED` or `REFUNDED`) and the payment-claim-first ordering (see [001](001-payment-concurrency.md)) are what actually handle that case; event-ID dedup alone wouldn't.
