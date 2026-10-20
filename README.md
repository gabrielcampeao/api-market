# Marketplace API

REST + GraphQL marketplace backend (NestJS, PostgreSQL, Prisma, Redis) — users, catalog, cart, checkout, real Stripe payments with a webhook + polling-reconciliation recovery path, Prometheus metrics, and Grafana alerting. Built as a vehicle to work through the concurrency and consistency problems that show up in any e-commerce backend: double-spending a payment, overselling stock, replaying a mutating request, reusing a refresh token, and settling a payment exactly once no matter which of three different paths (the original request, a webhook, or a reconciliation sweep) gets there first.

Deployed via a self-hosted CI/CD pipeline — see [Deployment](#deployment). Design decisions with real trade-offs are written up as short ADRs in [`docs/adr/`](docs/adr/).

Security policy, threat model, and operational guardrails live in [SECURITY.md](SECURITY.md) and [docs/threat-model.md](docs/threat-model.md).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ |
| Framework | NestJS 11 |
| ORM | Prisma 6 |
| Database | PostgreSQL 16 |
| Cache/rate-limit storage | Redis 7 (falls back to in-memory if unreachable) |
| Auth | JWT (access + refresh), Passport |
| API | REST (Swagger/OpenAPI) + GraphQL (Apollo) |
| Validation | class-validator + class-transformer |
| Logging | Winston + a DB-backed audit log |
| Payments | Stripe (falls back to an in-process fake provider if unconfigured) |
| Observability | Prometheus (`prom-client`) + Grafana (dashboard + alert rules, both provisioned as code) |
| Testing | Jest (unit) + Supertest (e2e against a real Postgres) |
| CI/CD | GitHub Actions, self-hosted runner (see [Deployment](#deployment)) |
| Container | Multi-stage Dockerfile + Docker Compose |

---

## Architecture

```
src/
├── auth/          # register, login, refresh rotation, password reset
├── users/         # profile, admin user management
├── products/      # catalog CRUD, stock
├── cart/          # per-user cart
├── orders/        # checkout, status transitions, cancel
├── payments/      # payment state machine, Stripe/fake providers, reconciliation
├── webhooks/      # Stripe webhook receiver — signature verification, dedup, settlement
├── metrics/       # Prometheus counters/histograms/gauges + GET /metrics
├── idempotency/   # Idempotency-Key interceptor for checkout/pay
├── logging/       # Winston + AuditLogService (DB)
├── mail/          # logs emails to console — no real provider wired up yet
├── redis/         # global ioredis client
├── prisma/        # global PrismaService
├── config/        # typed AppConfigService (env validation)
├── graphql/       # GraphQL resolvers mirroring a subset of the REST API
└── common/        # guards, decorators, filters, mappers, middleware
```

### Module Graph

```
AppModule
├── PrismaModule (global)
├── RedisModule (global)
├── LoggingModule (global)
├── MailModule (global)
├── MetricsModule (global) — also registers the HTTP metrics interceptor
├── IdempotencyModule (global)
├── ThrottlerModule (global, Redis-backed with in-memory fallback)
├── AuthModule      → Prisma, JwtService, Mail, AuditLog
├── UsersModule     → Prisma, AuditLog
├── ProductsModule  → Prisma, AuditLog
├── CartModule      → Prisma, AuditLog
├── OrdersModule    → Prisma, AuditLog, Mail, PAYMENT_PROVIDER
├── PaymentsModule  → Prisma, AuditLog, Metrics, PAYMENT_PROVIDER (DI token → Stripe or Fake, chosen by whether STRIPE_SECRET_KEY is set)
├── WebhooksModule  → Prisma, AuditLog, Metrics, AppConfig
└── LogsModule      # admin audit log queries
```

---

## Data Model

```
User ──< RefreshToken
User ──< PasswordResetToken
User ──< CartItem ──> Product
User ──< Order ──< OrderItem ──> Product
Order ──< Payment (1:1) ──< PaymentAttempt
User ──< AuditLog
IdempotencyKey (standalone, TTL-based)
WebhookEvent (standalone, unique on (provider, eventId))
```

**Enums:** `Role` (USER, ADMIN) · `OrderStatus` (PENDING → PAID → SHIPPED → DELIVERED, PENDING/PAID → CANCELLED) · `PaymentStatus` (PENDING, PROCESSING, APPROVED, FAILED, REFUNDED) · `PaymentAttemptStatus` (PENDING, APPROVED, DECLINED, ERROR)

Both `OrderStatus` and `PaymentStatus` transitions are centralized in `src/orders/order-status.transitions.ts` and `src/payments/payment-status.transitions.ts` — a single adjacency-list table per status type, instead of the transition legality being re-derived at each call site. See [ADR 001](docs/adr/001-payment-concurrency.md).

---

## Authentication

```
Register / Login → { accessToken, refreshToken }
Refresh          → new pair; old refresh token revoked atomically (reuse is rejected)
Logout           → refresh token revoked
```

| Token | TTL | Revocation |
|-------|-----|------------|
| Access | 15 min | expires naturally |
| Refresh | 7 days | rotated on every use; all of a user's tokens revoked on password change |
| Password reset | 1 hour | single-use, marked atomically |

---

## Concurrency Problems and How They're Handled

Races that are easy to get wrong with a naive read-then-write, and the atomic-update pattern used instead. All of these have e2e tests that actually fire concurrent requests (not mocks) and assert the outcome, including versions with 50-100 concurrent requests for the payment and checkout races.

### 1. Refresh token reuse

Two requests refresh with the same token — only one should succeed, and the response has to tell an attacker's replay apart from a legitimate double-click.

```ts
const revoked = await tx.refreshToken.updateMany({
  where: { id: record.id, revokedAt: null },
  data: { revokedAt: new Date() },
});
if (revoked.count === 0) {
  throw new UnauthorizedException('Refresh token has already been used');
}
```

### 2. Payment claim (state machine, not a lock flag)

Two requests try to pay the same order. The claim is a conditional status transition — `PENDING`/`FAILED` → `PROCESSING` — not a sentinel value stashed in a field that means something else:

```ts
const claimed = await this.prisma.payment.updateMany({
  where: { id: payment.id, status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] } },
  data: { status: PaymentStatus.PROCESSING, processingAt: new Date() },
});
if (claimed.count !== 1) {
  throw new ConflictException('This payment is already being processed or has been settled');
}
```

`FAILED` is claimable so a declined payment can be retried, reusing the same provider idempotency key (see [ADR 002](docs/adr/002-provider-idempotency.md)). `providerRef` holds only what the gateway returns. A crash between this claim succeeding and the follow-up transaction committing is a real gap this mechanism alone doesn't close — that's what `PaymentReconciliationService` and the Stripe webhook both exist to recover from (§5 below, [ADR 004](docs/adr/004-payment-reconciliation.md)).

### 3. Order cancel vs. payment confirmation

```ts
const changed = await tx.order.updateMany({
  where: { id: orderId, status: OrderStatus.PENDING },
  data: { status: OrderStatus.CANCELLED },
});
if (changed.count === 0) {
  throw new BadRequestException('Order status has changed — cannot cancel');
}
```

If a payment confirms in the same instant a cancel is requested, whichever `updateMany` lands second sees `count === 0` and backs off — the payment side reverses the charge to `REFUNDED` instead of silently overwriting the cancellation.

### 4. Checkout overselling

```ts
const result = await tx.product.updateMany({
  where: { id: line.product.id, stock: { gte: line.quantity } },
  data: { stock: { decrement: line.quantity } },
});
if (result.count === 0) {
  throw new BadRequestException('Insufficient stock');
}
```

Stock also has a DB-level `CHECK (stock >= 0)` as a second line of defense in case this application logic is ever bypassed (a bug, a manual `UPDATE`).

### 5. Settling a payment exactly once, from three different callers

A payment can be settled by three independent paths: the original synchronous `pay()` request, an async Stripe webhook delivery, or `PaymentReconciliationService`'s polling sweep — any two of which can race each other (a slow webhook delivery arriving just as reconciliation polls the same stuck payment, say). All three share the same discipline: claim the payment first, atomically, before touching the order or the attempt history at all —

```ts
const claim = await tx.payment.updateMany({
  where: { id: payment.id, status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] } },
  data: { status: PaymentStatus.APPROVED, ... },
});
if (claim.count === 0) {
  return; // someone else already settled this — not an error, just not our win
}
// only now touch the order, the attempt row, and the audit log
```

Getting this ordering wrong was a real bug, twice — the order update used to run *before* checking whether the payment claim itself succeeded, in both `PaymentReconciliationService` and `StripeWebhookService`. A losing run could flip the order to `PAID` while its own payment write matched zero rows, leaving `order.status = PAID` and `payment.status = FAILED` — an inconsistent pair no single read would catch. Fixed by reordering to claim-first in both places; see the e2e test that fires the webhook and reconciliation at the same stuck payment simultaneously and asserts (via the actual audit log row count, not just the final status) that exactly one of them logged an approval. Details in [ADR 004](docs/adr/004-payment-reconciliation.md).

---

## Idempotency

`POST /orders/checkout` and `POST /orders/:id/pay` accept an `Idempotency-Key` header, scoped per user + route.

```
new key                     → row inserted (statusCode 0 = "in flight") → handler runs → row updated with the real result
same key, same body         → cached response returned, handler doesn't run
same key, different body    → 409 (rejected — this is a client bug or a replay, not a legitimate retry)
same key, concurrent retry  → the loser polls (100ms) until the winner's row settles, then returns its result
```

The "same body" check is a SHA-256 of the (key-sorted) request body — see the code comment in `idempotency.service.ts` for why sorted, not raw, `JSON.stringify`.

---

## Payments, Webhooks, and Recovery

**Provider selection** is automatic: `PaymentsModule`'s factory picks `StripePaymentProvider` if `STRIPE_SECRET_KEY` is set, `FakePaymentProvider` otherwise — the app boots and works either way, same pattern as Redis-backed rate limiting falling back to in-memory.

**`PaymentAttempt`** is a per-attempt audit trail, separate from `Payment.status` (the logical "is this order paid" state): a retried payment used to silently overwrite the same row, losing the record of earlier declines or timeouts. Now every provider call — the original attempt, a retry, or reconciliation resolving a stuck one — gets its own `PaymentAttempt` row with its own outcome.

**Stripe webhook** (`POST /webhooks/stripe`): signature-verified against the raw request body (`main.ts` enables `rawBody: true` specifically so the JSON body parser doesn't re-serialize and break byte-for-byte signature verification). Every event is persisted to `WebhookEvent` before processing — a unique constraint on `(provider, eventId)` is what actually makes duplicate delivery (including 20 concurrent deliveries of the same event, tested in `stripe-webhook.service.spec.ts` and e2e) a safe no-op rather than a race. Correlates a `PaymentIntent` to a local `Payment` via `metadata.orderId`, not `providerRef` — `providerRef` is only known once a charge already succeeded locally, so it can't identify which order a webhook is about if the process crashed before ever recording that charge. Details in [ADR 003](docs/adr/003-webhook-deduplication.md).

**Reconciliation** (`PaymentReconciliationService`, cron every 5 minutes + `POST /payments/reconcile` for admin-triggered on-demand runs): recovers a payment stuck `PROCESSING` by asking the provider directly what actually happened, rather than guessing from local state. Concurrency-safe against overlapping runs (an in-process guard prevents the cron and an admin trigger from running at once on the same instance; a claim-first atomic write is the cross-instance guard) and against racing the webhook handler for the same payment. Details in [ADR 004](docs/adr/004-payment-reconciliation.md).

**Does this guarantee exactly-once payment processing end to end?** Not exactly — and that qualifier matters. What's actually guaranteed: this API never calls the provider twice for the same logical charge attempt (the idempotency key, [ADR 002](docs/adr/002-provider-idempotency.md)), and never records a settlement twice locally no matter which of the three paths above gets there first ([ADR 001](docs/adr/001-payment-concurrency.md)). What depends on Stripe: whether Stripe itself ever double-charges a card is Stripe's idempotency guarantee, not this API's — trusted, not independently verifiable from here. What's a known, bounded gap: idempotency keys expire after 24 hours on Stripe's side; a payment stuck far longer than reconciliation's staleness window (5 minutes by default) before ever being checked would, in principle, be treated as a new charge rather than a status check — in practice never reached, since reconciliation runs every 5 minutes.

---

## Security Operations

The security posture of this repo is documented in [docs/threat-model.md](docs/threat-model.md). It captures the practical threats we care about most: credential stuffing, BOLA/IDOR, replay, double payment, secret leakage, webhook forgery, and dependency compromise.

Operationally, the important behaviors are already enforced or documented in code:

- Secrets are validated at startup in `src/config/env.validation.ts`.
- Common secret formats are redacted in `src/logging/logging.service.ts` before they reach Winston.
- Cross-user authorization and payment boundary checks are covered in `test/app.e2e-spec.ts`.
- Recovery procedures and alert responses live in `docs/runbook.md`.

## Observability

**Metrics** (`GET /metrics`, Prometheus text format, public like the health endpoints since Prometheus doesn't send a bearer token): `http_requests_total`/`http_request_duration_seconds` (via a global interceptor, labeled by matched route pattern, not the raw URL, to avoid unbounded cardinality from path parameters), `payment_attempt/approved/failed_total`, `payment_reconciliation_total`, `stuck_payments_total` (a gauge — live count, not a running total), `stripe_request_duration_seconds`/`stripe_errors_total`, `webhook_received/duplicate/invalid_signature_total`, and `dependency_up{dependency}` (Postgres/Redis, checked every 30s — Prometheus's own `up` metric only tells you the *process* is reachable, not whether a dependency behind it is down).

**Alerting**: 7 rules provisioned in Grafana (`observability/grafana/provisioning/alerting/`) — API/Postgres/Redis down, elevated 5xx rate, high payment failure rate, payments stuck PROCESSING >10min, high Stripe latency. Routed to an email contact point (Mailtrap SMTP) — the full fire → metric change → alert → email → recovery → resolve email cycle has been verified end to end. See [`docs/runbook.md`](docs/runbook.md) for SLOs and per-alert response steps.

**Dashboard**: one Grafana dashboard (`observability/grafana/provisioning/dashboards/`), auto-provisioned, covering the metrics above. Neither Prometheus nor Grafana is exposed publicly or through the deployment's tunnel — see [Deployment](#deployment).

---

## Deployment

Self-hosted, not a managed platform — Render/Koyeb/Northflank all require a card on file even for their free tiers; this runs on a GitHub Actions **self-hosted runner** on the deploying machine instead.

```
push → CI (lint, typecheck, build, unit + e2e, merged coverage check)
     → deploy job: snapshot current image as a rollback tag
     → docker compose up -d --build api
     → poll GET /api/health/ready for up to 5 minutes
     → roll back to the snapshot if it never turns green
```

Public access is a `cloudflared` Quick Tunnel sidecar (free, no account) — the trade-off is the URL changes if that container restarts. Prometheus and Grafana run alongside the API but aren't exposed through the tunnel or a public port (Grafana is bound to `127.0.0.1`, reachable over an SSH port-forward).

Load-tested against the live deployment with a custom runner (checkout/pay need fresh per-request state a generic tool can't set up) — real numbers and `EXPLAIN ANALYZE` findings in [`docs/load-testing.md`](docs/load-testing.md).

---

## Running the API

### Prerequisites
- Node.js 20+
- Docker & Docker Compose, or a local PostgreSQL 16 + Redis 7

### Quick start

```bash
cp .env.example .env
npm install
docker compose up -d postgres redis
npx prisma migrate deploy
npm run db:seed
npm run start:dev
```

### Full stack in Docker

```bash
docker compose up --build
# API:     http://localhost:3000
# Swagger: http://localhost:3000/docs
```

### Environment variables

See `.env.example`. In production, `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` must be ≥32 characters and not start with `change-me` — enforced at startup, not just documented.

### Health probes

`GET /health/live` (process is up) and `GET /health/ready` (checks Postgres via `SELECT 1` and Redis via `PING`) — for container orchestrators, not humans.

---

## Testing

```bash
npm test          # unit (105 tests)
npm run test:cov  # unit with coverage
npm run test:e2e  # e2e (60 tests) — needs a reachable Postgres + Redis, skips itself otherwise
```

E2E runs the full flow (register → catalog → cart → checkout → pay → admin) against a real Postgres, plus a `Concurrency` block that fires actual parallel HTTP requests:

| Race | Concurrency | Expected outcome |
|------|-------------|-------------------|
| Payment claim, same order | 2 and 50 | exactly one `201`, the rest `409` |
| Order cancel, same order | 2 | one `200`, one `400`; stock restored once, not twice |
| Refresh token reuse | 2 | one `200`, one `401` |
| Checkout stock race | 2 and 50 | exactly one `201`, the rest `400`; stock never negative |
| Webhook vs. reconciliation, same stuck payment | 2 (fired concurrently) | exactly one approval recorded (`AuditLog`), regardless of which one wins |

The 50-way tests provision their fixture users directly through Prisma + a signed JWT instead of `/auth/register` + `/auth/login` — doing that for real would trip the login throttle (20/min), which is a different thing being tested.

---

## Limitations

Things that are known gaps rather than oversights:

- **The public URL changes on restart.** The `cloudflared` Quick Tunnel is free and needs no account, but it doesn't get a stable hostname — a container restart means a new URL.
- **Single instance in steady state, no failover.** The self-hosted runner deploys one `api` container; there's no load balancer or standing second instance, so a host outage is a real outage, not a failover. What *is* verified: the app's own correctness guarantees (payment claim, webhook dedup, reconciliation) don't depend on being single-instance — `scripts/multi-instance-test.js` runs a second API instance against the same Postgres/Redis and confirms the DB-level CAS and unique constraints, not in-process memory, are what actually prevent double-processing. See `docker-compose.multi-instance-test.yml`.
- **Stripe idempotency keys expire after 24 hours.** A payment stuck `PROCESSING` far longer than reconciliation's staleness window before ever being checked would, in principle, get treated as a new charge instead of a status check. Reconciliation runs every 5 minutes by default, so this isn't reached in practice — see [ADR 002](docs/adr/002-provider-idempotency.md).
- **Idempotency uses a 100ms poll**, not a DB wait/notify. Fine at this scale, wouldn't scale to heavy concurrent traffic on one key.
- **No account lockout / brute-force backoff** beyond the generic IP-based throttle on `/auth/*`.
- **`Product.name` search does a sequential scan.** It's a `contains` query; a plain B-tree index can't serve that, and a trigram index wasn't worth adding for a catalog this size — measured, not assumed, see [`docs/load-testing.md`](docs/load-testing.md).
- **The `CHECK` constraints in `prisma/migrations/` are hand-written SQL** — Prisma's schema language has no constraint primitive for them, so `prisma db pull` / drift detection won't see them.
- **Residual load-test data.** The production DB was seeded with synthetic products for load testing and `EXPLAIN ANALYZE`; the load-test-only rows are cleaned up, but real orders placed by the load test itself against a "Load Test Product" remain (deactivated, not deleted, to keep the order history intact — see `docs/load-testing.md`).

### Evaluated and deliberately not built

- **Outbox pattern.** Outbox earns its keep when a DB transaction commits and an external effect *must* eventually happen even if the process crashes right after. The one external effect here — the order confirmation email in `OrdersService.checkout` — already runs *after* the transaction commits, not inside it, and losing it isn't something a user can't recover from (the order still exists). What Outbox would protect against wasn't actually present. The actual crash-window gap (charge succeeds, local write is lost) is closed by the webhook and polling reconciliation instead — see [ADR 004](docs/adr/004-payment-reconciliation.md) for why that fits better than Outbox here.
- **Kafka / Kubernetes / CQRS / Event Sourcing.** None of these solve a problem this project actually has; adding them would be infrastructure theater for a portfolio piece, not a response to a real constraint.

---

## Engineering Decisions

Only the decisions that weren't the obvious/default choice. The four payment/webhook decisions are written up in full as ADRs, since they're the ones with the most subtle trade-offs:

- [001 — Payment concurrency via atomic `updateMany`, not a lock](docs/adr/001-payment-concurrency.md)
- [002 — Provider-side idempotency key, separate from the client-facing one](docs/adr/002-provider-idempotency.md)
- [003 — Webhook deduplication via a persisted event row and a unique constraint](docs/adr/003-webhook-deduplication.md)
- [004 — Polling reconciliation instead of an Outbox pattern](docs/adr/004-payment-reconciliation.md)

### Refresh token rotation

**Problem:** a stolen refresh token is valid for 7 days unless something detects the theft.
**Decision:** every refresh both issues a new token and revokes the old one atomically. A replayed old token fails with a distinct error instead of silently succeeding.
**Trade-off:** doesn't itself alert anyone — it just makes a specific replay pattern detectable in logs; nothing currently consumes that signal.

### Idempotency-Key scoped by user + route + request hash

**Problem:** a client retrying a POST after a timeout shouldn't create two orders; a client accidentally reusing a key for a different request shouldn't silently get the wrong cached response back.
**Decision:** the key is namespaced by `(userId, route)` so it can't replay another user's response, and a hash of the request body is stored alongside it so a payload mismatch is rejected instead of served from cache.
**Trade-off:** the hash only covers the body — see Limitations for the poll-based wait, which is the other trade-off here.

---

## Security

- JWT secrets validated at startup (≥32 chars, can't start with `change-me`, in production)
- Login/register don't leak whether an email exists (constant-time-ish dummy hash on unknown email, uniform forgot-password message)
- Password reset tokens are single-use, marked atomically
- All sessions revoked on password change
- Helmet, CORS with explicit origins, rate limiting (IP-based, default + stricter `auth` bucket)
- `ValidationPipe` with `whitelist`/`forbidNonWhitelisted` — DTOs can't be used for mass assignment
- Admin routes gated by a `Roles` guard
- Known gap: no per-account lockout beyond the IP throttle (see Limitations)

---

## Project Structure

```
├── .github/workflows/ci.yml
├── docs/
│   ├── adr/                    # 001-004, one decision per file
│   └── load-testing.md
├── observability/
│   ├── prometheus/prometheus.yml
│   └── grafana/provisioning/   # datasources, dashboards, alert rules — all as code
├── scripts/
│   └── load-test.js
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts
│   └── migrations/
├── src/
│   ├── metrics/
│   └── webhooks/
├── test/
│   ├── jest-unit.json
│   ├── jest-e2e.json
│   ├── app.e2e-spec.ts
│   └── global-setup.js         # skips e2e if Postgres isn't reachable
├── Dockerfile
├── docker-compose.yml
├── docker-compose.prod.yml
└── .env.example
```
