import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { LoggingService } from './logging/logging.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { localGraphiqlLandingPage } from './graphql/local-graphiql-landing-page.middleware';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Needed for the Stripe webhook route: signature verification is done
    // against the exact raw request bytes, which the global JSON body
    // parser would otherwise have already parsed and re-serialized (losing
    // the byte-for-byte fidelity signature verification needs).
    rawBody: true,
  });

  const config = app.get(AppConfigService);
  const logger = app.get(LoggingService);

  app.useLogger(logger);
  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }
  // helmet's default CSP (`script-src 'self'`, no inline scripts) silently
  // blocks the GraphiQL landing page served at GET /graphql in
  // non-production (see app.module.ts): it needs an inline <script> to
  // mount, so the page would hang on "Loading..." with no visible error.
  // GraphiQL is dev-only tooling with no production exposure (the landing
  // page is disabled entirely there), so we just skip CSP outside
  // production rather than punch an inline-script hole into it; production
  // keeps the strict default CSP untouched.
  app.use(config.isProduction ? helmet() : helmet({ contentSecurityPolicy: false }));
  if (!config.isProduction) {
    // Vendored copies of the React/GraphiQL bundles localGraphiqlLandingPage()
    // renders below — served locally instead of from unpkg.com so the page
    // works offline / behind a firewall.
    app.useStaticAssets(join(process.cwd(), 'public', 'graphiql-vendor'), {
      prefix: '/graphiql-assets',
    });
    // Must be registered before app.listen() below: that's what triggers
    // GraphQLModule.onModuleInit(), which is what actually mounts Apollo's
    // own /graphql middleware. Express matches middleware in registration
    // order, so this always gets first look at the route.
    app.use('/graphql', localGraphiqlLandingPage());
  }
  app.setGlobalPrefix(config.apiPrefix);
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.enableShutdownHooks();

  // Swagger exposes the full route/DTO surface (including admin-only
  // endpoints) with zero auth — fine for local/dev use, but not something
  // to leave publicly reachable on a production deployment.
  if (!config.isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Marketplace API')
      .setDescription(
        'Marketplace with users, authentication (JWT + refresh token), products, ' +
          'cart, orders and simulated payments. Access token: use the <code>Bearer</code> scheme.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('auth', 'Authentication & account management')
      .addTag('users', 'User profile and administration')
      .addTag('products', 'Product catalog and stock')
      .addTag('cart', 'Shopping cart')
      .addTag('orders', 'Orders and checkout')
      .addTag('payments', 'Simulated payments')
      .addTag('logs', 'Audit logs (admin)')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, { useGlobalPrefix: false });
    logger.log(`Swagger documentation available at /docs`);
  }

  await app.listen(config.port);
  logger.log(`Marketplace API listening on port ${config.port}`);
}

void bootstrap().catch((error: unknown) => {
  console.error('Failed to bootstrap the application:', error);
  process.exit(1);
});
