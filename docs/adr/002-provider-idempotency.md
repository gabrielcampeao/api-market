# 002 — Provider-side idempotency key, separate from the client-facing one

## Context

If a charge request reaches Stripe but the response gets lost (network blip, this process crashing mid-call, a timeout), retrying naively risks double-charging the card — the first charge may well have gone through even though this API never saw a result. That's a different problem from client-facing idempotency (`Idempotency-Key` header, see `idempotency.service.ts`), which protects "this API to its own client" against duplicate order or payment creation from a retried HTTP request. This one protects "this API to the payment provider" against a duplicate charge from an internal retry.

## Alternatives considered

- **No provider-side key, just don't retry on error**: safest option on paper, but every transient network blip becomes a permanent payment failure the user has to notice and retry manually — and it doesn't touch the actual danger case, which is `PaymentsService.pay()` getting called again legitimately (not a bug) after a first attempt's outcome was lost.
- **Local "did we already try this" bookkeeping** (a flag set before calling the provider, checked before calling again): doesn't help when the flag itself is the ambiguous part after a crash — was it set before or after the network call actually landed? — and it duplicates state the provider already tracks better than this API ever could.
- **Rely on `PaymentAttempt` rows alone to catch a retry**: `PaymentAttempt` is an audit trail (see [004](004-payment-reconciliation.md)), not a safety mechanism. It records what happened; it does nothing to stop the provider from double-charging.

## Decision

`Payment.providerIdempotencyKey` gets generated once, at order creation (`OrdersService.checkout()`), and reused on every charge attempt for that payment: the same value on the original `pay()` call, any retry via `pay()` after a decline, and `PaymentReconciliationService`'s `checkStatus()` call:

```ts
result = await withTimeout(
  this.provider.charge(order.total, order.id, payment.providerIdempotencyKey),
  PROVIDER_TIMEOUT_MS,
  ...
);
```

Stripe, like most real payment providers, accepts an idempotency key per request — a repeated request with the same key returns the original request's result instead of processing a new charge, as long as key, amount, and other parameters match. That's exactly why `PaymentReconciliationService.reconcileOne()` can safely call `provider.checkStatus()`: for a real provider, that's a `charge()` call reusing the same key, which Stripe reads as "you're asking about the request you already made," not "please charge this again."

## Consequences

- **What it guarantees**: a retried charge attempt — whether from the user calling `pay()` again or reconciliation asking what happened — never captures the card twice. The provider's own idempotency layer is the real safety net; this API just has to keep reusing the key consistently.
- **What it doesn't guarantee**: idempotency keys aren't forever. Stripe expires them after 24 hours. A payment stuck long enough that reconciliation checks on it a day later would get treated as a brand-new charge instead of a status lookup. `PaymentReconciliationService`'s default staleness window (5 minutes) sits well inside that, so it's a non-issue in practice — but it's a real edge of the guarantee worth naming rather than assuming away.
- **`FakePaymentProvider` doesn't model any of this**: it always approves, and its "idempotency" is just an in-memory `Map` keyed by the same field, there only so `checkStatus()` has something to look up. Good enough to prove the shape of the interaction in tests, not to prove Stripe's actual idempotency semantics — those are trusted here, not tested.
