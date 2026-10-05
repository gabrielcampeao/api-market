// Custom load test, not autocannon's static-request model: checkout and pay
// each need fresh per-request state (a seeded cart, a fresh PENDING order),
// which a simple repeated-request runner can't set up between requests.
//
// Usage: BASE_URL=http://localhost:3000/api node scripts/load-test.js
'use strict';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api';
const DURATION_MS = Number(process.env.LOAD_TEST_DURATION_MS || 10_000);
const CONCURRENCY = Number(process.env.LOAD_TEST_CONCURRENCY || 20);
const USER_POOL_SIZE = Number(process.env.LOAD_TEST_USERS || 25);

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@marketplace.dev';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin123!';

function percentile(sortedLatencies, p) {
  if (sortedLatencies.length === 0) return 0;
  const idx = Math.min(sortedLatencies.length - 1, Math.ceil((p / 100) * sortedLatencies.length) - 1);
  return sortedLatencies[idx];
}

async function req(method, path, { token, body } = {}) {
  const start = performance.now();
  let status = 0;
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    await res.text().catch(() => {});
  } catch {
    status = 0; // network-level failure (connection refused, timeout, etc.)
  }
  return { durationMs: performance.now() - start, status };
}

async function login(email, password) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  const body = await res.json();
  return body.accessToken;
}

async function register(email, password, name) {
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  // Already registered from a previous run — fine, we'll just log in.
  if (!res.ok && res.status !== 409) {
    throw new Error(`register failed for ${email}: ${res.status}`);
  }
}

async function runScenario(name, durationMs, concurrency, iteration) {
  const latencies = [];
  const statusCounts = {};
  const deadline = Date.now() + durationMs;

  const worker = async (workerIndex) => {
    while (Date.now() < deadline) {
      const { durationMs: d, status } = await iteration(workerIndex);
      latencies.push(d);
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
  };

  const wallStart = performance.now();
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  const wallMs = performance.now() - wallStart;

  latencies.sort((a, b) => a - b);
  const errors = Object.entries(statusCounts)
    .filter(([status]) => Number(status) === 0 || Number(status) >= 400)
    .reduce((sum, [, count]) => sum + count, 0);

  return {
    name,
    count: latencies.length,
    throughputPerSec: latencies.length / (wallMs / 1000),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1] || 0,
    errors,
    errorRate: latencies.length ? errors / latencies.length : 0,
    statusCounts,
  };
}

function printResult(r) {
  console.log(`\n=== ${r.name} ===`);
  console.log(`requests: ${r.count}  throughput: ${r.throughputPerSec.toFixed(1)}/s  errors: ${r.errors} (${(r.errorRate * 100).toFixed(2)}%)`);
  console.log(`p50: ${r.p50.toFixed(1)}ms  p95: ${r.p95.toFixed(1)}ms  p99: ${r.p99.toFixed(1)}ms  max: ${r.max.toFixed(1)}ms`);
  console.log(`status codes: ${JSON.stringify(r.statusCounts)}`);
}

async function main() {
  console.log(`Load testing ${BASE_URL} — ${DURATION_MS}ms per scenario, concurrency=${CONCURRENCY}`);

  const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  // Load-test product: absurdly high stock so checkout/pay never fail on
  // "insufficient stock" — that's a correctness test's job (already covered
  // in app.e2e-spec.ts), not this one's.
  const productRes = await fetch(`${BASE_URL}/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: 'Load Test Product', price: 9.99, stock: 1_000_000 }),
  });
  const product = await productRes.json();

  // A pool of real logged-in users, reused round-robin across all workers —
  // each user's cart is always empty at the start of an iteration (checkout
  // empties it), so re-adding one item and checking out again is always valid.
  const userTokens = [];
  for (let i = 0; i < USER_POOL_SIZE; i++) {
    const email = `loadtest-${i}@test.dev`;
    await register(email, 'LoadTest123!', `Load Test User ${i}`);
    userTokens.push(await login(email, 'LoadTest123!'));
  }
  const tokenFor = (i) => userTokens[i % userTokens.length];

  const results = [];

  results.push(
    await runScenario('GET /products', DURATION_MS, CONCURRENCY, () => req('GET', '/products?limit=20')),
  );

  results.push(
    await runScenario('POST /orders/checkout', DURATION_MS, CONCURRENCY, async (i) => {
      const token = tokenFor(i);
      await req('POST', '/cart/items', { token, body: { productId: product.id, quantity: 1 } });
      return req('POST', '/orders/checkout', { token });
    }),
  );

  results.push(
    await runScenario('POST /orders/:id/pay', DURATION_MS, CONCURRENCY, async (i) => {
      const token = tokenFor(i);
      await req('POST', '/cart/items', { token, body: { productId: product.id, quantity: 1 } });
      const checkoutRes = await fetch(`${BASE_URL}/orders/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const order = await checkoutRes.json();
      return req('POST', `/orders/${order.id}/pay`, { token });
    }),
  );

  // Webhook: each event references a random, non-existent orderId — this
  // measures signature verification + the dedup lookup + the "no matching
  // payment" short-circuit, not a full settlement transaction. That's the
  // floor cost every webhook delivery pays regardless of outcome; a real
  // settlement adds the cost of the $transaction in handleOutcome() on top.
  const Stripe = require('stripe');
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeWebhookSecret) {
    console.log('\n=== POST /webhooks/stripe ===\nskipped: STRIPE_WEBHOOK_SECRET not set in this environment');
  } else {
    let eventCounter = 0;
    results.push(
      await runScenario('POST /webhooks/stripe', DURATION_MS, CONCURRENCY, async () => {
        eventCounter++;
        const payload = JSON.stringify({
          id: `evt_loadtest_${Date.now()}_${eventCounter}`,
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: `pi_loadtest_${eventCounter}`,
              last_payment_error: null,
              metadata: { orderId: '00000000-0000-0000-0000-000000000000' },
            },
          },
        });
        const signature = new Stripe('sk_test_dummy_for_signing').webhooks.generateTestHeaderString({
          payload,
          secret: stripeWebhookSecret,
        });
        const start = performance.now();
        const res = await fetch(`${BASE_URL}/webhooks/stripe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
          body: payload,
        });
        await res.text().catch(() => {});
        return { durationMs: performance.now() - start, status: res.status };
      }),
    );
  }

  for (const r of results) printResult(r);

  console.log('\n=== Markdown summary ===\n');
  console.log('| Endpoint | req/s | p50 | p95 | p99 | max | error rate |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of results) {
    console.log(
      `| ${r.name} | ${r.throughputPerSec.toFixed(1)} | ${r.p50.toFixed(0)}ms | ${r.p95.toFixed(0)}ms | ${r.p99.toFixed(0)}ms | ${r.max.toFixed(0)}ms | ${(r.errorRate * 100).toFixed(2)}% |`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
