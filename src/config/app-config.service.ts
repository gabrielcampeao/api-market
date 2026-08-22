import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from './env.validation';

@Injectable()
export class AppConfigService {
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  readonly port: number;
  readonly apiPrefix: string;
  readonly corsOrigins: string[];
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly jwt: {
    accessSecret: string;
    accessTtl: string;
    refreshSecret: string;
    refreshTtlDays: number;
  };
  readonly throttle: {
    ttlMs: number;
    limit: number;
    authLimit: number;
  };
  readonly trustProxy: boolean;

  constructor(config: ConfigService<EnvConfig, true>) {
    const env = config.get('NODE_ENV', { infer: true });
    this.nodeEnv = env;
    this.isProduction = env === 'production';
    this.port = config.get('PORT', { infer: true });
    this.apiPrefix = config.get('API_PREFIX', { infer: true });
    this.corsOrigins = config
      .get('CORS_ORIGINS', { infer: true })
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    this.databaseUrl = config.get('DATABASE_URL', { infer: true });
    this.redisUrl = config.get('REDIS_URL', { infer: true });
    this.jwt = {
      accessSecret: config.get('JWT_ACCESS_SECRET', { infer: true }),
      accessTtl: config.get('JWT_ACCESS_TTL', { infer: true }),
      refreshSecret: config.get('JWT_REFRESH_SECRET', { infer: true }),
      refreshTtlDays: config.get('JWT_REFRESH_TTL_DAYS', { infer: true }),
    };
    this.throttle = {
      ttlMs: config.get('THROTTLE_TTL_MS', { infer: true }),
      limit: config.get('THROTTLE_LIMIT', { infer: true }),
      authLimit: config.get('THROTTLE_AUTH_LIMIT', { infer: true }),
    };
    this.trustProxy = config.get('TRUST_PROXY', { infer: true });
  }
}
