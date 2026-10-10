import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost:5432/app',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
  };

  it('rejects Stripe secret without webhook secret', () => {
    expect(() =>
      validateEnv({
        ...base,
        STRIPE_SECRET_KEY: 'sk_test_1234567890abcdef',
      }),
    ).toThrow('STRIPE_WEBHOOK_SECRET must be set when STRIPE_SECRET_KEY is configured.');
  });

  it('accepts Stripe secret when webhook secret is present', () => {
    expect(
      validateEnv({
        ...base,
        STRIPE_SECRET_KEY: 'sk_test_1234567890abcdef',
        STRIPE_WEBHOOK_SECRET: 'whsec_1234567890abcdef',
      }),
    ).toMatchObject({
      STRIPE_SECRET_KEY: 'sk_test_1234567890abcdef',
      STRIPE_WEBHOOK_SECRET: 'whsec_1234567890abcdef',
    });
  });
});
