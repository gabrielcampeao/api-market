# Security Policy

This repository treats security as an operational practice, not just a code review topic.

## Scope

The main risks documented for this project are:

- credential stuffing
- broken object authorization (BOLA / IDOR)
- replay of mutating requests
- double payment
- secret leakage
- webhook forgery
- dependency compromise

See [docs/threat-model.md](docs/threat-model.md) for the full threat model and mitigations.

## What to do if a secret leaks

1. Rotate the exposed secret immediately.
2. Invalidate any credentials or tokens derived from it.
3. Check whether the secret reached git history, logs, CI output, or issue trackers.
4. Update the incident notes and, if needed, add a regression test or guardrail.

## Logging rules

- Do not log JWTs.
- Do not log refresh tokens.
- Do not log passwords.
- Do not log Stripe secret material.
- Do not log provider payloads that contain sensitive data.

The application redacts common secret formats in `src/logging/logging.service.ts`, but ad-hoc debug logging should still assume logs are public evidence.

## Configuration rules

- Production JWT secrets must be strong and are validated at startup.
- If `STRIPE_SECRET_KEY` is configured, `STRIPE_WEBHOOK_SECRET` must also be present.
- Missing or weak security-critical config should fail fast during boot.

## Authorization rules

- A normal user must never read or mutate another user’s orders, payments, cart, or profile data.
- Admin-only routes must remain role-protected.
- Cross-user authorization should be covered by automated tests whenever new ownership-sensitive endpoints are added.

## Operational references

- [docs/runbook.md](docs/runbook.md)
- [docs/threat-model.md](docs/threat-model.md)
- [README.md](README.md)

