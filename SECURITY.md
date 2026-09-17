# Security Policy

Security here isn't a checkbox at review time — it's part of how the project runs day to day.

## Scope

Main risks this project tracks:

- credential stuffing
- broken object authorization (BOLA / IDOR)
- mutating-request replay
- double payment
- secret leakage
- webhook forgery
- dependency compromise

Full threat model and mitigations live in [docs/threat-model.md](docs/threat-model.md).

## If a secret leaks

1. Rotate it right away.
2. Invalidate anything derived from it (tokens, credentials).
3. Check git history, logs, CI output, and issue trackers for exposure.
4. Update incident notes; add a regression test or guardrail if the gap allows a repeat.

## Logging rules

- No JWTs in logs.
- No refresh tokens in logs.
- No passwords in logs.
- No Stripe secret material in logs.
- No provider payloads containing sensitive data.

`src/logging/logging.service.ts` redacts common secret formats, but treat any ad-hoc debug logging as if it will end up somewhere public.

## Configuration rules

- Production JWT secrets must be strong; this is validated at startup.
- `STRIPE_WEBHOOK_SECRET` is required whenever `STRIPE_SECRET_KEY` is set.
- Weak or missing security-critical config should fail the boot, not warn and continue.

## Authorization rules

- Users must never read or mutate another user's orders, payments, cart, or profile data.
- Admin-only routes stay role-protected.
- New ownership-sensitive endpoints need automated tests covering cross-user access.

## Related docs

- [docs/runbook.md](docs/runbook.md)
- [docs/threat-model.md](docs/threat-model.md)
- [README.md](README.md)
