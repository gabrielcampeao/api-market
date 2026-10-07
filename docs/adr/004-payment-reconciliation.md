# 004 — Polling reconciliation instead of an Outbox pattern

## Context

There's a real crash window in `PaymentsService.pay()`: the provider approves the charge, but the process dies before the follow-up `$transaction` (marking the payment `APPROVED` and the order `PAID`) commits. Nothing about local state can tell you this happened — the payment just looks `PROCESSING` forever. Something has to notice and recover it.

## Alternatives considered

- **Outbox pattern** — write an "intent to charge" row in the same transaction as claiming `PROCESSING`, have a separate worker read the outbox and make the actual provider call, guaranteeing the external effect eventually happens even if the process crashes right after committing. This is the right tool when a transaction commits and an external effect *must* follow no matter what. It doesn't fit here: the actual gap isn't "did the external call get made" (it did — the provider already has the definitive answer), it's "did *this API* find out and record it." Outbox would add a second table and a second worker to guarantee the provider call happens, when the provider call already happened; what's missing is asking the provider what it knows, not retrying a call it already received.
- **A message queue triggered by the failed transaction** — same shape problem: there's no failed transaction to react to, because the process crashed *before* the transaction ran at all. Nothing durable was written that a queue consumer could pick up.
- **`SELECT FOR UPDATE` + a long-lived worker holding a lock on stuck payments** — solves a different problem (contention between concurrent workers processing the *same* stuck payment), not the actual gap (nothing is checking stuck payments at all without this).

## Decision

A scheduled job (`PaymentReconciliationService`, `@Cron(EVERY_5_MINUTES)`, plus an admin-triggered `POST /payments/reconcile` for on-demand runs) polls for payments stuck `PROCESSING` past a staleness threshold and asks the provider directly:

```ts
const result = await this.provider.checkStatus(payment.amount, order.id, payment.providerIdempotencyKey);
```

`checkStatus()` re-sends the same idempotency key `charge()` originally used (see [002](002-provider-idempotency.md)) — for a real provider, this returns the original charge's actual outcome instead of creating a new one. The provider is the source of truth here; local state was never going to be able to answer "did the charge happen" on its own.

Every payment claim in the recovery path follows the same claim-first-before-touching-anything-else discipline as [001](001-payment-concurrency.md) — two overlapping reconciliation runs, or reconciliation racing the webhook handler, must settle a payment exactly once (see the concurrency-safety fixes in `payment-reconciliation.service.ts`'s and `stripe-webhook.service.ts`'s git history, and the e2e test that fires both simultaneously at the same stuck payment).

## Consequences

- **What it guarantees**: a payment stuck in the crash window gets recovered within one staleness-window-plus-cron-interval, without requiring the crashed process to have written anything durable beyond what `pay()` already wrote before calling the provider.
- **What it costs**: recovery isn't instant — a payment can sit `PROCESSING` for up to the staleness threshold (5 minutes default) before reconciliation even looks at it, plus up to the cron interval if the scheduled run just missed it. The admin endpoint exists specifically to bypass that wait when needed (e.g. right after reproducing a crash manually).
- **What this doesn't solve on its own**: the webhook (`StripeWebhookService`) is the *faster* recovery path for the same crash window — Stripe pushes the outcome instead of this API polling for it. Reconciliation is the backstop for when no webhook is configured, or a webhook delivery itself was lost. Both paths write through the same claim-first pattern specifically so having two recovery mechanisms doesn't introduce a new way to double-settle a payment.
