import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { LoggingService } from './logging/logging.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { apolloSandboxLandingPage } from './graphql/apollo-sandbox-landing-page.middleware';
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const config = app.get(AppConfigService);
  const logger = app.get(LoggingService);
  app.useLogger(logger);
  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }
  app.use(config.isProduction ? helmet() : helmet({ contentSecurityPolicy: false }));
  if (!config.isProduction) {
    app.use('/graphql', apolloSandboxLandingPage());
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
