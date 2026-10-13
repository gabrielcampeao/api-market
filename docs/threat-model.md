# Threat Model

This API is intentionally opinionated about a small set of realistic threats. The goal is not to claim perfect security; it's to make the remaining risk visible and to keep the mitigations concrete.

## Primary Threats

| Threat | Mitigation | Residual risk |
|---|---|---|
| Credential stuffing | Rate limiting on auth endpoints, constant-time-ish login failure path, generic forgot-password response | Password reuse remains a user behavior problem |
| Broken object authorization (BOLA / IDOR) | Per-owner checks on user-owned orders, payments, carts, and profile data; tests cover cross-user access | Admin endpoints still require role hygiene |
| Replay of mutating requests | Refresh-token rotation, Idempotency-Key support on checkout and pay, webhook deduplication | A client can still replay an old request body if it changes the key |
| Double payment | Claim-first payment state transitions, provider idempotency, reconciliation sweep, webhook settlement | Provider-side outages can still delay finality |
| Secret leakage | Startup env validation, log redaction for common token formats, no raw token logging in normal paths | A bespoke secret format can still leak if someone logs it directly |
| Webhook forgery | Stripe signature verification against raw request bytes, rawBody enabled in bootstrap | Misconfigured webhook secret still breaks delivery |
| Dependency compromise | Dependency scanning in CI, locked runtime versions, emergency patch/release process | A zero-day still needs human response |

## Operational Guardrails

- Rotate any exposed live secret immediately, even if it never reached git history.
- Keep GitHub secret scanning and push protection enabled on the repository.
- Run dependency scanning in CI with `npm audit` or an equivalent tool.
- Treat logs as hostile: never emit JWTs, refresh tokens, passwords, Stripe secrets, or provider payloads that contain sensitive data.
- Test authorization horizontally: user A must never read or mutate user B's records.
- Keep branch protection, CI checks, and release tags enabled so the repository tells a believable operational story.

### Known limitation: private repo on a free GitHub plan

Repository-level branch protection and full secret scanning require GitHub Pro
(or a public repository) on a private repo under a free personal account. This
repo stays private, so both are unavailable through the GitHub API/UI today.
Compensating controls: `npm audit` runs in CI on every push/PR (`.github/workflows/ci.yml`),
Dependabot is configured (`.github/dependabot.yml`), and merges to `main` are
done by convention (PR review) rather than a server-enforced rule. Revisit if
the repo goes public or the account upgrades to Pro.

## Evidence In This Repo

- `src/logging/logging.service.ts` redacts common secret formats before messages reach Winston.
- `src/config/env.validation.ts` rejects missing secrets and weak production JWT values at startup.
- `test/app.e2e-spec.ts` already exercises several cross-user and payment boundary checks.
- `docs/runbook.md` captures failure modes and recovery steps for production operations.
