# Marketplace API

Marketplace backend built with **NestJS, PostgreSQL, Prisma and Redis**.

Covers the usual flows: users, products, cart, checkout, orders, payments.

Most of the effort here went into the parts that are easy to get wrong in a backend:

* concurrent payment requests
* stock races during checkout
* request retries
* refresh token reuse
* Stripe webhook duplication
* partial failures between Stripe and the local database
* recovery of payments stuck in processing
* dependency failures
* deployment and rollback

Both **REST** and **GraphQL** are exposed.

Stripe handles payments when configured; a fake provider takes over for local development.

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

More detail on technical decisions lives in [`docs/adr/`](docs/adr/).

Security notes and known risks are documented in [`SECURITY.md`](SECURITY.md) and [`docs/threat-model.md`](docs/threat-model.md).

---

## Tech Stack

| Area           | Technology                          |
| -------------- | ----------------------------------- |
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

---

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
| `products/`    | Catalog and stock                                              |
| `cart/`        | Per-user shopping cart                                         |
| `orders/`      | Checkout, cancellation and order state changes                 |
| `payments/`    | Payment state, Stripe integration and reconciliation           |
| `webhooks/`    | Stripe webhook processing                                      |
| `metrics/`     | Prometheus metrics                                             |
| `idempotency/` | Idempotency-Key handling                                       |
| `logging/`     | HTTP logs and audit logs                                       |
| `graphql/`     | GraphQL entry points                                           |
| `common/`      | Guards, decorators, filters, mappers and middleware             |

REST controllers and GraphQL resolvers share the same business services — no duplicated rules between the two APIs.

---

## Data Model

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

Payment and order transitions live in one place instead of being reimplemented across services.

Invalid transitions, for example:

```text
APPROVED -> PROCESSING
REFUNDED -> APPROVED
```

That keeps the state rules testable and harder to bypass by accident.

---

## Authentication

Login and registration return an access token plus a refresh token.

| Token                |   Lifetime |
| -------------------- | ---------: |
| Access token         | 15 minutes |
| Refresh token        |     7 days |
| Password reset token |     1 hour |

Refresh tokens are opaque and stored hashed in PostgreSQL.

Each successful refresh revokes the previous token and issues a new pair.

Revocation relies on a conditional database update:

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

This sidesteps a read-then-write race when two requests try to reuse the same refresh token simultaneously.

---

# Concurrency

Most of the interesting bugs in this project traced back to flows that read state first and changed it later.

This pattern is unsafe:

```text
READ
CHECK
UPDATE
```

Between the read and the update, another request can slip in and modify the record.

So for critical transitions, the condition goes directly into the database update itself.

---

## Payment Claim

Before calling the payment provider, a payment has to move from:

```text
PENDING -> PROCESSING
```

That transition is claimed atomically:

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

Only one concurrent request can match the expected state; the rest get a conflict instead of hitting the provider again.

An earlier version used:

```text
providerRef = "__claiming__"
```

as a lock. It worked, but mixed two responsibilities — `providerRef` should hold the identifier the payment provider returns, nothing else. The explicit `PROCESSING` state is clearer and easier to recover from later.

---

## Checkout Stock Race

Stock updates are conditional too:

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

If another checkout grabs the remaining stock first:

```text
count = 0
```

and the second checkout fails cleanly.

PostgreSQL also enforces a database-level constraint against negative stock — a second line of defense if application logic ever gets bypassed.

---

## Order Cancellation vs Payment

Cancellation depends on current state as well:

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

If another request has already changed the order, the update simply stops matching — so two independent operations can't silently clobber each other.

---

# Payment Settlement

Three different paths can confirm a payment:

```text
Original pay request
Stripe webhook
Reconciliation job
```

Any two of them can fire at the same time.

The rule is simple:

```text
Claim the payment first
Then update related state
```

Ordering matters here. An earlier version updated the order before confirming the payment claim actually succeeded, which could leave inconsistent state like:

```text
order = PAID
payment = FAILED
```

Now the payment claim is the first mutation. Only whichever path wins the claim continues on to update:

* the order
* PaymentAttempt
* audit logs
* metrics

An e2e test fires webhook processing and reconciliation against the same payment simultaneously, then checks both final state and audit records to confirm only one path actually records the approval.

---

# Idempotency

Checkout and payment support:

```http
Idempotency-Key: <value>
```

Scoped by:

```text
user
route
request payload
```

Behavior:

| Situation                 | Result                                           |
| -------------------------- | -------------------------------------------------- |
| New key                   | Request executes and response is stored          |
| Same key + same body      | Cached response is returned                      |
| Same key + different body | `409 Conflict`                                   |
| Same key concurrently     | One request runs, the other waits for its result |

The request body is hashed with SHA-256, with object keys sorted first — so these two payloads count as equivalent:

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

Concurrent requests currently wait on a short polling interval for the first request to finish. Good enough here, but documented as something that would need rework under heavy contention on a single key.

---

# Stripe Payments

When `STRIPE_SECRET_KEY` is set, the app talks to Stripe. Without it, local development falls back to the fake provider.

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

This abstraction exists because there really are two implementations in use — similar abstractions were stripped out elsewhere when they weren't earning their keep.

---

## Payment Attempts

`Payment` is the logical payment. `PaymentAttempt` is each interaction with the provider.

Example:

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

Before `PaymentAttempt` existed, retries overwrote information on the same payment record. Keeping attempts separate makes failures and retries much easier to reconstruct afterward.

---

## Provider Idempotency

Client idempotency protects:

```text
Client -> API
```

It does not protect:

```text
API -> Stripe
```

Stripe gets its own idempotency key for the logical payment, created once and reused across retries. That matters for a failure like:

```text
API sends payment request

Stripe processes it

response is lost

API retries
```

Without provider-side idempotency, that retry could turn into a second charge.

---

# Stripe Webhooks

Stripe posts events to:

```text
POST /webhooks/stripe
```

The signature is verified against the raw HTTP body. NestJS is configured with:

```ts
rawBody: true
```

because reparsing and reserializing the body changes the exact bytes Stripe used to compute the signature — a real bug found while testing the webhook integration.

---

## Webhook Deduplication

Every Stripe event received gets persisted with:

```text
provider
eventId
```

and the database enforces a unique constraint on that pair.

The first implementation checked whether the event already existed, then inserted it — a TOCTOU race. Multiple webhook requests could all observe:

```text
event does not exist
```

before any of them managed to insert the row. Concurrent tests exposed this. The unique constraint is now the actual deduplication boundary: one request wins, the rest become safe duplicates.

---

## Webhook Correlation

The first implementation tried to look up the local payment via `providerRef`, which fails in this scenario:

```text
Stripe approves the payment

API crashes before providerRef is stored

Stripe sends the webhook
```

Stripe knows about the payment, but the local database has no record of its Stripe reference yet. The Stripe object now carries:

```text
metadata.orderId
```

and the webhook uses that to reconnect the external payment with the local order.

---

# Reconciliation

Webhooks aren't the only recovery path. A reconciliation job runs every five minutes, looking for payments stuck in:

```text
PROCESSING
```

Rather than guess, it asks the provider directly:

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

There's also an admin endpoint for manual reconciliation. An in-memory `isRunning` guard keeps the cron and manual trigger from overlapping within the same API process — but that guard doesn't cover separate instances. Cross-instance safety comes from the atomic database claim, verified using two API instances sharing the same PostgreSQL and Redis.

---

# Exactly Once?

This project doesn't claim a universal exactly-once transaction spanning PostgreSQL and Stripe — the actual guarantees are narrower than that.

Locally:

```text
A payment is settled once
```

At the provider boundary:

```text
The same logical Stripe operation reuses the same idempotency key
```

Recovery runs through:

```text
Stripe webhook
+
polling reconciliation
```

So the practical model is:

```text
Local settlement protection
+
provider idempotency
+
webhook recovery
+
reconciliation
```

Stripe itself still owns the guarantee that its idempotency implementation won't double-charge the same provider operation.

---

# Security

Included:

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

Threat model:

```text
docs/threat-model.md
```

Known risks are documented rather than swept under the rug. One current gap: authentication has no account-specific lockout or exponential backoff beyond IP-based rate limiting.

---

# Observability

Prometheus scrapes:

```text
GET /metrics
```

Collected metrics include:

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

HTTP metrics use the matched route pattern rather than the raw URL — `/orders/:id` instead of a separate label per order ID — to avoid unbounded metric cardinality.

---

# Grafana and Alerts

Grafana is provisioned from files stored in the repo. The dashboard covers:

* API health
* request rate
* request latency
* payment results
* Stripe latency
* webhook activity
* PostgreSQL health
* Redis health

Alert rules include:

* API down
* PostgreSQL down
* Redis down
* elevated HTTP 5xx rate
* elevated payment failure rate
* payments stuck in `PROCESSING`
* high Stripe latency

Alerts route through email via Mailtrap SMTP. The full cycle has been tested end to end:

```text
Dependency goes down

Metric changes

Grafana fires

Email arrives

Dependency recovers

Grafana resolves

Resolved email arrives
```

---

# Deployment

Deployed via a self-hosted GitHub Actions runner.

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

The readiness check retries for up to five minutes. Deployment stack:

```text
API
PostgreSQL
Redis
Cloudflared
Prometheus
Grafana
```

The public API currently runs behind a Cloudflare Quick Tunnel. Prometheus and Grafana stay off the public tunnel.

---

# Multi-Instance Test

Production normally runs a single API instance. A separate test environment spins up a second API process against the same PostgreSQL and Redis to verify:

* shared state between instances
* payment races across instances
* webhook deduplication across instances
* reconciliation overlap

For the payment race:

```text
API A
   \
    PostgreSQL
   /
API B
```

Only one instance successfully claims the payment; the other gets a conflict. Same principle for webhook deduplication. The test also confirmed `isRunning` is process-local — cross-instance correctness comes from PostgreSQL, not process memory.

---

# Backup and Restore

A backup and restore drill lives at:

```text
scripts/backup-restore-drill.sh
```

The script:

```text
Creates a database dump

Starts a clean disposable PostgreSQL

Restores the backup

Runs Prisma migrations

Starts the real API

Checks /health/ready

Compares important table counts
```

The restored environment is disposable; the production database is never touched during the drill.

---

# Load Testing

The deployed API was tested with a custom load runner — needed because checkout and payment require fresh state on every run. It records:

```text
p50
p95
p99
throughput
errors
```

A larger product dataset was also generated temporarily to test product queries via:

```sql
EXPLAIN ANALYZE
```

Product name search currently uses a `contains` query. A normal B-tree index didn't help it, so the unused index was dropped. At the current catalog size, the sequential scan is fine; a trigram index would be the next thing to evaluate if search becomes a bottleneck.

Details:

```text
docs/load-testing.md
```

---

# Testing

```bash
npm test
npm run test:cov
npm run test:e2e
```

Current suite:

```text
105 unit tests
60 e2e tests
```

E2E tests run against a real PostgreSQL instance. Some concurrency tests fire between 50 and 100 parallel requests.

| Scenario                          | Expected behavior     |
| ----------------------------------- | ------------------------ |
| Same payment claimed concurrently | One request wins      |
| Same order cancelled concurrently | Stock restored once   |
| Same refresh token reused         | One refresh succeeds  |
| Checkout with one unit left       | One checkout succeeds |
| Webhook and reconciliation race   | One settlement wins   |
| Cross-user order access           | Rejected              |
| Cross-user cancellation           | Rejected              |
| Non-admin reconciliation          | Rejected              |

---

# Health Checks

```text
GET /health/live
GET /health/ready
```

`live` checks whether the process is up. `ready` also checks:

```text
PostgreSQL
Redis
```

Both feed into deployment and monitoring.

---

# Running Locally

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

Swagger:

```text
http://localhost:3000/docs
```

---

# Known Limitations

Known gaps, not hidden TODOs.

## Single Production Instance

The normal deployment runs one API container. It's been tested with two instances, but there's no permanent load balancer or failover instance — a host failure still means downtime.

---

## Cloudflare Quick Tunnel

The public deployment doesn't have a permanent hostname yet. Restarting the tunnel can change the public URL.

---

## Stripe Idempotency Lifetime

Stripe idempotency keys have a limited lifetime. Reconciliation normally runs well before that window closes, but it's still an external constraint outside the app's control.

---

## Idempotency Waiting

Concurrent requests sharing an `Idempotency-Key` currently wait via short polling — fine at the current scale, but worth reconsidering under high contention on a single key.

---

## Authentication Throttling

Authentication routes are protected by IP-based throttling only; no account-level lockout or exponential backoff yet.

---

## Product Search

`Product.name` uses a `contains` query and currently runs a sequential scan, measured with `EXPLAIN ANALYZE`. A trigram index was considered but isn't necessary for the current dataset.

---

## Hand-Written CHECK Constraints

Some PostgreSQL `CHECK` constraints live directly in migration SQL — Prisma's schema DSL doesn't expose all of them cleanly.

---

## Load-Test Data

Orders created during load testing stay in the database to preserve historical foreign-key relationships. Products used only for testing are deactivated rather than deleted, since they're already referenced.

---

# Things I Deliberately Did Not Add

## Outbox

I considered an Outbox pattern. The main failure to solve was:

```text
Stripe succeeds

API dies before saving the result
```

Webhook delivery and reconciliation solve that more directly. The order confirmation email runs after the database transaction — losing an email doesn't lose the order. A full Outbox subsystem would add more infrastructure than this use case needs.

---

## Kafka, Kubernetes, CQRS and Event Sourcing

None of these solve a real constraint in this project right now. Adding infrastructure just to make the architecture look bigger would make the system harder to maintain without improving its guarantees. If the constraints change, these calls can be revisited.

---

# Architecture Decision Records

Decisions that needed more context than a code comment can provide are documented in:

```text
docs/adr/
```

Current ADRs:

1. Payment concurrency with atomic conditional updates
2. Provider-side idempotency
3. Stripe webhook deduplication
4. Payment reconciliation

Each ADR follows a small structure:

```text
Context

Alternatives

Decision

Consequences
```

The goal isn't to document every implementation detail — it's to keep the reasoning behind decisions that would otherwise be easy to lose later.

---

## Project Status

Current coverage:

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

What's left is mostly operational polish and continued refinement, not more architecture for its own sake.
