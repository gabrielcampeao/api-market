# Marketplace API

REST + GraphQL marketplace backend (NestJS, PostgreSQL, Prisma, Redis) — users, catalog, cart, checkout, and simulated payments. Built as a vehicle to work through a handful of concurrency and consistency problems that show up in any e-commerce backend: double-spending a payment, overselling stock, replaying a mutating request, and reusing a refresh token.

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
| Testing | Jest (unit) + Supertest (e2e against a real Postgres) |
| CI | GitHub Actions |
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
├── payments/      # payment state machine + PaymentProvider seam (fake provider today)
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
├── IdempotencyModule (global)
├── ThrottlerModule (global, Redis-backed with in-memory fallback)
├── AuthModule      → Prisma, JwtService, Mail, AuditLog
├── UsersModule     → Prisma, AuditLog
├── ProductsModule  → Prisma, AuditLog
├── CartModule      → Prisma, AuditLog
├── OrdersModule    → Prisma, AuditLog, Mail
├── PaymentsModule  → Prisma, AuditLog, PAYMENT_PROVIDER (DI token → FakePaymentProvider)
└── LogsModule      # admin audit log queries
```

---

## Data Model

```
User ──< RefreshToken
User ──< PasswordResetToken
User ──< CartItem ──> Product
User ──< Order ──< OrderItem ──> Product
Order ──< Payment (1:1)
User ──< AuditLog
IdempotencyKey (standalone, TTL-based)
```

**Enums:** `Role` (USER, ADMIN) · `OrderStatus` (PENDING → PAID → SHIPPED → DELIVERED, PENDING/PAID → CANCELLED) · `PaymentStatus` (PENDING, PROCESSING, APPROVED, FAILED, REFUNDED)

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

Four races that are easy to get wrong with a naive read-then-write, and the atomic-update pattern used instead. All four have e2e tests that actually fire concurrent requests (not mocks) and assert the outcome, including versions with 50 concurrent requests for the payment and checkout races.

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

`FAILED` is claimable so a declined payment can be retried. `providerRef` holds only what the gateway returns — see [Limitations](#limitations) for what this doesn't cover.

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
npm test          # unit (49 tests)
npm run test:cov  # unit with coverage
npm run test:e2e  # e2e (56 tests) — needs a reachable Postgres + Redis, skips itself otherwise
```

E2E runs the full flow (register → catalog → cart → checkout → pay → admin) against a real Postgres, plus a `Concurrency` block that fires actual parallel HTTP requests:

| Race | Concurrency | Expected outcome |
|------|-------------|-------------------|
| Payment claim, same order | 2 and 50 | exactly one `201`, the rest `409` |
| Order cancel, same order | 2 | one `200`, one `400`; stock restored once, not twice |
| Refresh token reuse | 2 | one `200`, one `401` |
| Checkout stock race | 2 and 50 | exactly one `201`, the rest `400`; stock never negative |

The 50-way tests provision their fixture users directly through Prisma + a signed JWT instead of `/auth/register` + `/auth/login` — doing that for real would trip the login throttle (20/min), which is a different thing being tested.

---

## Limitations

Things that are known gaps rather than oversights:

- **Payment provider crash window.** If the process dies after `provider.charge()` succeeds but before the follow-up transaction commits, the payment stays at `PROCESSING` indefinitely. There's no reconciliation worker — `processingAt` is there so one *could* be built (a query for "PROCESSING longer than a charge call should take"), but nothing runs it today.
- **Retry after a provider error isn't charge-safe.** On a provider exception, the payment reverts to `PENDING` so it can be retried — correct if the gateway never captured the charge, wrong (double charge) if it did and only the response was lost. A real integration needs a provider-side idempotency key on the charge request itself; `FakePaymentProvider` doesn't model that failure mode.
- **No `PaymentAttempt` history.** A retried payment overwrites the same row; there's no per-attempt audit trail beyond what's in `AuditLog`.
- **Idempotency uses a 100ms poll**, not a DB wait/notify. Fine at this scale, wouldn't scale to heavy concurrent traffic on one key.
- **No account lockout / brute-force backoff** beyond the generic IP-based throttle on `/auth/*`.
- **`Product.name` search does a sequential scan.** It's a `contains` query; a plain B-tree index can't serve that, and a trigram index wasn't worth adding for a catalog this size.
- **The `CHECK` constraints in `prisma/migrations/` are hand-written SQL** — Prisma's schema language has no constraint primitive for them, so `prisma db pull` / drift detection won't see them.

### Evaluated and deliberately not built

- **Webhooks.** There's no real payment gateway integrated (`FakePaymentProvider` is synchronous, in-process, always approves) — a webhook receiver needs an actual external caller with signatures, event IDs, and out-of-order delivery to defend against. Building that now would be infrastructure for an integration that doesn't exist yet.
- **Outbox pattern.** Outbox earns its keep when a DB transaction commits and an external effect *must* eventually happen even if the process crashes right after. The one external effect here — the order confirmation email in `OrdersService.checkout` — already runs *after* the transaction commits, not inside it, and losing it isn't something a user can't recover from (the order still exists). What Outbox would protect against wasn't actually present; what was present was a smaller bug — an unhandled exception from the mail call could turn an already-successful checkout into a 500 response — fixed with a plain `try/catch`, not a new subsystem.

---

## Engineering Decisions

Only the decisions that weren't the obvious/default choice.

### `updateMany` as compare-and-swap, not `update`

**Problem:** every race condition above is "read a status, then act on it" — and between the read and the write, another request can act first.
**Alternatives considered:** a `SELECT ... FOR UPDATE` row lock; an external lock (Redis `SETNX`); optimistic locking via a version column.
**Decision:** a single `updateMany` with the precondition in the `WHERE` clause. Prisma's `count` tells you whether the precondition held *before* any side effect — `update()` would instead throw `P2025` after already trying to write.
**Trade-off:** this only protects a single row's status transition. It doesn't compose across multiple tables without wrapping it in a transaction (which is why the payment/order interaction uses one), and it doesn't help if the invariant spans more than what a `WHERE` clause can express.

### Payment state machine instead of a sentinel field

**Problem:** the payment claim needs a way to say "someone else has this" that a second concurrent request can detect atomically.
**Alternatives considered:** a Redis distributed lock; a boolean `locked` column; the sentinel-string approach this code used to have (`providerRef = '__claiming__'`).
**Decision:** add a `PROCESSING` status and claim via `status: {in: [PENDING, FAILED]} → PROCESSING`. `providerRef` goes back to meaning only "what the gateway returned."
**Trade-off:** a Redis lock would also protect against a crash leaving the claim stuck (via TTL expiry); this doesn't — see [Limitations](#limitations). It was still the right call here because a DB-only solution doesn't add a second system that has to be up for payments to work, and TTL-based lock expiry has its own correctness problem (what if the process is just slow, not dead?).

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
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts
│   └── migrations/
├── src/
├── test/
│   ├── jest-unit.json
│   ├── jest-e2e.json
│   ├── app.e2e-spec.ts
│   └── global-setup.js         # skips e2e if Postgres isn't reachable
├── Dockerfile
├── docker-compose.yml
└── .env.example
```
