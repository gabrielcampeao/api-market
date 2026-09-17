# Marketplace API

A marketplace backend built with **NestJS, PostgreSQL, Prisma and Redis**, covering the usual flows: users, products, cart, checkout, orders, payments.

Most of the work here went into parts that are easy to get wrong:

* concurrent payment requests
* stock races during checkout
* request retries
* refresh token reuse
* Stripe webhook duplication
* partial failures between Stripe and the local database
* recovery of payments stuck in processing
* dependency failures
* deployment and rollback

The API exposes both **REST** and **GraphQL**. Payments run through **Stripe** when configured, and fall back to a fake provider for local development.

Also included:

* Prometheus metrics
* Grafana dashboards
* email alerts
* CI/CD
* automatic rollback
* health checks
* load testing
* backup and restore drills
* multi-instance concurrency tests
* documented architecture decisions

More detailed technical decisions live in [`docs/adr/`](docs/adr/). Security notes and known risks are documented in [`SECURITY.md`](SECURITY.md) and [`docs/threat-model.md`](docs/threat-model.md).

## Tech stack

| Area           | Technology                          |
| -------------- | ------------------------------------ |
| Runtime        | Node.js 20+                         |
| Framework      | NestJS 11                           |
| Database       | PostgreSQL 16                       |
| ORM            | Prisma 6                            |
| Redis          | Redis 7                             |
| Authentication | JWT + Passport                      |
| APIs           | REST + GraphQL                      |
| Validation     | class-validator + class-transformer |
| Payments       | Stripe                              |
| Logging        | Winston + database audit log        |
| Metrics        | Prometheus                          |
| Dashboards     | Grafana                             |
| Alerts         | Grafana Alerting + email            |
| Tests          | Jest + Supertest                    |
| CI/CD          | GitHub Actions                      |
| Containers     | Docker + Docker Compose             |

## Architecture

```text
src/
├── auth/
├── users/
├── products/
├── cart/
├── orders/
├── payments/
├── webhooks/
├── metrics/
├── idempotency/
├── logging/
├── mail/
├── redis/
├── prisma/
├── config/
├── graphql/
└── common/
```

### Responsibilities

| Module         | Responsibility                                                 |
| -------------- | ---------------------------------------------------------------- |
| `auth/`        | Registration, login, refresh token rotation and password reset |
| `users/`       | Profile and admin user management                              |
| `products/`    | Catalog and stock                                               |
| `cart/`        | Per-user shopping cart                                          |
| `orders/`      | Checkout, cancellation and order state changes                  |
| `payments/`    | Payment state, Stripe integration and reconciliation             |
| `webhooks/`    | Stripe webhook processing                                       |
| `metrics/`     | Prometheus metrics                                               |
| `idempotency/` | Idempotency-Key handling                                         |
| `logging/`     | HTTP logs and audit logs                                         |
| `graphql/`     | GraphQL entry points                                             |
| `common/`      | Guards, decorators, filters, mappers and middleware              |

REST controllers and GraphQL resolvers share the same business services, so the rules underneath never get duplicated between the two APIs.

## Data model

Main relationships:

```text
User
├── RefreshToken[]
├── PasswordResetToken[]
├── CartItem[]
└── Order[]
    ├── OrderItem[]
    └── Payment
        └── PaymentAttempt[]
```

Other important records:

```text
AuditLog
IdempotencyKey
WebhookEvent
```

### Payment states

```text
PENDING
PROCESSING
APPROVED
FAILED
REFUNDED
```

Payment and order transitions live in one centralized place rather than being scattered across services. That's what makes an invalid transition easy to catch and hard to accidentally allow:

```text
APPROVED -> PROCESSING
REFUNDED -> APPROVED
```

## Authentication

Login and registration return an access token and a refresh token.

| Token                |   Lifetime |
| --------------------- | ---------: |
| Access token         | 15 minutes |
| Refresh token        |     7 days |
| Password reset token |     1 hour |

Refresh tokens are opaque and stored hashed in PostgreSQL. Every successful refresh revokes the previous token and hands back a new pair, and the revocation runs as a conditional database update rather than a plain write:

```ts
const revoked = await tx.refreshToken.updateMany({
  where: {
    id: record.id,
    revokedAt: null,
  },
  data: {
    revokedAt: new Date(),
  },
});

if (revoked.count === 0) {
  throw new UnauthorizedException(
    'Refresh token has already been used',
  );
}
```

This avoids the read-then-write race where two requests try to consume the same refresh token at once.

# Concurrency

Most of the interesting bugs here traced back to flows that read state first and changed it later, a pattern that looks harmless but isn't:

```text
READ
CHECK
UPDATE
```

Another request can slip in and modify the record between the read and the update. For anything critical, the condition now lives directly inside the database update.

## Payment claim

Before calling the payment provider, a payment has to move from:

```text
PENDING -> PROCESSING
```

That transition gets claimed atomically:

```ts
const claimed = await this.prisma.payment.updateMany({
  where: {
    id: payment.id,
    status: {
      in: [
        PaymentStatus.PENDING,
        PaymentStatus.FAILED,
      ],
    },
  },
  data: {
    status: PaymentStatus.PROCESSING,
    processingAt: new Date(),
  },
});

if (claimed.count !== 1) {
  throw new ConflictException(
    'This payment is already being processed or has been settled',
  );
}
```

Only one concurrent request can match the expected state; the rest get a conflict back instead of hitting the provider again.

An earlier version used `providerRef = "__claiming__"` as a makeshift lock. It worked, but it pushed two responsibilities onto one field. `providerRef` is supposed to hold the identifier the payment provider hands back, nothing else. The explicit `PROCESSING` state says what's actually happening and is far easier to recover from later.

## Checkout stock race

Stock updates use the same conditional pattern:

```ts
const result = await tx.product.updateMany({
  where: {
    id: product.id,
    stock: {
      gte: quantity,
    },
  },
  data: {
    stock: {
      decrement: quantity,
    },
  },
});
```

If a competing checkout grabs the remaining stock first, `count` comes back `0` and the second checkout fails cleanly. PostgreSQL also enforces a database-level constraint against negative stock as a second line of defense in case the application logic is ever bypassed.

## Order cancellation vs payment

Cancellation follows the same pattern, based on the order's current state:

```ts
const changed = await tx.order.updateMany({
  where: {
    id: orderId,
    status: OrderStatus.PENDING,
  },
  data: {
    status: OrderStatus.CANCELLED,
  },
});
```

If another request already changed the order, this update simply stops matching, which keeps two independent operations from silently stepping on each other.

# Payment settlement

A payment can get confirmed through three paths:

```text
Original pay request
Stripe webhook
Reconciliation job
```

Any two of these can run at the same time, so the rule has to be simple: claim the payment first, then update everything downstream.

```text
Claim the payment first
Then update related state
```

That ordering matters more than it looks. An earlier version updated the order before confirming the payment claim had succeeded, which could leave inconsistent state: `order = PAID` while `payment = FAILED`. The payment claim is now the very first mutation. Only whichever request wins that claim goes on to update the order, `PaymentAttempt`, audit logs, and metrics.

There's an e2e test that fires webhook processing and reconciliation against the same payment simultaneously, checking both the final state and the audit records to confirm exactly one path recorded the approval.

# Idempotency

Checkout and payment support an `Idempotency-Key` header:

```http
Idempotency-Key: <value>
```

The key is scoped by user, route, and request payload together. Behavior breaks down like this:

| Situation                 | Result                                           |
| -------------------------- | -------------------------------------------------- |
| New key                   | Request executes and response is stored          |
| Same key + same body      | Cached response is returned                      |
| Same key + different body | `409 Conflict`                                   |
| Same key concurrently     | One request runs, the other waits for its result |

The request body gets hashed with SHA-256, with object keys sorted before hashing, so these two payloads are treated as equivalent:

```json
{
  "a": 1,
  "b": 2
}
```

```json
{
  "b": 2,
  "a": 1
}
```

Concurrent requests sharing the same key currently wait on a short polling interval for the first request to finish. That's fine for this project's scale, though it's documented as something that would need rethinking under heavy contention on a single key.

# Stripe payments

When `STRIPE_SECRET_KEY` is configured, the app talks to Stripe. Without it, local development falls back to the fake provider:

```text
PaymentsService
      |
      v
PAYMENT_PROVIDER
      |
      +--> StripePaymentProvider
      |
      +--> FakePaymentProvider
```

This abstraction earns its place because there really are two implementations behind it; similar abstractions elsewhere got removed once they stopped pulling their weight.

## Payment attempts

`Payment` represents the logical payment; `PaymentAttempt` represents each individual interaction with the provider. For example:

```text
Payment
status = APPROVED

Attempt 1
DECLINED

Attempt 2
ERROR

Attempt 3
APPROVED
```

Before `PaymentAttempt` existed, retries just overwrote information on the same payment record. Keeping attempts as separate rows makes failures and retries much easier to reconstruct after the fact.

## Provider idempotency

Client idempotency protects the `Client -> API` leg. It does nothing for `API -> Stripe`. For that, Stripe gets its own idempotency key for the logical payment, created once and reused across retries, which matters in a failure sequence like:

```text
API sends payment request

Stripe processes it

response is lost

API retries
```

Without provider-side idempotency, that retry could produce a second charge.

# Stripe webhooks

Stripe sends events to `POST /webhooks/stripe`. The request signature is verified against the raw HTTP body, which is why NestJS is configured with:

```ts
rawBody: true
```

Parsing and re-serializing the body changes the exact bytes Stripe used to compute the signature, a real bug that turned up while testing the webhook integration.

## Webhook deduplication

Every received Stripe event gets persisted with its `provider` and `eventId`, and the database enforces a unique constraint on that pair. The first implementation checked whether the event existed and then created it, a TOCTOU race where multiple webhook requests could all observe "event does not exist" before any had inserted a row. Concurrent tests exposed exactly that. The unique constraint is now the actual deduplication boundary: one request wins, and the rest become safe duplicates.

## Webhook correlation

The first implementation tried to find the local payment via `providerRef`, which breaks in a scenario like this:

```text
Stripe approves the payment

API crashes before providerRef is stored

Stripe sends the webhook
```

Stripe knows about the payment, but the local database has no idea what its Stripe reference is. The Stripe object now carries `metadata.orderId`, and the webhook uses that to reconnect the external payment back to the local order.

# Reconciliation

Webhooks aren't the only recovery path. A reconciliation job runs every five minutes, looking for payments stuck in `PROCESSING`. Rather than guess what happened, it asks the provider directly:

```text
PROCESSING payment
        |
        v
Check Stripe
        |
        +--> approved
        |
        +--> failed
        |
        +--> unknown
```

There's also an admin endpoint for manual reconciliation. An in-memory `isRunning` guard keeps the cron and the manual trigger from overlapping within the same API process, but that guard has no reach across separate instances. Cross-instance safety comes from the atomic database claim, verified using two API instances sharing the same PostgreSQL and Redis.

# Exactly once?

The project doesn't claim a universal exactly-once transaction spanning PostgreSQL and Stripe. The actual guarantees are narrower: locally, a payment settles once; at the provider boundary, the same logical Stripe operation always reuses the same idempotency key; and recovery runs through the Stripe webhook plus polling reconciliation together. The practical model looks like:

```text
Local settlement protection
+
provider idempotency
+
webhook recovery
+
reconciliation
```

Stripe carries the actual guarantee that its idempotency implementation won't double-charge the same operation; this project builds on top of that, it doesn't replace it.

# Security

Covered here:

* JWT secret validation at startup
* refresh token rotation
* single-use password reset tokens
* session revocation after password changes
* Helmet
* explicit CORS origins
* DTO whitelist validation
* mass-assignment protection
* role-based admin routes
* stricter rate limiting for authentication
* Stripe webhook signature validation
* secret redaction in logs
* BOLA / IDOR e2e tests
* Dependabot
* `npm audit` in CI
* documented threat model

The full threat model lives at `docs/threat-model.md`. Known risks get documented rather than glossed over. One current gap is that authentication has no account-specific lockout or exponential backoff beyond IP-based rate limiting.

# Observability

Prometheus scrapes `GET /metrics`. Collected metrics include:

```text
HTTP requests
HTTP duration

payment attempts
approved payments
failed payments

payment reconciliation
stuck payments

Stripe latency
Stripe errors

webhooks received
duplicate webhooks
invalid webhook signatures

PostgreSQL health
Redis health
```

HTTP metrics use the matched route pattern instead of the raw URL: `/orders/:id` rather than a distinct label per order ID, which keeps metric cardinality from growing out of control.

# Grafana and alerts

Grafana is provisioned entirely from files stored in the repository. The dashboard covers API health, request rate, request latency, payment results, Stripe latency, webhook activity, PostgreSQL health, and Redis health.

Alert rules cover:

* API down
* PostgreSQL down
* Redis down
* elevated HTTP 5xx rate
* elevated payment failure rate
* payments stuck in `PROCESSING`
* high Stripe latency

Alerts route through email via Mailtrap SMTP. The full cycle was tested end to end: dependency goes down, the metric changes, Grafana fires, the email arrives, the dependency recovers, Grafana resolves, and the resolved email arrives too.

# Deployment

The app deploys through a self-hosted GitHub Actions runner:

```text
push
  |
  v
CI
  |
  +--> lint
  +--> typecheck
  +--> build
  +--> unit tests
  +--> e2e tests
  |
  v
deploy
  |
  v
snapshot current image
  |
  v
build new version
  |
  v
start API
  |
  v
poll /health/ready
  |
  +--> healthy
  |
  +--> unhealthy -> rollback
```

The readiness check retries for up to five minutes. The deployment stack contains the API, PostgreSQL, Redis, Cloudflared, Prometheus, and Grafana. The public API sits behind a Cloudflare Quick Tunnel; Prometheus and Grafana stay off the public tunnel entirely.

# Multi-instance test

Production normally runs a single API instance, but a separate test environment starts a second API process against the same PostgreSQL and Redis to verify shared state between instances, payment races across instances, webhook deduplication across instances, and reconciliation overlap.

For the payment race:

```text
API A
   \
    PostgreSQL
   /
API B
```

Only one instance ever successfully claims the payment; the other gets a conflict back. The same principle carries over to webhook deduplication. This test also confirmed `isRunning` is strictly process-local; cross-instance correctness comes from PostgreSQL, not from process memory.

# Backup and restore

A backup and restore drill lives at `scripts/backup-restore-drill.sh`. The script creates a database dump, starts a clean disposable PostgreSQL instance, restores the backup into it, runs Prisma migrations, starts the real API against it, checks `/health/ready`, and compares important table counts. The restored environment is throwaway; the production database is never touched during the drill.

# Load testing

The deployed API was tested with a custom load runner, built because checkout and payment each need fresh state per flow, something a generic repeated-request tool can't set up. The test records p50, p95, p99, throughput, and errors:

```text
p50
p95
p99
throughput
errors
```

A larger product dataset was also created temporarily to test product queries with `EXPLAIN ANALYZE`. Product name search currently runs a `contains` query; a normal B-tree index didn't actually improve it, so the unused index got removed. For the current catalog size the sequential scan is fine; if product search ever becomes a bottleneck, a trigram index is the next thing to try. Details live in `docs/load-testing.md`.

# Testing

```bash
npm test
npm run test:cov
npm run test:e2e
```

Current suite: 105 unit tests, 60 e2e tests. E2E tests run against a real PostgreSQL instance, and some of the concurrency tests fire between 50 and 100 requests in parallel.

| Scenario                          | Expected behavior     |
| ----------------------------------- | ------------------------ |
| Same payment claimed concurrently | One request wins      |
| Same order cancelled concurrently | Stock restored once   |
| Same refresh token reused         | One refresh succeeds  |
| Checkout with one unit left       | One checkout succeeds |
| Webhook and reconciliation race   | One settlement wins   |
| Cross-user order access           | Rejected               |
| Cross-user cancellation           | Rejected               |
| Non-admin reconciliation          | Rejected               |

# Health checks

```text
GET /health/live
GET /health/ready
```

`live` checks whether the process is running. `ready` goes further and checks PostgreSQL and Redis too. Deployment and monitoring both rely on these endpoints.

# Running locally

## Requirements

* Node.js 20+
* Docker
* Docker Compose

## Setup

```bash
cp .env.example .env

npm install

docker compose up -d postgres redis

npx prisma migrate deploy

npm run db:seed

npm run start:dev
```

Swagger: `http://localhost:3000/docs`

# Known limitations

These are known gaps, not hidden TODOs.

## Single production instance

The normal deployment runs one API container. It's been tested with two instances, but there's no permanent load balancer or failover instance, so a host failure still means downtime.

## Cloudflare Quick Tunnel

The public deployment has no permanent hostname yet. Restarting the tunnel can change the public URL.

## Stripe idempotency lifetime

Stripe idempotency keys have a limited lifetime. Reconciliation normally happens well before that window closes, but it's still an external constraint outside the application's control.

## Idempotency waiting

Concurrent requests sharing the same `Idempotency-Key` currently wait via short polling. Fine at current scale, worth reconsidering under high contention on the same key.

## Authentication throttling

Authentication routes are protected by IP-based throttling only; there's no account-level lockout or exponential backoff yet.

## Product search

`Product.name` uses a `contains` query and runs a sequential scan today, confirmed with `EXPLAIN ANALYZE`. A trigram index was considered but isn't necessary for the current dataset size.

## Hand-written CHECK constraints

Some PostgreSQL `CHECK` constraints are defined directly in migration SQL, since Prisma doesn't expose all of these cleanly through its schema DSL.

## Load-test data

Orders created during load testing stay in the database to preserve historical foreign-key relationships. Products used only for testing get deactivated instead of deleting records that are already referenced elsewhere.

# Things I deliberately did not add

## Outbox

I considered an Outbox pattern. The main failure I actually needed to solve was Stripe succeeding while the API dies before saving the result:

```text
Stripe succeeds

API dies before saving the result
```

Webhook delivery and reconciliation solve that more directly. The order confirmation email runs after the database transaction, so losing an email never means losing the order itself. Adding a full Outbox subsystem for this use case would add more infrastructure than the problem calls for.

## Kafka, Kubernetes, CQRS, and event sourcing

None of these got added because none of them solve a constraint this project actually has. Adding infrastructure just to make the architecture look bigger would make the system harder to maintain without improving any of its guarantees. If the constraints change, these decisions are open to revisiting.

# Architecture decision records

Decisions that needed more context than a code comment could carry live in `docs/adr/`. Current ADRs:

1. Payment concurrency with atomic conditional updates
2. Provider-side idempotency
3. Stripe webhook deduplication
4. Payment reconciliation

Each follows the same small structure: Context, Alternatives, Decision, Consequences. The goal isn't documenting every implementation detail; it's keeping the reasoning behind decisions that would otherwise be easy to forget.

## Project status

Current project coverage includes:

```text
REST API
GraphQL API

Stripe sandbox payments
PaymentAttempt history

Client idempotency
Provider idempotency

Webhook signature verification
Webhook deduplication

Payment reconciliation

Concurrent payment protection
Concurrent checkout protection

Multi-instance testing

Prometheus metrics
Grafana dashboard
Email alerting

CI/CD
Automatic rollback

Backup and restore drill
Load testing

Threat model
ADRs
Runbook
SLOs
```