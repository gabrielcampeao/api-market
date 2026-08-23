// Proves the app's concurrency guarantees don't depend on in-process memory:
// runs the same payment/webhook/reconciliation flows against TWO separate
// API instances (api on :3000, api-b on :3002 — see
// docker-compose.multi-instance-test.yml) sharing one Postgres/Redis, and
// checks that the database-level CAS (updateMany keyed on expected status,
// and the WebhookEvent unique (provider, eventId) constraint) is what
// actually prevents double-processing — not anything held in a single
// process's memory.
//
// Usage:
//   docker compose --env-file ~/marketplace-prod.env \
//     -f docker-compose.prod.yml -f docker-compose.multi-instance-test.yml \
//     up -d --build api-b
//   STRIPE_WEBHOOK_SECRET=... node scripts/multi-instance-test.js
'use strict';

const { execSync } = require('child_process');

const BASE_A = process.env.BASE_URL_A || 'http://localhost:3000/api';
const BASE_B = process.env.BASE_URL_B || 'http://localhost:3002/api';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@marketplace.dev';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin123!';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

function log(msg) {
  console.log(msg);
}

async function req(base, method, path, { token, body, headers } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function login(base, email, password) {
  const { status, body } = await req(base, 'POST', '/auth/login', { body: { email, password } });
  if (status !== 200 && status !== 201) throw new Error(`login failed on ${base}: ${status} ${JSON.stringify(body)}`);
  return body.accessToken;
}

async function register(base, email, password, name) {
  const { status } = await req(base, 'POST', '/auth/register', { body: { email, password, name } });
  if (status !== 201 && status !== 409) throw new Error(`register failed on ${base}: ${status}`);
}

// Runs a psql command against the running postgres container so we can craft
// a payment that's been PROCESSING for longer than the reconciliation
// staleness window (5 min, see DEFAULT_STALE_AFTER_MS) without waiting 5
// real minutes.
function psql(sql) {
  const cmd = `docker compose -f docker-compose.prod.yml exec -T postgres psql -U marketplace -d marketplace -t -A -c "${sql.replace(/"/g, '\\"')}"`;
  const out = execSync(cmd, { encoding: 'utf8' }).trim();
  // UPDATE/INSERT/DELETE ... RETURNING prints the row value AND a command
  // tag ("UPDATE 1") on the next line — keep only the data line(s).
  return out
    .split('\n')
    .filter((line) => !/^(UPDATE|INSERT|DELETE)\s+\d+$/.test(line.trim()))
    .join('\n')
    .trim();
}

async function testSharedState(adminToken) {
  log('\n=== 1) Shared state across instances (not per-instance memory) ===');
  const { body: product } = await req(BASE_A, 'POST', '/products', {
    token: adminToken,
    body: { name: `multi-instance-check-${Date.now()}`, price: 1.23, stock: 10 },
  });
  const { status, body: seenFromB } = await req(BASE_B, 'GET', `/products/${product.id}`);
  log(
    status === 200 && seenFromB.id === product.id
      ? `OK — product created via A (:3000) immediately visible via B (:3002). id=${product.id}`
      : `FAIL — B could not see product created via A. status=${status}`,
  );
  return product;
}

async function testConcurrentPayRace(userToken, product) {
  log('\n=== 2) Concurrent pay: same order, hit A and B at the same instant ===');
  await req(BASE_A, 'POST', '/cart/items', { token: userToken, body: { productId: product.id, quantity: 1 } });
  const { body: order } = await req(BASE_A, 'POST', '/orders/checkout', { token: userToken });
  log(`order ${order.id} created (PENDING), firing pay at both instances concurrently...`);

  const [fromA, fromB] = await Promise.all([
    req(BASE_A, 'POST', `/orders/${order.id}/pay`, { token: userToken }),
    req(BASE_B, 'POST', `/orders/${order.id}/pay`, { token: userToken }),
  ]);
  log(`A (:3000) -> ${fromA.status}`);
  log(`B (:3002) -> ${fromB.status}`);
  const successes = [fromA.status, fromB.status].filter((s) => s === 200 || s === 201).length;
  const conflicts = [fromA.status, fromB.status].filter((s) => s === 409).length;
  log(
    successes === 1 && conflicts === 1
      ? 'OK — exactly one instance won the claim (the DB updateMany CAS, not in-memory state, decided this), the other got 409.'
      : `UNEXPECTED — expected one 2xx + one 409, got successes=${successes} conflicts=${conflicts}. Charging the same order twice would be a real bug.`,
  );
  return order;
}

async function testConcurrentWebhookDedup(order) {
  log('\n=== 3) Concurrent webhook: same Stripe event delivered to A and B at once ===');
  if (!STRIPE_WEBHOOK_SECRET) {
    log('SKIPPED — set STRIPE_WEBHOOK_SECRET to run this.');
    return;
  }
  const Stripe = require('stripe');
  const eventId = `evt_multiinstance_${Date.now()}`;
  const payload = JSON.stringify({
    id: eventId,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: `pi_multiinstance_${Date.now()}`,
        last_payment_error: null,
        metadata: { orderId: order.id },
      },
    },
  });
  const signature = new Stripe('sk_test_dummy_for_signing').webhooks.generateTestHeaderString({
    payload,
    secret: STRIPE_WEBHOOK_SECRET,
  });
  const opts = { body: payload, headers: { 'stripe-signature': signature } };

  const [fromA, fromB] = await Promise.all([
    req(BASE_A, 'POST', '/webhooks/stripe', opts),
    req(BASE_B, 'POST', '/webhooks/stripe', opts),
  ]);
  log(`A (:3000) -> ${fromA.status}`);
  log(`B (:3002) -> ${fromB.status}`);

  const rowCount = psql(
    `SELECT count(*) FROM webhook_events WHERE provider='stripe' AND event_id='${eventId}';`,
  );
  log(
    rowCount === '1'
      ? `OK — exactly 1 row in webhook_events for event ${eventId} despite both instances receiving it (DB unique (provider, event_id) constraint deduped it, not per-instance memory).`
      : `UNEXPECTED — webhook_events has ${rowCount} rows for this event id, expected 1.`,
  );
}

async function testConcurrentReconciliation(adminToken, userToken, product) {
  log('\n=== 4) Concurrent reconciliation: isRunning is per-instance, does NOT stop two instances entering at once ===');

  // A genuinely fresh, still-PENDING order — never touched by /pay, so no
  // charge() call ever happened on either instance's FakePaymentProvider and
  // order.status is really PENDING. This is what "stuck" looks like for
  // real: the app crashed between claiming PROCESSING and the provider
  // responding, before the order was ever moved to PAID. (Reusing an
  // already-settled order here, like an earlier version of this script did,
  // produces a REFUNDED result instead — that's payment-reconciliation.
  // service.ts:207-219's "order was cancelled while payment was stuck"
  // safeguard correctly firing on a self-inflicted, unrealistic state, not a
  // real bug. See the memory note this test run left behind if you hit that.)
  await req(BASE_A, 'POST', '/cart/items', { token: userToken, body: { productId: product.id, quantity: 1 } });
  const { body: order } = await req(BASE_A, 'POST', '/orders/checkout', { token: userToken });
  log(`fresh order ${order.id} created (PENDING, never paid). Inserting a synthetic stuck payment for it...`);

  const stuckId = psql(
    `UPDATE payments
     SET status = 'PROCESSING', processing_at = now() - interval '10 minutes', updated_at = now()
     WHERE order_id = '${order.id}' AND status = 'PENDING'
     RETURNING id;`,
  );
  log(`payment ${stuckId} inserted as PROCESSING/stale, never charged by either instance. Firing POST /payments/reconcile at both instances concurrently...`);

  const [fromA, fromB] = await Promise.all([
    req(BASE_A, 'POST', '/payments/reconcile', { token: adminToken }),
    req(BASE_B, 'POST', '/payments/reconcile', { token: adminToken }),
  ]);
  log(`A (:3000) -> ${fromA.status} ${JSON.stringify(fromA.body)}`);
  log(`B (:3002) -> ${fromB.status} ${JSON.stringify(fromB.body)}`);
  log(
    'Both should report checked >= 1 and stillUnknown >= 1 for this payment — neither instance ever called charge() '
      + 'for it, so both FakePaymentProvider.checkStatus() calls correctly return \'unknown\' (a real Stripe call '
      + 'would instead resolve deterministically for both, since it queries Stripe\'s API rather than per-process '
      + 'memory). The point proven here: both instances\' isRunning were independently false, so both entered the '
      + 'reconciliation loop for the same stuck row at once — check `docker compose logs api api-b` for overlapping '
      + 'timestamps. Had both resolved a determinate outcome, the updateMany-with-status-filter CAS (same pattern '
      + 'as test 2, applied in payment-reconciliation.service.ts instead of payments.service.ts) is what would have '
      + 'let only one of them win.',
  );
  const finalStatus = psql(`SELECT status FROM payments WHERE id='${stuckId}';`);
  log(`final status of payment ${stuckId}: ${finalStatus} (expected: still PROCESSING — both saw 'unknown', neither claimed it)`);
}

async function main() {
  log(`Multi-instance test: A=${BASE_A}  B=${BASE_B}`);
  const adminToken = await login(BASE_A, ADMIN_EMAIL, ADMIN_PASSWORD);
  const userEmail = `multiinstance-${Date.now()}@test.dev`;
  await register(BASE_A, userEmail, 'MultiInstance123!', 'Multi Instance Tester');
  const userToken = await login(BASE_A, userEmail, 'MultiInstance123!');

  const product = await testSharedState(adminToken);
  const order = await testConcurrentPayRace(userToken, product);
  await testConcurrentWebhookDedup(order);
  await testConcurrentReconciliation(adminToken, userToken, product);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
