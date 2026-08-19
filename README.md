# Marketplace API

A production-grade RESTful marketplace API built with NestJS, PostgreSQL, Prisma, Redis, and Docker — demonstrating deliberate solutions to concurrency, idempotency, and race-condition problems in real-world e-commerce systems.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 24 |
| Framework | NestJS 11 |
| ORM | Prisma 6 |
| Database | PostgreSQL 16 |
| Cache/Storage | Redis 7 |
| Auth | JWT (access + refresh tokens), Passport |
| Validation | class-validator + class-transformer |
| Docs | Swagger/OpenAPI 3 |
| Logging | Winston + structured audit logs |
| Security | Helmet, CORS, rate limiting (Throttler) |
| Testing | Jest 30 (unit) + Supertest (e2e) |
| CI | GitHub Actions |
| Container | Multi-stage Dockerfile + Docker Compose |

---

## Architecture

```
src/
├── auth/              # Register, login, refresh, password reset
├── users/             # Profile, admin user management
├── products/          # Catalog CRUD, stock management
├── cart/              # Shopping cart with quantity guards
├── orders/            # Checkout, status transitions, cancel
├── payments/          # PaymentProvider abstraction + FakePaymentProvider
├── idempotency/       # Idempotency-Key support for checkout/pay
├── logging/           # Winston logger + AuditLogService (DB)
├── mail/              # Pluggable MailProvider (console in dev)
├── redis/             # Global Redis client (ioredis)
├── prisma/            # PrismaService (global, lifecycle-managed)
├── config/            # Typed AppConfigService (env validation)
├── common/
│   ├── decorators/    # @Public, @CurrentUser, @Roles
│   ├── guards/        # JwtAuthGuard, RolesGuard, ThrottlerGuard
│   ├── dto/           # PaginationQueryDto, PaginatedResponseDto
│   ├── filters/       # AllExceptionsFilter (Prisma P2002/P2025/P2003)
│   ├── mappers/       # toUserDto, toProductDto, toOrderDto
│   └── middleware/     # RequestLoggerMiddleware (x-request-id)
├── throttler/         # Redis-backed ThrottlerStorage (fallback: memory)
└── health/            # Liveness + Readiness probes
```

### Module Graph

```
AppModule
├── PrismaModule (global)
├── RedisModule (global)
├── LoggingModule (global)
├── MailModule (global)
├── IdempotencyModule (global)
├── ThrottlerModule (global)
├── AuthModule
│   ├── AccessTokenStrategy (passport-jwt)
│   └── AuthService → Prisma, JwtService, AppConfig, Mail, AuditLog
├── UsersModule
│   └── UsersService → Prisma, AuditLog
├── ProductsModule
│   └── ProductsService → Prisma, AuditLog
├── CartModule
│   └── CartService → Prisma, AuditLog
├── OrdersModule
│   └── OrdersService → Prisma, AuditLog, Mail
├── PaymentsModule
│   └── PaymentsService → Prisma, AuditLog, PaymentProvider
└── LogsModule (admin audit log queries)
```

---

## Data Model

```prisma
User ──< RefreshToken
User ──< PasswordResetToken
User ──< CartItem ──> Product
User ──< Order ──< OrderItem ──> Product
Order ──< Payment (1:1)
User ──< AuditLog
IdempotencyKey (standalone, TTL-based)
```

**Enums:** `Role` (USER, ADMIN), `OrderStatus` (PENDING→PAID→SHIPPED→DELIVERED, PENDING/PAID→CANCELLED), `PaymentStatus` (PENDING, APPROVED, FAILED, REFUNDED)

---

## Authentication Flow

```
Register → { accessToken, refreshToken }
                │
Login    → { accessToken, refreshToken }
                │
Refresh  → { accessToken, refreshToken }  (old token revoked atomically)
                │
Logout   → refreshToken revoked
```

**Password Reset:**
```
ForgotPassword → email sent (devResetToken returned in non-production)
ResetPassword  → token validated, password updated, all sessions revoked (atomic)
```

### Token Design
| Token | TTL | Storage | Revocation |
|-------|-----|---------|------------|
| Access | 15 min | Client (Bearer header) | Expires naturally |
| Refresh | 7 days | Client (opaque) | Rotated on use; global revoke on password change |
| Password Reset | 1 hour | Client (emitted) | Single-use; marked used atomically |

---

## Race Conditions & Concurrency

This project deliberately implements and tests solutions to four classic concurrency problems.

### 1. Refresh Token Reuse (CAS Pattern)

**Problem:** Two concurrent requests with the same refresh token — one should succeed, the other must fail. A naive `findUnique + update` creates a TOCTOU race.

**Solution:** Atomic `UPDATE ... WHERE id = ? AND revoked_at IS NULL` (compare-and-swap). The `count` from `updateMany` determines the winner.

```ts
// src/auth/auth.service.ts
const revoked = await tx.refreshToken.updateMany({
  where: { id: record.id, revokedAt: null },
  data: { revokedAt: new Date() },
});
if (revoked.count === 0) {
  throw new UnauthorizedException('Refresh token has already been used');
}
```

### 2. Double Payment (Optimistic Locking)

**Problem:** Two concurrent payment requests for the same order — only one should charge the provider and update the payment status.

**Solution:** Optimistic locking via a transient `providerRef` marker. The first caller atomically sets `providerRef = '__claiming__'` via `updateMany` with a condition. Concurrent attempts see `providerRef != null` and abort. On provider failure, the lock is released.

```ts
// src/payments/payments.service.ts
const claimed = await tx.payment.updateMany({
  where: { id: payment.id, status: PENDING, providerRef: null },
  data: { providerRef: '__claiming__' },
});
if (claimed.count === 0) {
  throw new BadRequestException('Payment is already being processed');
}
```

### 3. Order Cancel vs Payment (Atomic Status Transition)

**Problem:** A cancel request and a payment confirmation arrive simultaneously — one must win. A naive read-then-update allows both to succeed.

**Solution:** Atomic `UPDATE ... WHERE status = 'PENDING'` inside a transaction. If the status already changed, `count = 0` and the cancel is rejected. Stock is restored only after the confirmed status change.

```ts
// src/orders/orders.service.ts
const changed = await tx.order.updateMany({
  where: { id: orderId, status: OrderStatus.PENDING },
  data: { status: OrderStatus.CANCELLED },
});
if (changed.count === 0) {
  throw new BadRequestException('Order status has changed — cannot cancel');
}
await this.restoreStock(tx, order);  // only after confirmed cancellation
```

### 4. Checkout Overselling (Atomic Stock CAS)

**Problem:** Two concurrent checkouts with limited stock — both read stock=1, both decrement, one goes negative.

**Solution:** Atomic `UPDATE ... WHERE stock >= quantity` per product line. If the condition fails, the transaction rolls back with an "insufficient stock" error.

```ts
// src/orders/orders.service.ts
const result = await tx.product.updateMany({
  where: { id: line.product.id, stock: { gte: line.quantity } },
  data: { stock: { decrement: line.quantity } },
});
if (result.count === 0) {
  throw new BadRequestException('Insufficient stock');
}
```

### 5. Atomicity in All Error Paths

All multi-step mutations use `$transaction`:
- **updateMe (password change):** user update + session revocation in one transaction
- **Admin update (deactivate):** user update + session revocation in one transaction
- **Deactivate:** user deactivation + session revocation in one transaction
- **Checkout:** stock decrement + order creation + cart clear in one transaction
- **Payment approval:** payment update + order status update in one interactive transaction

---

## Idempotency

Checkout and payment endpoints support the `Idempotency-Key` header:

```
POST /api/orders/checkout
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

**Mechanism:**
1. First request: key is created (via unique constraint), handler executes, result is cached.
2. Duplicate request: key already exists, cached response is returned without re-executing.
3. Expired keys are lazily evicted on lookup.
4. Concurrent duplicates: P2002 (unique constraint violation) triggers a re-fetch of the concurrently inserted result.

**Storage:** `idempotency_keys` table with `expires_at` index for efficient cleanup.

---

## Health Probes

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `GET /api/health/live` | Liveness — process is running | Returns uptime |
| `GET /api/health/ready` | Readiness — dependencies reachable | PostgreSQL (`SELECT 1`), Redis (`PING`) |

Returns `200` with `status: "ok"` when healthy, or `status: "degraded"` with per-dependency detail.

---

## Running the API

### Prerequisites
- Node.js 20+
- Docker & Docker Compose (for PostgreSQL + Redis)
- Or: local PostgreSQL 16 + Redis 7

### Quick Start

```bash
# Clone and install
git clone <repo-url> && cd marketplace-api
cp .env.example .env
npm install

# Start infrastructure
docker compose up -d

# Run migrations + seed
npx prisma migrate deploy
npm run db:seed

# Start development server
npm run start:dev
```

### Docker (full stack)

```bash
docker compose up --build
# API available at http://localhost:3000
# Swagger at http://localhost:3000/docs
```

### Environment Variables

```bash
# .env.example
NODE_ENV=development
PORT=3000
API_PREFIX=api
CORS_ORIGINS=http://localhost:3000
DATABASE_URL=postgresql://marketplace:marketplace@localhost:5432/marketplace?schema=public
REDIS_URL=redis://localhost:6379
JWT_ACCESS_SECRET=change-me-access-secret
JWT_ACCESS_TTL=15m
JWT_REFRESH_SECRET=change-me-refresh-secret
JWT_REFRESH_TTL_DAYS=7
THROTTLE_TTL_MS=60000
THROTTLE_LIMIT=60
THROTTLE_AUTH_LIMIT=20
ADMIN_EMAIL=admin@marketplace.dev
ADMIN_PASSWORD=Admin123!
ADMIN_NAME=Admin
```

> **Production:** `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must be at least 32 characters and cannot start with `change-me`.

---

## Testing

```bash
# Unit tests (31 tests, all passing)
npm test

# Unit tests with coverage
npm run test:cov

# E2E tests (requires PostgreSQL + Redis)
npm run test:e2e
```

### Test Coverage

| Suite | What it covers |
|-------|---------------|
| Unit (31) | Auth service, cart service, orders service, products service |
| E2E (30+) | Full API flow: register→login→products→cart→checkout→pay→orders→payments→admin |

### Concurrency Tests

E2E tests that fire **concurrent HTTP requests** via `Promise.all`:

| Test | Expected outcome |
|------|-----------------|
| Two concurrent payments on same order | One 201, one 400 |
| Two concurrent cancels on same order | One 200, one 400; stock restored exactly once |
| Two concurrent refresh token rotations | One 200, one 401 |
| Two concurrent checkouts with stock=1 | One 201, one 400; stock remains 0 |

---

## CI/CD Pipeline

GitHub Actions runs on every push/PR to `main`:

```
postgres + redis services
        │
        ▼
npm ci → prisma validate → prisma migrate deploy → prisma migrate status
        │
        ▼
lint → typecheck → build
        │
        ▼
unit tests (coverage) → e2e tests → coverage threshold check (50%)
        │
        ▼
coverage artifact uploaded
```

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | Public | Register a new account |
| `POST` | `/auth/login` | Public | Login and receive tokens |
| `POST` | `/auth/refresh` | Public | Rotate refresh token |
| `POST` | `/auth/logout` | Authenticated | Revoke refresh token |
| `POST` | `/auth/forgot-password` | Public | Request password reset |
| `POST` | `/auth/reset-password` | Public | Reset password with token |
| `GET` | `/auth/profile` | Authenticated | Get current user |
| `GET` | `/users` | Admin | List users |
| `PATCH` | `/users/:id` | Admin | Update user |
| `DELETE` | `/users/:id` | Admin | Deactivate user |
| `GET` | `/products` | Public | List products (active only) |
| `GET` | `/products/:id` | Public | Get product |
| `POST` | `/products` | Admin | Create product |
| `PATCH` | `/products/:id` | Admin | Update product |
| `DELETE` | `/products/:id` | Admin | Soft-delete product |
| `GET` | `/cart` | Authenticated | Get cart |
| `POST` | `/cart/items` | Authenticated | Add to cart |
| `PATCH` | `/cart/items/:productId` | Authenticated | Update cart item |
| `DELETE` | `/cart/items/:productId` | Authenticated | Remove cart item |
| `POST` | `/orders/checkout` | Authenticated | Checkout (idempotent) |
| `GET` | `/orders/mine` | Authenticated | List my orders |
| `GET` | `/orders` | Admin | List all orders |
| `GET` | `/orders/:id` | Owner/Admin | Get order |
| `POST` | `/orders/:id/cancel` | Owner | Cancel PENDING order |
| `PATCH` | `/orders/:id/status` | Admin | Advance order status |
| `POST` | `/orders/:id/pay` | Owner | Pay order (idempotent) |
| `GET` | `/orders/:id/payment` | Owner/Admin | Get payment record |
| `GET` | `/logs` | Admin | Query audit logs |
| `GET` | `/health/live` | Public | Liveness probe |
| `GET` | `/health/ready` | Public | Readiness probe |

Swagger documentation: `GET /docs` (useGlobalPrefix: false)

---

## Engineering Decisions

### Why `updateMany` as CAS instead of `update`?

Prisma's `update` throws `P2025` if the record doesn't match — but by then you've already attempted the mutation. `updateMany` returns a `count` that tells you *before* any mutation whether the precondition was met, allowing you to abort without side effects. This is critical for race-condition patterns where the "read" and "write" must be atomic.

### Why interactive transactions for checkout and payment?

Prisma's batch `$transaction([...])` executes all operations in parallel — fine for independent reads, but not for operations where the second depends on the first's result. Interactive transactions (`$transaction(async (tx) => { ... })`) execute sequentially within a single database transaction, ensuring atomicity even when operations depend on each other (e.g., stock decrement → order creation).

### Why refresh token rotation?

Stateless JWT access tokens expire in 15 minutes. Refresh tokens are long-lived but must be revocable. Rotation ensures that each use of a refresh token produces a new one and invalidates the old one. This limits the window of exposure if a token is compromised: the attacker gets one use, and the legitimate user's next refresh attempt reveals the theft (the token was already used).

### Why Redis for throttling?

In-memory throttling (NestJS default) doesn't work across multiple instances. Redis-backed throttling using a sliding window ensures consistent rate limiting in horizontally scaled deployments. The factory falls back to in-memory if Redis is unavailable, keeping the API functional in development.

### Why the `PaymentProvider` interface?

The `FakePaymentProvider` returns approved charges for testing. The interface allows swapping in Stripe, Mercado Pago, or any other provider without touching the payment orchestration logic. The provider is responsible for charging; the service is responsible for the state machine and race-condition protection.

### Why idempotency on checkout and payment?

In distributed systems, network retries can cause duplicate requests. Without idempotency, a retry of checkout could create two orders and charge stock twice. The `Idempotency-Key` header ensures that repeated requests within the TTL window return the same cached result, preventing duplicate side effects.

### Why hand-written migration SQL?

The initial migration SQL is committed to the repository so that `prisma migrate deploy` works in Docker and CI without requiring `prisma migrate dev`. This ensures the database can be rebuilt from zero using only the committed migration files, which is essential for reproducible deployments.

---

## Security Checklist

- [x] JWT secrets validated at startup (minimum 32 chars in production)
- [x] `passwordHash` never leaves the service layer
- [x] No sensitive data in audit log metadata or HTTP logs
- [x] `devResetToken` only returned when `NODE_ENV !== 'production'`
- [x] Same response message for forgot-password (exists or not)
- [x] Reset token single-use (marked `usedAt` atomically)
- [x] All sessions revoked on password change (atomic transaction)
- [x] Helmet security headers enabled
- [x] CORS configured with explicit origins
- [x] Rate limiting on all endpoints (default + auth-specific)
- [x] ValidationPipe: whitelist, forbidNonWhitelisted, stopAtFirstError
- [x] All DTOs have @MinLength, @MaxLength, @IsEmail, etc.
- [x] Admin endpoints protected by `@Roles(Role.ADMIN)` guard
- [x] Soft-delete for products (data preservation)
- [x] Prisma P2002 (unique violation) mapped to 409 Conflict

---

## Project Structure

```
├── .github/workflows/ci.yml   # GitHub Actions CI pipeline
├── prisma/
│   ├── schema.prisma           # Data model
│   ├── seed.ts                 # Admin + sample products
│   └── migrations/             # Hand-written SQL migrations
├── src/                        # Application source
├── test/
│   ├── jest-unit.json          # Unit test config
│   ├── jest-e2e.json           # E2E test config
│   ├── app.e2e-spec.ts         # Full E2E test suite
│   └── global-setup.js         # DB availability check
├── Dockerfile                  # Multi-stage build
├── docker-compose.yml          # Postgres + Redis + API
├── .env.example                # Environment template
└── package.json
```
# api-market
