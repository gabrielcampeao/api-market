# 002 — Provider-side idempotency key, separate from the client-facing one

## Context

If a charge request reaches Stripe but the response is lost (network blip, this process crashing mid-call, a timeout), retrying naively risks charging the card twice — the first charge may well have gone through even though this API never saw a result. This is a distinct problem from client-facing idempotency (`Idempotency-Key` header, see `idempotency.service.ts`): that one protects "this API → its own client" against duplicate order/payment creation from a retried HTTP request. This one protects "this API → the payment provider" against a duplicate *charge* from an internal retry.

## Alternatives considered

- **No provider-side key, just don't retry on error** — the safest option, but means every transient network blip becomes a permanent payment failure the user has to notice and manually retry, and doesn't fix the actual danger case: this API retrying via `PaymentsService.pay()` being called again (a legitimate user action, not a bug) after a first attempt's outcome was lost.
- **Local "did we already try this" bookkeeping** (e.g. a flag set before calling the provider, checked before calling again) — doesn't help if the flag itself is what's ambiguous after a crash (was it set before or after the network call actually landed?), and duplicates state the provider already tracks better than this API can.
- **Rely on `PaymentAttempt` rows alone to detect a retry** — `PaymentAttempt` is an audit trail (see [004](004-payment-reconciliation.md)), not a safety mechanism; it records what happened, it doesn't prevent the provider from double-charging.

## Decision

`Payment.providerIdempotencyKey` is generated once, at order creation (`OrdersService.checkout()`), and reused on every charge attempt for that payment — the same value on the original `pay()` call, any retry via `pay()` after a decline, and `PaymentReconciliationService`'s `checkStatus()` call:

```ts
result = await withTimeout(
  this.provider.charge(order.total, order.id, payment.providerIdempotencyKey),
  PROVIDER_TIMEOUT_MS,
  ...
);
```

Stripe (and most real payment providers) accept an idempotency key per request: a repeated request with the same key returns the *original* request's result instead of processing a new charge, as long as the key, amount, and other parameters match. This is why `PaymentReconciliationService.reconcileOne()` can safely call `provider.checkStatus()` — for a real provider, that's a `charge()` call with the *same* key, which Stripe recognizes as "you're asking about the request you already made," not "please charge this again."

## Consequences

- **What it guarantees**: a retried charge attempt (whether via the user calling `pay()` again, or reconciliation asking "what happened to this") never captures the card twice — the provider's own idempotency layer is the actual safety net, this API just has to consistently reuse the key.
- **What it doesn't guarantee**: idempotency keys aren't permanent — Stripe expires them after 24 hours. A payment stuck long enough that reconciliation asks about it a day later would get treated as a brand-new charge instead of a status check. `PaymentReconciliationService`'s default staleness window (5 minutes) is far inside that, so this isn't a problem in practice, but it's a real edge of the guarantee worth naming rather than assuming away.
- **`FakePaymentProvider` doesn't model any of this** — it always approves, and its own "idempotency" is a simple in-memory `Map` keyed by the same field, present only so `checkStatus()` has something to look up. That's enough to prove the *shape* of the interaction in tests, not to prove Stripe's actual idempotency semantics — those are trusted, not tested, in this codebase.
