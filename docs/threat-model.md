# Threat Model

This API deliberately narrows its focus to a handful of realistic threats. It doesn't claim perfect security — the point is keeping remaining risk visible and mitigations concrete.

## Primary threats

| Threat | Mitigation | Residual risk |
|---|---|---|
| Credential stuffing | Rate limiting on auth endpoints, constant-time-ish login failure path, generic forgot-password response | Password reuse is still a user behavior problem |
| Broken object authorization (BOLA / IDOR) | Per-owner checks on orders, payments, carts, and profile data; tests cover cross-user access | Admin endpoints still depend on role hygiene |
| Replay of mutating requests | Refresh-token rotation, Idempotency-Key support on checkout and pay, webhook deduplication | A client can still replay an old body if the key changes |
| Double payment | Claim-first payment state transitions, provider idempotency, reconciliation sweep, webhook settlement | Provider-side outages can still delay finality |
| Secret leakage | Startup env validation, log redaction for common token formats, no raw token logging on normal paths | A bespoke secret format can still leak if logged directly |
| Webhook forgery | Stripe signature verification against raw request bytes, rawBody enabled in bootstrap | A misconfigured webhook secret still breaks delivery |
| Dependency compromise | Dependency scanning in CI, locked runtime versions, emergency patch/release process | A zero-day still needs a human response |

## Operational guardrails

- Rotate any exposed live secret right away, even if it never reached git history.
- Keep GitHub secret scanning and push protection on for the repo.
- Run dependency scanning in CI (`npm audit` or equivalent).
- Treat logs as hostile: never emit JWTs, refresh tokens, passwords, Stripe secrets, or provider payloads carrying sensitive data.
- Test authorization horizontally — user A must never touch user B's records.
- Keep branch protection, CI checks, and release tags on so the repo's operational story holds up.

### Known limitation: private repo on a free GitHub plan

Branch protection and full secret scanning at the repo level require GitHub Pro
(or a public repo) when the repo is private under a free personal account.
This one stays private, so neither is available through the GitHub API/UI right
now. Compensating controls: `npm audit` runs in CI on every push/PR
(`.github/workflows/ci.yml`), Dependabot is configured
(`.github/dependabot.yml`), and merges to `main` follow convention (PR
review) rather than a server-enforced rule. Worth revisiting if the repo
goes public or the account upgrades to Pro.

## Evidence in this repo

- `src/logging/logging.service.ts` redacts common secret formats before messages reach Winston.
- `src/config/env.validation.ts` rejects missing secrets and weak production JWT values at startup.
- `test/app.e2e-spec.ts` covers several cross-user and payment boundary checks.
- `docs/runbook.md` covers failure modes and recovery steps for production operations.