import { join } from 'path';
import { existsSync } from 'fs';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule as EnvConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { GraphQLFormattedError } from 'graphql';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';

import { validateEnv } from './config/env.validation';
import { AppConfigModule } from './config/app-config.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { LoggingModule } from './logging/logging.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { CartModule } from './cart/cart.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { LogsModule } from './logs/logs.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { MetricsModule } from './metrics/metrics.module';
import { GraphqlApiModule } from './graphql/graphql-api.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { AppConfigService } from './config/app-config.service';

import { HealthController } from './app.controller';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ThrottlerBehindProxyGuard } from './common/guards/throttler-behind-proxy.guard';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { createThrottlerStorage } from './throttler/throttler-storage.factory';
import { ThrottlerRedisLike } from './throttler/redis-throttler.storage';

@Module({
  imports: [
    EnvConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    MetricsModule,
    AppConfigModule,
    PrismaModule,
    RedisModule,
    LoggingModule,
    MailModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService, 'REDIS_CLIENT'],
      useFactory: async (config: AppConfigService, redis: ThrottlerRedisLike) => {
        const storage = await createThrottlerStorage(redis);
        return {
          throttlers: [
            {
              name: 'default',
              ttl: config.throttle.ttlMs,
              limit: config.throttle.limit,
            },
            {
              name: 'auth',
              ttl: config.throttle.ttlMs,
              limit: config.throttle.authLimit,
            },
          ],
          storage,
        };
      },
    }),
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        // The compiled Docker image ships only `dist/` and runs as a
        // non-root user with no write access to `/app`, so it builds the
        // schema in-memory; only a local ts-node run (where `src/` exists
        // and is writable) writes the .gql file to disk for editor tooling.
        autoSchemaFile: existsSync(join(process.cwd(), 'src'))
          ? join(process.cwd(), 'src/graphql/schema.gql')
          : true,
        sortSchema: true,
        // Landing page exploration is fine for local/dev but shouldn't hand
        // out the full schema in production — same rationale as gating
        // Swagger in main.ts.
        introspection: !config.isProduction,
        // The dev landing page (Apollo Sandbox) is served instead by
        // apolloSandboxLandingPage() in main.ts, an Express middleware
        // registered ahead of this module's own /graphql route. Two things
        // rule out doing this through ApolloDriverConfig directly:
        // @nestjs/apollo always injects its own landing-page plugin
        // (graphiql/playground/disabled) regardless of these settings, and
        // Apollo Server hard-errors when two plugins implement
        // renderLandingPage; and importing the Sandbox plugin from
        // `@apollo/server/plugin/landingPage/default` triggers a dual
        // cjs/esm type-resolution conflict under ts-jest that broke the e2e
        // suite's typecheck.
        graphiql: false,
        playground: false,
        context: ({ req, res }: { req: unknown; res: unknown }) => ({ req, res }),
        // Same policy as AllExceptionsFilter for REST: never leak a stack
        // trace, and collapse anything that isn't a recognized HttpException
        // (i.e. an unexpected 5xx) down to a generic message.
        formatError: (formatted: GraphQLFormattedError, error: unknown) => {
          const original = (error as { originalError?: unknown })?.originalError ?? error;
          const status =
            original && typeof original === 'object' && 'getStatus' in original
              ? (original as { getStatus: () => number }).getStatus()
              : undefined;
          const { stacktrace: _stacktrace, ...extensions } = formatted.extensions ?? {};
          if (status === undefined || status >= 500) {
            return {
              message: 'Internal server error',
              locations: formatted.locations,
              path: formatted.path,
              extensions,
            };
          }
          return { ...formatted, extensions };
        },
      }),
    }),
    AuthModule,
    UsersModule,
    ProductsModule,
    CartModule,
    OrdersModule,
    PaymentsModule,
    LogsModule,
    GraphqlApiModule,
    IdempotencyModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerBehindProxyGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
