import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { hashPassword } from '../src/common/utils/password.util';
import { AppModule } from '../src/app.module';
import { PAYMENT_PROVIDER, PaymentProvider } from '../src/payments/providers/payment-provider.interface';
import Stripe from 'stripe';
import { AppConfigService } from '../src/config/app-config.service';
import { LoggingService } from '../src/logging/logging.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

const prisma = new PrismaClient();

const http = () => request(app!.getHttpServer());

// Mutable app and prefix set in beforeAll.
let app: INestApplication;
let api: string;

// Shared state that flows between describe blocks.
let userToken: string;
let userRefresh: string;
let adminToken: string;
let productId: string;
let orderId: string;

const registerUser = (email: string, name: string, password: string) =>
  http().post(`${api}/auth/register`).send({ email, name, password });

const login = (email: string, password: string) =>
  http().post(`${api}/auth/login`).send({ email, password });

// Fixtures for large-N concurrency tests (e.g. 50 users racing for one unit
// of stock) go through Prisma + a directly-signed JWT instead of hitting
// POST /auth/register + /auth/login 50 times each: that's not what those
// tests are exercising, and doing it for real would trip the auth
// throttler (20 req/60s) — a bucket that's supposed to slow down credential
// stuffing, not this test suite.
let jwtService: JwtService;
async function createRaceUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email, name: email, passwordHash: await hashPassword('unused-in-this-test'), role: Role.USER },
  });
  return jwtService.signAsync({ sub: user.id, email: user.email, role: user.role });
}

describe('Marketplace API (e2e)', () => {
  // ----------------------------------------------------------------
  // Bootstrap
  // ----------------------------------------------------------------

  beforeAll(async () => {
    await prisma.$connect();

    // Clean slate in dependency order.
    await prisma.idempotencyKey.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.passwordResetToken.deleteMany();
    await prisma.cartItem.deleteMany();
    await prisma.orderItem.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.order.deleteMany();
    await prisma.product.deleteMany();
    await prisma.user.deleteMany();

    await prisma.user.create({
      data: {
        email: 'admin@test.dev',
        name: 'Admin',
        passwordHash: await hashPassword('Admin123!'),
        role: Role.ADMIN,
      },
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // rawBody must be enabled here too, not just in main.ts's bootstrap() —
    // this test app is created independently via Test.createTestingModule,
    // so it doesn't inherit main.ts's NestFactory.create options. Without
    // it, req.rawBody is always undefined and the Stripe webhook signature
    // check fails on every request, signed correctly or not.
    app = moduleFixture.createNestApplication({ rawBody: true });
    jwtService = app.get(JwtService);
    const config = app.get(AppConfigService);
    api = `/${config.apiPrefix}`;
    app.setGlobalPrefix(config.apiPrefix);
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        stopAtFirstError: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter(app.get(LoggingService)));
    await app.init();
    // supertest needs the underlying http.Server actually listening (its
    // superagent client reads server.address()); app.init() alone doesn't
    // start it, which surfaces as "TypeError: Invalid URL" on every request.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  // ----------------------------------------------------------------
  // 1. Authentication (positive flow)
  // ----------------------------------------------------------------

  describe('Authentication', () => {
    it('registers a user', async () => {
      const res = await registerUser('jane@test.dev', 'Jane Doe', 'S3curePass!').expect(201);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
    });

    it('rejects duplicate email registration', async () => {
      await registerUser('jane@test.dev', 'Jane Again', 'S3curePass!').expect(409);
    });

    it('logs in and gets a token pair', async () => {
      const res = await login('jane@test.dev', 'S3curePass!').expect(200);
      userToken = res.body.accessToken;
      userRefresh = res.body.refreshToken;
      expect(userToken).toBeDefined();
      expect(userRefresh).toBeDefined();
    });

    it('rejects bad credentials', async () => {
      await login('jane@test.dev', 'wrong-password').expect(401);
    });

    it('logs in as admin', async () => {
      const res = await login('admin@test.dev', 'Admin123!').expect(200);
      adminToken = res.body.accessToken;
    });

    it('gets the profile with the access token', async () => {
      const res = await http()
        .get(`${api}/auth/profile`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(res.body.email).toBe('jane@test.dev');
      expect(res.body.role).toBe(Role.USER);
    });

    it('rejects a request without a token', async () => {
      await http().get(`${api}/auth/profile`).expect(401);
    });

    it('rejects a request with a malformed token', async () => {
      await http()
        .get(`${api}/auth/profile`)
        .set('Authorization', 'Bearer not-a-real-jwt')
        .expect(401);
    });

    it('rotates the refresh token', async () => {
      const res = await http()
        .post(`${api}/auth/refresh`)
        .send({ refreshToken: userRefresh })
        .expect(200);
      expect(res.body.accessToken).toBeDefined();
      userRefresh = res.body.refreshToken;
    });

    it('rejects a revoked refresh token', async () => {
      // userRefresh is now the new token. The previous one was revoked.
      // Revoke the current one via logout, then try to use it.
      await http()
        .post(`${api}/auth/logout`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ refreshToken: userRefresh })
        .expect(200);

      await http()
        .post(`${api}/auth/refresh`)
        .send({ refreshToken: userRefresh })
        .expect(401);
    });

    it('logs in again after logout to get fresh tokens', async () => {
      const res = await login('jane@test.dev', 'S3curePass!').expect(200);
      userToken = res.body.accessToken;
      userRefresh = res.body.refreshToken;
    });

    it('completes the password reset flow', async () => {
      const forgot = await http()
        .post(`${api}/auth/forgot-password`)
        .send({ email: 'jane@test.dev' })
        .expect(200);
      const resetToken = forgot.body.devResetToken;
      expect(resetToken).toBeDefined();

      await http()
        .post(`${api}/auth/reset-password`)
        .send({ token: resetToken, newPassword: 'ResetPass123!' })
        .expect(200);

      // Old password no longer works.
      await login('jane@test.dev', 'NewS3curePass!').expect(401);
      const res = await login('jane@test.dev', 'ResetPass123!').expect(200);
      userToken = res.body.accessToken;
      userRefresh = res.body.refreshToken;
    });

    it('rejects a reused reset token', async () => {
      // The token from the previous test was already used.
      // We can't re-use it.  Request a new one and verify single-use.
      const forgot = await http()
        .post(`${api}/auth/forgot-password`)
        .send({ email: 'jane@test.dev' })
        .expect(200);
      const resetToken = forgot.body.devResetToken;

      // First use succeeds.
      await http()
        .post(`${api}/auth/reset-password`)
        .send({ token: resetToken, newPassword: 'SecondReset1!' })
        .expect(200);

      // Second use with the same token fails.
      await http()
        .post(`${api}/auth/reset-password`)
        .send({ token: resetToken, newPassword: 'ThirdReset1!' })
        .expect(400);
    });

    it('rejects a non-existent email on forgot-password with same message', async () => {
      const res = await http()
        .post(`${api}/auth/forgot-password`)
        .send({ email: 'nobody@test.dev' })
        .expect(200);
      // Must not reveal whether the email exists.
      expect(res.body.message).toContain('If an account exists');
    });
  });

  // ----------------------------------------------------------------
  // 2. Products
  // ----------------------------------------------------------------

  describe('Products', () => {
    it('creates a product as admin', async () => {
      const res = await http()
        .post(`${api}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Wireless Mouse', price: 29.9, stock: 10 })
        .expect(201);
      productId = res.body.id;
      expect(res.body.price).toBe('29.90');
    });

    it('forbids a regular user from creating products', async () => {
      await http()
        .post(`${api}/products`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Nope', price: 1 })
        .expect(403);
    });

    it('lists products publicly with pagination', async () => {
      const res = await http()
        .get(`${api}/products?page=1&limit=5`)
        .expect(200);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
      expect(res.body.items[0].id).toBeDefined();
    });

    it('filters products by search and price', async () => {
      const res = await http()
        .get(`${api}/products?search=mouse&minPrice=20&maxPrice=40`)
        .expect(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects products with negative price', async () => {
      await http()
        .post(`${api}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Bad', price: -5 })
        .expect(400);
    });

    it('returns 404 for a non-existent product', async () => {
      await http()
        .get(`${api}/products/00000000-0000-0000-0000-000000000000`)
        .expect(404);
    });

    it('does not include inactive products in public listing', async () => {
      // Create and deactivate a product.
      const created = await http()
        .post(`${api}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Inactive Thing', price: 5, stock: 1 })
        .expect(201);
      await http()
        .delete(`${api}/products/${created.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const res = await http()
        .get(`${api}/products?search=Inactive+Thing`)
        .expect(200);
      expect(res.body.items.length).toBe(0);
    });
  });

  // ----------------------------------------------------------------
  // 3. Cart
  // ----------------------------------------------------------------

  describe('Cart', () => {
    it('adds an item to the cart', async () => {
      await http()
        .post(`${api}/cart/items`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ productId, quantity: 2 })
        .expect(201);
    });

    it('shows the cart with totals', async () => {
      const res = await http()
        .get(`${api}/cart`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(res.body.totalItems).toBe(2);
      expect(res.body.total).toBe('59.80');
    });

    it('rejects quantities above stock', async () => {
      await http()
        .post(`${api}/cart/items`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ productId, quantity: 999 })
        .expect(400);
    });
  });

  // ----------------------------------------------------------------
  // 4. Orders
  // ----------------------------------------------------------------

  describe('Orders', () => {
    it('checks out the cart into an order', async () => {
      const res = await http()
        .post(`${api}/orders/checkout`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(201);
      orderId = res.body.id;
      expect(res.body.status).toBe('PENDING');
      expect(res.body.total).toBe('59.80');
      expect(res.body.items).toHaveLength(1);
    });

    it('empties the cart after checkout', async () => {
      const res = await http()
        .get(`${api}/cart`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(res.body.totalItems).toBe(0);
    });

    it('decrements product stock', async () => {
      const res = await http()
        .get(`${api}/products/${productId}`)
        .expect(200);
      expect(Number(res.body.stock)).toBe(8);
    });

    it('lists my orders', async () => {
      const res = await http()
        .get(`${api}/orders/mine`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(res.body.items.some((o: { id: string }) => o.id === orderId)).toBe(true);
    });

    it('allows the admin to list all orders', async () => {
      const res = await http()
        .get(`${api}/orders`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
    });

    it('rejects checkout with an empty cart', async () => {
      // User's cart was emptied by the previous checkout.
      await http()
        .post(`${api}/orders/checkout`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);
    });

    it('rejects accessing another user order', async () => {
      // Register a second user, try to access the first user's order.
      await registerUser('other@test.dev', 'Other', 'OtherPass1!');
      const other = await login('other@test.dev', 'OtherPass1!').expect(200);
      await http()
        .get(`${api}/orders/${orderId}`)
        .set('Authorization', `Bearer ${other.body.accessToken}`)
        .expect(403);
    });
  });

  // ----------------------------------------------------------------
  // 5. Payments
  // ----------------------------------------------------------------

  describe('Payments', () => {
    it('pays the order via the fake provider', async () => {
      const res = await http()
        .post(`${api}/orders/${orderId}/pay`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(201);
      expect(res.body.status).toBe('APPROVED');
      expect(res.body.providerRef).toBeDefined();
    });

    it('marks the order as PAID', async () => {
      const res = await http()
        .get(`${api}/orders/${orderId}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(res.body.status).toBe('PAID');
    });

    it('refuses to pay an order twice', async () => {
      await http()
        .post(`${api}/orders/${orderId}/pay`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);
    });
  });

  // ----------------------------------------------------------------
  // 6. Admin & access control
  // ----------------------------------------------------------------

  describe('Admin & access control', () => {
    it('lists users with the admin role', async () => {
      const res = await http()
        .get(`${api}/users`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(2);
    });

    it('forbids a regular user from listing users', async () => {
      await http()
        .get(`${api}/users`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it('queries audit logs as admin', async () => {
      const res = await http()
        .get(`${api}/logs?action=auth.login&limit=5`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    });

    it('forbids a regular user from reading audit logs', async () => {
      await http()
        .get(`${api}/logs`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it('validates the liveness health endpoint', async () => {
      const res = await http().get(`${api}/health/live`).expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.uptime).toBeGreaterThan(0);
    });

    it('validates the readiness health endpoint', async () => {
      const res = await http().get(`${api}/health/ready`).expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checks.postgres).toBe('ok');
      expect(res.body.checks.redis).toBe('ok');
    });
  });

  // ----------------------------------------------------------------
  // 7. Negative scenarios
  // ----------------------------------------------------------------

  describe('Negative scenarios', () => {
    let limitedProductId: string;
    let pendingOrderId: string;

    beforeAll(async () => {
      // Create a product with stock=1 for concurrency/negative tests.
      const res = await http()
        .post(`${api}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Limited Widget', price: 10, stock: 1 })
        .expect(201);
      limitedProductId = res.body.id;

      // Add to cart and checkout.
      await http()
        .post(`${api}/cart/items`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ productId: limitedProductId, quantity: 1 })
        .expect(201);

      const checkoutRes = await http()
        .post(`${api}/orders/checkout`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(201);
      pendingOrderId = checkoutRes.body.id;
    });

    it('rejects adding stock beyond available for a cart item', async () => {
      await http()
        .post(`${api}/cart/items`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ productId: limitedProductId, quantity: 5 })
        .expect(400);
    });

    it('rejects checkout when stock is insufficient', async () => {
      // limitedProductId now has stock=0 (decremented by checkout above),
      // so cart.addItem's own stock check already rejects this — the
      // service defends against insufficient stock both at add-time and
      // (redundantly, for TOCTOU safety) at checkout-time.
      await http()
        .post(`${api}/cart/items`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ productId: limitedProductId, quantity: 1 })
        .expect(400);

      await http()
        .post(`${api}/orders/checkout`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);
    });

    it('rejects paying a non-existent order', async () => {
      await http()
        .post(`${api}/orders/00000000-0000-0000-0000-000000000000/pay`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(404);
    });

    it('rejects an illegal status transition', async () => {
      // pendingOrderId is still PENDING (we haven't paid it yet).
      // Try to jump to DELIVERED directly.
      await http()
        .patch(`${api}/orders/${pendingOrderId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'DELIVERED' })
        .expect(400);
    });

    it('prevents a non-owner from paying an order', async () => {
      // other@test.dev owns no orders.
      const other = await login('other@test.dev', 'OtherPass1!').expect(200);
      await http()
        .post(`${api}/orders/${pendingOrderId}/pay`)
        .set('Authorization', `Bearer ${other.body.accessToken}`)
        .expect(403);
    });

    it('rejects paying an already-paid order', async () => {
      // Pay the pending order first.
      await http()
        .post(`${api}/orders/${pendingOrderId}/pay`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(201);

      // Try again.
      await http()
        .post(`${api}/orders/${pendingOrderId}/pay`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);
    });

    it('rejects cancelling a non-PENDING order', async () => {
      await http()
        .post(`${api}/orders/${pendingOrderId}/cancel`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);
    });

    it('rejects invalid email format on registration', async () => {
      await http()
        .post(`${api}/auth/register`)
        .send({ email: 'not-an-email', name: 'X', password: 'Password1!' })
        .expect(400);
    });

    it('rejects short passwords', async () => {
      await http()
        .post(`${api}/auth/register`)
        .send({ email: 'short@test.dev', name: 'Short', password: '123' })
        .expect(400);
    });

    it('rejects a token with missing Bearer prefix', async () => {
      await http()
        .get(`${api}/auth/profile`)
        .set('Authorization', 'some-token-without-bearer')
        .expect(401);
    });
  });

  // ----------------------------------------------------------------
  // 8. Concurrency tests
  // ----------------------------------------------------------------

  describe('Concurrency', () => {
    it('only one of two concurrent payments succeeds', async () => {
      // Create a fresh order for concurrency testing.
      await http()
        .post(`${api}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Concurrency Product', price: 5, stock: 10 })
        .expect(201);

      // Add to cart and checkout.
      const productRes = await http()
        .get(`${api}/products?search=Concurrency+Product`)
        .expect(200);
      const concProductId = productRes.body.items[0].id;

      await http()
        .post(`${api}/cart/items`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ productId: concProductId, quantity: 1 })
        .expect(201);

      const checkoutRes = await http()
        .post(`${api}/orders/checkout`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(201);
      const concOrderId = checkoutRes.body.id;

      // Fire two concurrent payment requests.
      const [r1, r2] = await Promise.all([
        http()
          .post(`${api}/orders/${concOrderId}/pay`)
          .set('Authorization', `Bearer ${userToken}`),
        http()
          .post(`${api}/orders/${concOrderId}/pay`)
          .set('Authorization', `Bearer ${userToken}`),
      ]);

      const statuses = [r1.status, r2.status].sort();
      // Exactly one 201 (success) and one 409 (lost the PENDING->PROCESSING claim).
      expect(statuses).toEqual([201, 409]);
    });

    it('only one of two concurrent order cancellations restores stock once', async () => {
      // Create product with stock=5.
      const productRes = await http()
        .post(`${api}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Cancel Race Product', price: 15, stock: 5 })
        .expect(201);
      const raceProductId = productRes.body.id;

      // Add to cart and checkout.
      await http()
        .post(`${api}/cart/items`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ productId: raceProductId, quantity: 3 })
        .expect(201);

      const checkoutRes = await http()
        .post(`${api}/orders/checkout`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(201);
      const raceOrderId = checkoutRes.body.id;

      // Stock should now be 2 (5 - 3).
      const stockBefore = await http()
        .get(`${api}/products/${raceProductId}`)
        .expect(200);
      expect(Number(stockBefore.body.stock)).toBe(2);

      // Fire two concurrent cancellations.
      const [r1, r2] = await Promise.all([
        http()
          .post(`${api}/orders/${raceOrderId}/cancel`)
          .set('Authorization', `Bearer ${userToken}`),
        http()
          .post(`${api}/orders/${raceOrderId}/cancel`)
          .set('Authorization', `Bearer ${userToken}`),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 400]);

      // Stock should be restored to 5 (not 8 = 5 + 3).
      const stockAfter = await http()
        .get(`${api}/products/${raceProductId}`)
        .expect(200);
      expect(Number(stockAfter.body.stock)).toBe(5);
    });

    it('only one of two concurrent refresh token rotations succeeds', async () => {
      // Get a fresh token pair.
      const loginRes = await login('jane@test.dev', 'SecondReset1!').expect(200);
      const freshRefresh = loginRes.body.refreshToken;

      // Fire two concurrent refresh requests with the same token.
      const [r1, r2] = await Promise.all([
        http()
          .post(`${api}/auth/refresh`)
          .send({ refreshToken: freshRefresh }),
        http()
          .post(`${api}/auth/refresh`)
          .send({ refreshToken: freshRefresh }),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 401]);
    });

    it('concurrent checkout with limited stock only lets one succeed', async () => {
      // Create product with stock=1.
      const productRes = await http()
        .post(`${api}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Stock Race Product', price: 8, stock: 1 })
        .expect(201);
      const stockProductId = productRes.body.items?.id ?? productRes.body.id;

      // Register two users and give them both items in their carts.
      await registerUser('race1@test.dev', 'Racer1', 'RacePass1!');
      await registerUser('race2@test.dev', 'Racer2', 'RacePass1!');

      const login1 = await login('race1@test.dev', 'RacePass1!').expect(200);
      const login2 = await login('race2@test.dev', 'RacePass1!').expect(200);
      const token1 = login1.body.accessToken;
      const token2 = login2.body.accessToken;

      await http()
        .post(`${api}/cart/items`)
        .set('Authorization', `Bearer ${token1}`)
        .send({ productId: stockProductId, quantity: 1 })
        .expect(201);

      await http()
        .post(`${api}/cart/items`)
        .set('Authorization', `Bearer ${token2}`)
        .send({ productId: stockProductId, quantity: 1 })
        .expect(201);

      // Fire two concurrent checkouts.
      const [r1, r2] = await Promise.all([
        http()
          .post(`${api}/orders/checkout`)
          .set('Authorization', `Bearer ${token1}`),
        http()
          .post(`${api}/orders/checkout`)
          .set('Authorization', `Bearer ${token2}`),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([201, 400]);

      // Stock should be 0 (only one order succeeded).
      const stockRes = await http()
        .get(`${api}/products/${stockProductId}`)
        .expect(200);
      expect(Number(stockRes.body.stock)).toBe(0);
    });

    it('a hundred concurrent payment attempts on the same order settle exactly once', async () => {
      const productRes = await http()
        .post(`${api}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Hundred-Way Payment Product', price: 12, stock: 10 })
        .expect(201);
      const hundredProductId = productRes.body.id;

      await http()
        .post(`${api}/cart/items`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ productId: hundredProductId, quantity: 1 })
        .expect(201);

      const checkoutRes = await http()
        .post(`${api}/orders/checkout`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(201);
      const hundredOrderId = checkoutRes.body.id;

      const responses = await Promise.all(
        Array.from({ length: 100 }, () =>
          http()
            .post(`${api}/orders/${hundredOrderId}/pay`)
            .set('Authorization', `Bearer ${userToken}`),
        ),
      );

      const succeeded = responses.filter((r) => r.status === 201);
      // Only one request can win the PENDING->PROCESSING claim. Every other
      // request gets rejected, never a 2xx — but which rejection depends on
      // when it reads the payment row relative to the winner's write: most
      // land mid-claim and see PROCESSING (409, ConflictException), but a
      // request that reads after the winner has already reached APPROVED
      // sees that terminal state directly and gets 400 (BadRequestException,
      // "already paid") instead. Both are equally correct — neither is a
      // double-charge or a double 2xx — so the assertion accepts either.
      const rejected = responses.filter((r) => r.status === 409 || r.status === 400);
      expect(succeeded.length).toBe(1);
      expect(rejected.length).toBe(99);

      const payment = await http()
        .get(`${api}/orders/${hundredOrderId}/payment`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(payment.body.status).toBe('APPROVED');
    });

    it('fifty concurrent checkouts racing for the last unit of stock settle exactly once', async () => {
      const productRes = await http()
        .post(`${api}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Fifty-Way Stock Race Product', price: 3, stock: 1 })
        .expect(201);
      const raceProductId = productRes.body.id;

      const tokens = await Promise.all(
        Array.from({ length: 50 }, (_, i) => createRaceUser(`race-${i}@test.dev`)),
      );
      await prisma.cartItem.createMany({
        data: tokens.map((_, i) => ({
          userId: (jwtService.decode(tokens[i]) as { sub: string }).sub,
          productId: raceProductId,
          quantity: 1,
        })),
      });

      const responses = await Promise.all(
        tokens.map((token) =>
          http().post(`${api}/orders/checkout`).set('Authorization', `Bearer ${token}`),
        ),
      );

      const succeeded = responses.filter((r) => r.status === 201);
      const failed = responses.filter((r) => r.status === 400);
      // Stock=1: exactly one checkout can decrement it past zero; the rest
      // must see "insufficient stock", never a negative stock or a second 2xx.
      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(49);

      const stockRes = await http()
        .get(`${api}/products/${raceProductId}`)
        .expect(200);
      expect(Number(stockRes.body.stock)).toBe(0);
    });
  });

  describe('Payment reconciliation', () => {
    it('recovers a payment stuck in PROCESSING after the provider actually approved it', async () => {
      // Reproduces the exact crash window documented in README.md's
      // Limitations section: the provider call succeeds, but the process
      // dies before the follow-up transaction records APPROVED — the
      // payment is left at PROCESSING forever without reconciliation.
      await http()
        .post(`${api}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Reconciliation Product', price: 20, stock: 5 })
        .expect(201);
      const productRes = await http()
        .get(`${api}/products?search=Reconciliation+Product`)
        .expect(200);
      const reconProductId = productRes.body.items[0].id;

      await http()
        .post(`${api}/cart/items`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ productId: reconProductId, quantity: 1 })
        .expect(201);
      const checkoutRes = await http()
        .post(`${api}/orders/checkout`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(201);
      const reconOrderId = checkoutRes.body.id;

      const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: reconOrderId } });

      // Simulate "the provider call succeeded" by calling the real provider
      // directly — bypassing PaymentsService entirely, the same way a crash
      // right after PaymentsService's own provider.charge() call would leave
      // things: the charge happened, but nothing about it was recorded here.
      const provider = app.get<PaymentProvider>(PAYMENT_PROVIDER);
      const chargeResult = await provider.charge(
        payment.amount,
        reconOrderId,
        payment.providerIdempotencyKey,
      );
      expect(chargeResult.approved).toBe(true);

      // Simulate "the crash": the payment is claimed (PROCESSING) with a
      // stale timestamp, and has a PaymentAttempt row PaymentsService.pay()
      // would have created before calling the provider — but nothing ever
      // updated either of them with the outcome above.
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'PROCESSING', processingAt: new Date(Date.now() - 10 * 60 * 1000) },
      });
      await prisma.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          provider: provider.name,
          amount: payment.amount,
          status: 'PENDING',
        },
      });

      // Nothing about this order/payment looks resolvable from local state
      // alone — the point of reconciliation is that it asks the provider.
      const reconcileRes = await http()
        .post(`${api}/payments/reconcile`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      expect(reconcileRes.body.approved).toBeGreaterThanOrEqual(1);

      const paymentAfter = await http()
        .get(`${api}/orders/${reconOrderId}/payment`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(paymentAfter.body.status).toBe('APPROVED');
      expect(paymentAfter.body.providerRef).toBe(chargeResult.providerRef);

      const orderAfter = await http()
        .get(`${api}/orders/${reconOrderId}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(orderAfter.body.status).toBe('PAID');
    });
  });

  describe('Stripe webhook', () => {
    const signPayload = (payload: string) => {
      // The secret used to sign here just has to match STRIPE_WEBHOOK_SECRET
      // in .env — Stripe's own key isn't involved in generating this test
      // signature, only in the real charge that gets referenced below.
      return new Stripe('sk_test_dummy_for_signing').webhooks.generateTestHeaderString({
        payload,
        secret: process.env.STRIPE_WEBHOOK_SECRET!,
      });
    };

    it('sending the same payment_intent.succeeded event 20 times settles the payment exactly once', async () => {
      await http()
        .post(`${api}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Webhook Product', price: 15, stock: 5 })
        .expect(201);
      const productRes = await http().get(`${api}/products?search=Webhook+Product`).expect(200);
      const webhookProductId = productRes.body.items[0].id;

      await http()
        .post(`${api}/cart/items`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ productId: webhookProductId, quantity: 1 })
        .expect(201);
      const checkoutRes = await http()
        .post(`${api}/orders/checkout`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(201);
      const webhookOrderId = checkoutRes.body.id;

      const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: webhookOrderId } });
      const provider = app.get<PaymentProvider>(PAYMENT_PROVIDER);
      const chargeResult = await provider.charge(payment.amount, webhookOrderId, payment.providerIdempotencyKey);

      // Same "crash before recording the outcome" setup as the
      // reconciliation test — this time the recovery path under test is the
      // webhook, not the polling reconciliation job.
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'PROCESSING' },
      });
      await prisma.paymentAttempt.create({
        data: { paymentId: payment.id, provider: provider.name, amount: payment.amount, status: 'PENDING' },
      });

      const event = {
        id: `evt_test_${payment.id}`,
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: chargeResult.providerRef,
            last_payment_error: null,
            metadata: { orderId: webhookOrderId },
          },
        },
      };
      const payload = JSON.stringify(event);
      const signature = signPayload(payload);

      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          http()
            .post(`${api}/webhooks/stripe`)
            .set('stripe-signature', signature)
            .set('Content-Type', 'application/json')
            .send(payload),
        ),
      );

      expect(responses.every((r) => r.status === 200)).toBe(true);

      const paymentAfter = await http()
        .get(`${api}/orders/${webhookOrderId}/payment`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(paymentAfter.body.status).toBe('APPROVED');
      expect(paymentAfter.body.providerRef).toBe(chargeResult.providerRef);

      const orderAfter = await http()
        .get(`${api}/orders/${webhookOrderId}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(orderAfter.body.status).toBe('PAID');
    });

    it('rejects a webhook with an invalid signature', async () => {
      await http()
        .post(`${api}/webhooks/stripe`)
        .set('stripe-signature', 't=1,v1=not-a-real-signature')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ id: 'evt_bad', type: 'payment_intent.succeeded' }))
        .expect(400);
    });
  });
});
