# 004 — Polling reconciliation instead of an Outbox pattern

## Context

There's a real crash window in `PaymentsService.pay()`: the provider approves the charge, but the process dies before the follow-up `$transaction` (marking the payment `APPROVED` and the order `PAID`) commits. Local state can't tell you this happened — the payment just looks `PROCESSING` forever. Something has to notice and recover it.

## Alternatives considered

- **Outbox pattern**: write an "intent to charge" row in the same transaction as claiming `PROCESSING`, have a separate worker read the outbox and make the actual provider call, guaranteeing the external effect eventually happens even if the process crashes right after committing. That's the right tool when a transaction commits and an external effect must follow no matter what — it doesn't fit here, because the actual gap isn't whether the external call got made (it did; the provider already has the definitive answer), it's whether this API ever found out and recorded it. An outbox would add a second table and a second worker to guarantee a call happens that already happened. What's missing is asking the provider what it knows, not retrying a call it already received.
- **A message queue triggered by the failed transaction**: same shape of problem. There's no failed transaction to react to, since the process crashed before the transaction even ran. Nothing durable got written for a queue consumer to pick up.
- **`SELECT FOR UPDATE` plus a long-lived worker holding a lock on stuck payments**: solves a different problem entirely (contention between concurrent workers processing the same stuck payment), not the actual gap — which is that nothing is checking stuck payments at all without this.

## Decision

A scheduled job (`PaymentReconciliationService`, `@Cron(EVERY_5_MINUTES)`, plus an admin-triggered `POST /payments/reconcile` for on-demand runs) polls for payments stuck `PROCESSING` past a staleness threshold and asks the provider directly:

```ts
const result = await this.provider.checkStatus(payment.amount, order.id, payment.providerIdempotencyKey);
```

`checkStatus()` resends the same idempotency key `charge()` originally used (see [002](002-provider-idempotency.md)). For a real provider, that returns the original charge's actual outcome instead of creating a new one. The provider is the source of truth here — local state was never going to answer "did the charge happen" on its own.

Every payment claim in the recovery path follows the same claim-first-before-touching-anything-else discipline as [001](001-payment-concurrency.md): two overlapping reconciliation runs, or reconciliation racing the webhook handler, must settle a payment exactly once (see the concurrency-safety fixes in `payment-reconciliation.service.ts` and `stripe-webhook.service.ts`'s git history, and the e2e test that fires both at the same stuck payment simultaneously).

## Consequences

- **What it guarantees**: a payment stuck in the crash window recovers within one staleness-window-plus-cron-interval, without needing the crashed process to have written anything durable beyond what `pay()` already wrote before calling the provider.
- **What it costs**: recovery isn't instant. A payment can sit `PROCESSING` for up to the staleness threshold (5 minutes default) before reconciliation even looks at it, plus up to the cron interval if the scheduled run just missed the window. The admin endpoint exists specifically to skip that wait when needed — right after reproducing a crash manually, for instance.
- **What this doesn't solve on its own**: the webhook (`StripeWebhookService`) is the faster recovery path for the same crash window, since Stripe pushes the outcome instead of this API polling for it. Reconciliation is the backstop for when no webhook is configured, or a webhook delivery itself got lost. Both paths write through the same claim-first pattern specifically so having two recovery mechanisms doesn't open a new way to double-settle a payment.
