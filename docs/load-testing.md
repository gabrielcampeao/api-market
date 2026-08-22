# Load testing

Run with `scripts/load-test.js` — a custom runner, not autocannon/k6: checkout and pay each need fresh per-request state (a seeded cart, a fresh PENDING order) that a simple repeated-request tool can't set up between requests.

```
BASE_URL=http://localhost:3000/api \
LOAD_TEST_DURATION_MS=10000 \
LOAD_TEST_CONCURRENCY=20 \
LOAD_TEST_USERS=20 \
node scripts/load-test.js
```

## Results (2026-08-22, self-hosted deploy, single instance)

Measured against the real deployed stack (Docker Compose: NestJS API + Postgres + Redis, all on one machine), concurrency 20, 10s per endpoint.

**The rate limiter was temporarily raised for this run.** Production runs with `THROTTLE_LIMIT=60` / `THROTTLE_AUTH_LIMIT=20` per minute per IP — a real load test from a single source IP hits that ceiling almost immediately (confirmed: the first attempt at these numbers came back as 99%+ `429`s within seconds). That's the rate limiter working as designed, not an application performance problem, but it means measuring the application's actual per-request capacity requires either traffic from many distinct IPs (not available here) or temporarily disabling the limiter for the measurement window. Chose the latter, then reverted immediately after.

| Endpoint | req/s | p50 | p95 | p99 | max | error rate |
|---|---|---|---|---|---|---|
| `GET /products` | 1177.4 | 16ms | 24ms | 28ms | 53ms | 0.00% |
| `POST /orders/checkout` | 224.1 | 56ms | 117ms | 153ms | 213ms | 0.00% |
| `POST /orders/:id/pay` | 106.0 | 161ms | 172ms | 181ms | 199ms | 0.00% |
| `POST /webhooks/stripe` | 854.1 | 23ms | 29ms | 34ms | 58ms | 0.00% |

Notes on what's actually being measured:
- `checkout` and `pay` are meaningfully slower than the read/webhook paths because both do real transactional writes (order+cart+stock in a `$transaction` for checkout; the payment claim + provider round-trip + settlement transaction for pay) — `pay`'s ~150ms p95 is mostly `FakePaymentProvider`'s simulated 150ms gateway latency, not framework/DB overhead; a real Stripe call would add its own network round-trip on top of whatever this number becomes.
- The webhook number measures the "no matching payment" fast path (signature verification + dedup lookup, see `scripts/load-test.js`) — a full settlement adds the cost of `handleOutcome`'s transaction on top, comparable to the `pay` numbers above minus the provider round-trip.
- Zero errors across all four at this concurrency — no capacity ceiling found at 20 concurrent workers on a single small instance.

## `EXPLAIN ANALYZE` on the product listing query

`ProductsService.findAll()` builds one query shape with three optional filters (`isActive`, `name ILIKE`, `price` range) plus pagination. Measured against 20,000 seeded rows (realistic catalog size, seeded and torn down for this measurement — see `git log` for the throwaway SQL, not committed):

```sql
-- Plain listing (the common case: only isActive filtered)
EXPLAIN ANALYZE SELECT * FROM products WHERE is_active = true ORDER BY created_at DESC LIMIT 20 OFFSET 0;
--  Seq Scan on products (actual time=0.004..1.623 rows=19003 loops=1)
--    Filter: is_active
--    Rows Removed by Filter: 1000
--  Execution Time: 2.965 ms

-- Name search
EXPLAIN ANALYZE SELECT * FROM products WHERE is_active = true AND name ILIKE '%Widget%' ORDER BY created_at DESC LIMIT 20 OFFSET 0;
--  Seq Scan on products (actual time=0.009..7.973 rows=3000 loops=1)
--    Filter: (is_active AND (name ~~* '%Widget%'))
--  Execution Time: 8.228 ms

-- Price range
EXPLAIN ANALYZE SELECT * FROM products WHERE is_active = true AND price BETWEEN 50 AND 200 ORDER BY created_at DESC LIMIT 20 OFFSET 0;
--  Seq Scan on products (actual time=0.007..1.983 rows=5720 loops=1)
--  Execution Time: 2.406 ms
```

**Finding: the existing `@@index([isActive])` (see `prisma/schema.prisma`) isn't used for any of these, and that's correct, not a bug.** At this data distribution (95% of seeded rows active), an index scan on `isActive` would touch nearly every row anyway — Postgres's planner correctly prefers a sequential scan over the overhead of an index lookup plus heap fetch for a filter with such poor selectivity. The index would earn its keep on a query that filters for *inactive* products specifically (a small minority), which is exactly the admin-only "all products including inactive" endpoint's shape — worth revisiting if that endpoint ever needs to filter to *just* inactive ones at scale.

The `name ILIKE '%term%'` search is the one case actually worth watching: it's a full sequential scan by construction (a leading-wildcard `LIKE` can't use a plain btree index regardless of whether one exists — already documented in `schema.prisma`'s comment on `Product.name`). At 20k rows it's 8ms, fine. If the catalog ever grows past roughly 100k-500k active products, this is the query that would need a `pg_trgm` GIN index to stay fast — not needed today, but this is where to look first if `GET /products?search=` latency ever becomes a complaint.

Checked the rest of the schema for the same class of problem (a filter/join column with no supporting index): `CartItem.userId`, `Order.userId`, `Order.status`, `OrderItem.orderId`, and `PaymentAttempt.paymentId` are all indexed; `Payment.orderId` is `@unique` (implicit index). No other wildcard (`ILIKE`) filters exist anywhere else in the app. Didn't run `EXPLAIN ANALYZE` on each of these individually — the schema-level audit was enough to rule out the "missing index on a hot filter column" class of problem elsewhere.
