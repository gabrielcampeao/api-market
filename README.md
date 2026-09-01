# Marketplace API

A marketplace backend built with **NestJS, PostgreSQL, Prisma and Redis**.

It includes the usual marketplace flows such as users, products, cart, checkout, orders and payments.

Most of the work in this project ended up being around the parts that are easier to get wrong in a backend:

* concurrent payment requests
* stock races during checkout
* request retries
* refresh token reuse
* Stripe webhook duplication
* partial failures between Stripe and the local database
* recovery of payments stuck in processing
* dependency failures
* deployment and rollback

The API exposes both **REST** and **GraphQL**.

Payments use **Stripe** when configured and fall back to a fake provider for local development.

The project also includes:

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

More detailed technical decisions are available in [`docs/adr/`](docs/adr/).

Security notes and known risks are documented in [`SECURITY.md`](SECURITY.md) and [`docs/threat-model.md`](docs/threat-model.md).

---

## Tech stack

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
| -------------- | -------------------------------------------------------------- |
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
| `common/`      | Guards, decorators, filters, mappers and middleware            |

REST controllers and GraphQL resolvers use the same business services.

The business rules are not duplicated between the two APIs.

---

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

Payment and order transitions are centralized instead of being reimplemented in different services.

Examples of invalid transitions:

```text
APPROVED -> PROCESSING
REFUNDED -> APPROVED
```

This makes the state rules easier to test and harder to bypass accidentally.

---

## Authentication

Login and registration return an access token and a refresh token.

| Token                |   Lifetime |
| -------------------- | ---------: |
| Access token         | 15 minutes |
| Refresh token        |     7 days |
| Password reset token |     1 hour |

Refresh tokens are opaque and stored hashed in PostgreSQL.

Every successful refresh revokes the previous token and returns a new pair.

The revocation uses a conditional database update:

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

This avoids a read-then-write race when two requests try to use the same refresh token at the same time.

---

# Concurrency

Most of the interesting bugs in this project came from flows where state was read first and changed later.

A pattern like this can be unsafe:

```text
READ
CHECK
UPDATE
```

Another request can modify the record between the read and the update.

For critical transitions, the condition is included directly in the database update.

---

## Payment claim

Before calling the payment provider, a payment must move from:

```text
PENDING -> PROCESSING
```

The transition is claimed atomically:

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

Only one concurrent request can match the expected state.

The others receive a conflict instead of calling the provider again.

An earlier version used:

```text
providerRef = "__claiming__"
```

as a lock.

That worked, but it mixed two responsibilities.

`providerRef` should contain the identifier returned by the payment provider.

The explicit `PROCESSING` state is clearer and easier to recover later.

---

## Checkout stock race

Stock is also updated conditionally:

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

If another checkout takes the remaining stock first:

```text
count = 0
```

and the second checkout fails.

PostgreSQL also has a database-level constraint preventing negative stock.

That provides a second line of defense if application logic is ever bypassed.

---

## Order cancellation vs payment

Cancellation also depends on the current state:

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

If another request changes the order first, the update no longer matches.

This prevents two independent operations from silently overwriting each other.

---

# Payment settlement

A payment can be confirmed by three different paths:

```text
Original pay request
Stripe webhook
Reconciliation job
```

Any two of them can run at the same time.

The main rule is simple:

```text
Claim the payment first
Then update related state
```

This ordering matters.

An earlier version updated the order before checking whether the payment claim actually succeeded.

That could create inconsistent state such as:

```text
order = PAID
payment = FAILED
```

The payment claim is now the first mutation.

Only the winner continues to update:

* the order
* PaymentAttempt
* audit logs
* metrics

There is an e2e test that fires webhook processing and reconciliation against the same payment at the same time.

The test checks both final state and audit records to make sure only one path actually records the approval.

---

# Idempotency

Checkout and payment support:

```http
Idempotency-Key: <value>
```

The key is scoped by:

```text
user
route
request payload
```

Behavior:

| Situation                 | Result                                           |
| ------------------------- | ------------------------------------------------ |
| New key                   | Request executes and response is stored          |
| Same key + same body      | Cached response is returned                      |
| Same key + different body | `409 Conflict`                                   |
| Same key concurrently     | One request runs, the other waits for its result |

The request body is hashed using SHA-256.

Object keys are sorted before hashing.

These two payloads are therefore treated as equivalent:

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

Concurrent requests currently use a short polling interval while waiting for the first request to finish.

That is enough for this project, but it is documented as something that would need to change under heavy contention on a single key.

---

# Stripe payments

When `STRIPE_SECRET_KEY` is configured, the application uses Stripe.

Without it, local development uses the fake provider.

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

This abstraction exists because there are two real implementations.

Similar abstractions were removed elsewhere when they did not provide any practical value.

---

## Payment attempts

`Payment` represents the logical payment.

`PaymentAttempt` represents each interaction with the provider.

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

Before `PaymentAttempt` existed, retries overwrote information on the same payment record.

Keeping attempts separately makes failures and retries easier to understand later.

---

## Provider idempotency

Client idempotency protects:

```text
Client -> API
```

It does not protect:

```text
API -> Stripe
```

Stripe receives its own idempotency key for the logical payment.

The key is created once and reused for retries.

This matters in a failure like:

```text
API sends payment request

Stripe processes it

response is lost

API retries
```

Without provider-side idempotency, the retry could become another charge.

---

# Stripe webhooks

Stripe sends events to:

```text
POST /webhooks/stripe
```

The request signature is verified using the raw HTTP body.

NestJS is configured with:

```ts
rawBody: true
```

because parsing and serializing the body again changes the original bytes used by Stripe to calculate the signature.

This was a real bug found while testing the webhook integration.

---

## Webhook deduplication

Every received Stripe event is persisted with:

```text
provider
eventId
```

The database has a unique constraint on that pair.

The first implementation checked whether the event existed and then created it.

That had a TOCTOU race.

Multiple webhook requests could all see:

```text
event does not exist
```

before any of them inserted the row.

Concurrent tests exposed the problem.

The database unique constraint is now the deduplication boundary.

One request wins.

The others become safe duplicates.

---

## Webhook correlation

The first implementation tried to find the local payment using `providerRef`.

That fails in this scenario:

```text
Stripe approves the payment

API crashes before providerRef is stored

Stripe sends the webhook
```

Stripe knows about the payment, but the local database still does not know its Stripe reference.

The Stripe object now contains:

```text
metadata.orderId
```

The webhook uses that metadata to reconnect the external payment with the local order.

---

# Reconciliation

Webhooks are not the only recovery mechanism.

A reconciliation job runs every five minutes.

It looks for payments stuck in:

```text
PROCESSING
```

Instead of guessing what happened, it asks the provider directly.

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

There is also an admin endpoint for manual reconciliation.

An in-memory `isRunning` guard prevents the cron and manual trigger from overlapping inside the same API process.

That guard does not protect separate API instances.

Cross-instance safety comes from the atomic database claim.

This was verified using two API instances sharing the same PostgreSQL and Redis.

---

# Exactly once?

The project does not claim to provide a universal exactly-once transaction across PostgreSQL and Stripe.

The actual guarantees are more specific.

Locally:

```text
A payment is settled once
```

At the provider boundary:

```text
The same logical Stripe operation reuses the same idempotency key
```

Recovery is handled through:

```text
Stripe webhook
+
polling reconciliation
```

The practical model is:

```text
Local settlement protection
+
provider idempotency
+
webhook recovery
+
reconciliation
```

Stripe still owns the guarantee that its idempotency implementation will not double-charge the same provider operation.

---

# Security

The project includes:

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

The threat model is available at:

```text
docs/threat-model.md
```

Known risks are documented instead of being hidden.

One current limitation is that authentication does not have account-specific lockout or exponential backoff beyond IP-based rate limiting.

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

HTTP metrics use the matched route pattern instead of the raw URL.

For example:

```text
/orders/:id
```

instead of creating a separate label for every order ID.

This avoids unbounded metric cardinality.

---

# Grafana and alerts

Grafana is provisioned from files stored in the repository.

The dashboard covers:

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

Alerts are routed through email using Mailtrap SMTP.

The full cycle was tested:

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

The application is deployed using a self-hosted GitHub Actions runner.

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

The readiness check is retried for up to five minutes.

The deployment stack contains:

```text
API
PostgreSQL
Redis
Cloudflared
Prometheus
Grafana
```

The public API currently uses a Cloudflare Quick Tunnel.

Prometheus and Grafana are not exposed through the public tunnel.

---

# Multi-instance test

Production normally runs one API instance.

A separate test environment starts a second API process using the same PostgreSQL and Redis.

It verifies:

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

Only one instance successfully claims the payment.

The other receives a conflict.

The same principle applies to webhook deduplication.

The test also confirmed that `isRunning` is process-local.

Cross-instance correctness comes from PostgreSQL, not process memory.

---

# Backup and restore

A backup and restore drill is available at:

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

The restored environment is disposable.

The production database is not modified during the drill.

---

# Load testing

The deployed API was tested using a custom load runner.

A custom runner was used because checkout and payment require fresh state for each flow.

The test records:

```text
p50
p95
p99
throughput
errors
```

A larger product dataset was also created temporarily to test product queries using:

```sql
EXPLAIN ANALYZE
```

The product name search currently uses a `contains` query.

A normal B-tree index did not improve that query, so the unused index was removed.

For the current catalog size, the sequential scan is acceptable.

If product search becomes a bottleneck, a trigram index would be the next option to evaluate.

Details are available in:

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

E2E tests use a real PostgreSQL instance.

Some concurrency tests send between 50 and 100 requests in parallel.

| Scenario                          | Expected behavior     |
| --------------------------------- | --------------------- |
| Same payment claimed concurrently | One request wins      |
| Same order cancelled concurrently | Stock restored once   |
| Same refresh token reused         | One refresh succeeds  |
| Checkout with one unit left       | One checkout succeeds |
| Webhook and reconciliation race   | One settlement wins   |
| Cross-user order access           | Rejected              |
| Cross-user cancellation           | Rejected              |
| Non-admin reconciliation          | Rejected              |

---

# Health checks

```text
GET /health/live
GET /health/ready
```

`live` checks whether the application process is running.

`ready` also checks:

```text
PostgreSQL
Redis
```

These endpoints are used by deployment and monitoring.

---

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

Swagger:

```text
http://localhost:3000/docs
```

---

# Known limitations

These are known gaps, not hidden TODOs.

## Single production instance

The normal deployment runs one API container.

The application has been tested with two instances, but there is no permanent load balancer or failover instance.

A host failure still means downtime.

---

## Cloudflare Quick Tunnel

The public deployment does not currently have a permanent hostname.

Restarting the tunnel can change the public URL.

---

## Stripe idempotency lifetime

Stripe idempotency keys have a limited lifetime.

Reconciliation normally happens far earlier than that window, but this is still an external constraint the application does not control.

---

## Idempotency waiting

Concurrent requests using the same `Idempotency-Key` currently wait using short polling.

This is acceptable for the current scale.

It would need to be reconsidered under high contention on the same key.

---

## Authentication throttling

Authentication routes are protected by IP-based throttling.

There is no account-level lockout or exponential backoff yet.

---

## Product search

`Product.name` uses a `contains` query and currently performs a sequential scan.

This was measured with `EXPLAIN ANALYZE`.

A trigram index was considered but was not necessary for the current dataset.

---

## Hand-written CHECK constraints

Some PostgreSQL `CHECK` constraints are defined directly in migration SQL.

Prisma does not expose all of these constraints cleanly through its schema DSL.

---

## Load-test data

Orders created during load testing remain in the database to preserve historical foreign-key relationships.

Products used only for the test are deactivated instead of removing records that are already referenced.

---

# Things I deliberately did not add

## Outbox

I considered an Outbox pattern.

The main failure I needed to solve was:

```text
Stripe succeeds

API dies before saving the result
```

Webhook delivery and reconciliation solve that problem more directly.

The order confirmation email runs after the database transaction.

Losing an email does not lose the order itself.

Adding a full Outbox subsystem for the current use case would add more infrastructure than the problem requires.

---

## Kafka, Kubernetes, CQRS, and event sourcing

These were not added because they do not solve a current constraint in this project.

Adding infrastructure only to make the architecture look larger would make the system harder to maintain without improving its guarantees.

If the constraints change, these decisions can be revisited.

---

# Architecture decision records

The decisions that needed more context than a code comment are documented in:

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

The goal is not to document every implementation detail.

The goal is to keep the reasoning behind the decisions that would otherwise be easy to forget later.

---

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

The remaining work is mostly operational improvement and continued refinement rather than adding more architecture for the sake of it.
