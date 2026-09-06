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

  const prodBase = {
    ...base,
    NODE_ENV: 'production',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    ADMIN_PASSWORD: 'a-real-admin-password',
  };

  it('rejects CORS_ORIGINS of "*" in production', () => {
    expect(() => validateEnv({ ...prodBase, CORS_ORIGINS: '*' })).toThrow(
      'CORS_ORIGINS must not include "*" in production (credentials are enabled).',
    );
  });

  it('rejects "*" mixed into a CORS_ORIGINS list in production', () => {
    expect(() => validateEnv({ ...prodBase, CORS_ORIGINS: 'https://app.example.com,*' })).toThrow(
      'CORS_ORIGINS must not include "*" in production (credentials are enabled).',
    );
  });

  it('accepts an explicit origin list in production', () => {
    expect(validateEnv({ ...prodBase, CORS_ORIGINS: 'https://app.example.com' })).toMatchObject({
      CORS_ORIGINS: 'https://app.example.com',
    });
  });
});
