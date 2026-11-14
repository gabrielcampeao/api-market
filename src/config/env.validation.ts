export interface EnvConfig {
  NODE_ENV: string;
  PORT: number;
  API_PREFIX: string;
  CORS_ORIGINS: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  JWT_ACCESS_SECRET: string;
  JWT_ACCESS_TTL: string;
  JWT_REFRESH_SECRET: string;
  JWT_REFRESH_TTL_DAYS: number;
  THROTTLE_TTL_MS: number;
  THROTTLE_LIMIT: number;
  THROTTLE_AUTH_LIMIT: number;
  ADMIN_EMAIL: string;
  ADMIN_PASSWORD: string;
  ADMIN_NAME: string;
  TRUST_PROXY: boolean;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}
function toInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const required = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
  for (const key of required) {
    if (!config[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }
  const nodeEnv = (config.NODE_ENV as string) ?? 'development';
  const isProduction = nodeEnv === 'production';
  if (isProduction) {
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
      const val = config[key] as string;
      if (val && /(change-me|changeme|dev-|secret|password)/i.test(val)) {
        throw new Error(`${key} is too weak for production. Use a long random string.`);
      }
      if (val && val.length < 32) {
        throw new Error(`${key} must be at least 32 characters in production.`);
      }
    }
    if (!config.ADMIN_PASSWORD) {
      throw new Error('ADMIN_PASSWORD must be set explicitly in production (no default allowed).');
    }
    const corsOrigins = config.CORS_ORIGINS as string | undefined;
    if (
      corsOrigins
        ?.split(',')
        .map((o) => o.trim())
        .includes('*')
    ) {
      throw new Error('CORS_ORIGINS must not include "*" in production (credentials are enabled).');
    }
  }
  const stripeSecretKey = config.STRIPE_SECRET_KEY as string | undefined;
  const stripeWebhookSecret = config.STRIPE_WEBHOOK_SECRET as string | undefined;
  if (stripeSecretKey && !stripeWebhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET must be set when STRIPE_SECRET_KEY is configured.');
  }
  return {
    NODE_ENV: nodeEnv,
    PORT: toInt(config.PORT, 3000),
    API_PREFIX: (config.API_PREFIX as string) ?? 'api',
    CORS_ORIGINS: (config.CORS_ORIGINS as string) ?? 'http://localhost:3000',
    DATABASE_URL: config.DATABASE_URL as string,
    REDIS_URL: (config.REDIS_URL as string) ?? 'redis://localhost:6379',
    JWT_ACCESS_SECRET: config.JWT_ACCESS_SECRET as string,
    JWT_ACCESS_TTL: (config.JWT_ACCESS_TTL as string) ?? '15m',
    JWT_REFRESH_SECRET: config.JWT_REFRESH_SECRET as string,
    JWT_REFRESH_TTL_DAYS: toInt(config.JWT_REFRESH_TTL_DAYS, 7),
    THROTTLE_TTL_MS: toInt(config.THROTTLE_TTL_MS, 60000),
    THROTTLE_LIMIT: toInt(config.THROTTLE_LIMIT, 60),
    THROTTLE_AUTH_LIMIT: toInt(config.THROTTLE_AUTH_LIMIT, 20),
    ADMIN_EMAIL: (config.ADMIN_EMAIL as string) ?? 'admin@marketplace.dev',
    ADMIN_PASSWORD: (config.ADMIN_PASSWORD as string) ?? 'Admin123!',
    ADMIN_NAME: (config.ADMIN_NAME as string) ?? 'Admin',
    TRUST_PROXY: config.TRUST_PROXY === 'true',
    STRIPE_SECRET_KEY: stripeSecretKey,
    STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
  };
}
