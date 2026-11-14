# Load testing

Runs through `scripts/load-test.js`, a custom runner rather than autocannon or k6, because checkout and pay each need fresh per-request state (a seeded cart, a fresh PENDING order) that a simple repeated-request tool can't set up between calls.

```
BASE_URL=http://localhost:3000/api \
LOAD_TEST_DURATION_MS=10000 \
LOAD_TEST_CONCURRENCY=20 \
LOAD_TEST_USERS=20 \
node scripts/load-test.js
```

## Results (2026-08-22, self-hosted deploy, single instance)

Measured against the real deployed stack (Docker Compose: NestJS API, Postgres, and Redis, all on one machine), concurrency 20, 10s per endpoint.

**The rate limiter was temporarily raised for this run.** Production runs with `THROTTLE_LIMIT=60` and `THROTTLE_AUTH_LIMIT=20` per minute per IP, and a real load test from a single source IP hits that ceiling almost immediately — the first attempt at these numbers came back as 99%+ `429`s within seconds. That's the rate limiter doing its job, not an application performance problem. But measuring the app's actual per-request capacity needs either traffic from many distinct IPs (not available here) or the limiter disabled for the measurement window. We went with the latter and reverted right after.

| Endpoint | req/s | p50 | p95 | p99 | max | error rate |
|---|---|---|---|---|---|---|
| `GET /products` | 1177.4 | 16ms | 24ms | 28ms | 53ms | 0.00% |
| `POST /orders/checkout` | 224.1 | 56ms | 117ms | 153ms | 213ms | 0.00% |
| `POST /orders/:id/pay` | 106.0 | 161ms | 172ms | 181ms | 199ms | 0.00% |
| `POST /webhooks/stripe` | 854.1 | 23ms | 29ms | 34ms | 58ms | 0.00% |

Notes on what these numbers actually capture:
- `checkout` and `pay` run meaningfully slower than the read and webhook paths because both do real transactional writes: order, cart, and stock inside a `$transaction` for checkout; the payment claim, provider round-trip, and settlement transaction for pay. `pay`'s ~150ms p95 is mostly `FakePaymentProvider`'s simulated 150ms gateway latency, not framework or DB overhead — a real Stripe call would add its own network round-trip on top of whatever this number becomes.
- The webhook number measures the "no matching payment" fast path (signature verification plus dedup lookup, see `scripts/load-test.js`). A full settlement adds `handleOutcome`'s transaction cost on top, roughly comparable to the `pay` numbers minus the provider round-trip.
- Zero errors across all four at this concurrency — no capacity ceiling turned up at 20 concurrent workers on a single small instance.

## `EXPLAIN ANALYZE` on the product listing query

`ProductsService.findAll()` builds one query shape with three optional filters (`isActive`, `name ILIKE`, `price` range) plus pagination. Measured against 20,000 seeded rows (a realistic catalog size, seeded and torn down for this measurement — see `git log` for the throwaway SQL, which was never committed):

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

**Finding: the existing `@@index([isActive])` (see `prisma/schema.prisma`) goes unused for all of these, and that's expected, not a bug.** Given this data distribution (95% of seeded rows active), an index scan on `isActive` would still touch nearly every row. Postgres's planner correctly picks a sequential scan over the overhead of an index lookup plus heap fetch when selectivity is this poor. The index earns its keep on a query filtering for *inactive* products specifically (a small minority) — exactly the shape of the admin-only "all products including inactive" endpoint. Worth another look if that endpoint ever needs to filter to just inactive ones at scale.

The `name ILIKE '%term%'` search is the one case genuinely worth watching. It's a full sequential scan by construction — a leading-wildcard `LIKE` can't use a plain btree index regardless of whether one exists (already noted in `schema.prisma`'s comment on `Product.name`). At 20k rows that's 8ms, fine for now. If the catalog ever grows past roughly 100k-500k active products, this query would need a `pg_trgm` GIN index to stay fast. Not needed today, but it's the first place to check if `GET /products?search=` latency ever becomes a complaint.

The rest of the schema got checked for the same class of problem — a filter or join column with no supporting index: `CartItem.userId`, `Order.userId`, `Order.status`, `OrderItem.orderId`, and `PaymentAttempt.paymentId` are all indexed; `Payment.orderId` is `@unique` (implicit index). No other wildcard (`ILIKE`) filters exist anywhere else in the app. `EXPLAIN ANALYZE` wasn't run against each of these individually — the schema-level audit was enough to rule out "missing index on a hot filter column" as a problem elsewhere.
