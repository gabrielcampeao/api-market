import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';

// Global: PaymentsService, PaymentReconciliationService, StripeWebhookService
// and StripePaymentProvider all record metrics directly rather than going
// through an interceptor (their outcomes — approved/declined/reconciled/
// duplicate — aren't visible from the HTTP layer alone), so MetricsService
// needs to be injectable everywhere without every consuming module
// importing MetricsModule explicitly.
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
