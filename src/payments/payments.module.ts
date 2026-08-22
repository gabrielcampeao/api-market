import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { FakePaymentProvider } from './providers/fake-payment.provider';
import { StripePaymentProvider } from './providers/stripe-payment.provider';
import { AppConfigService } from '../config/app-config.service';

@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentReconciliationService,
    FakePaymentProvider,
    StripePaymentProvider,
    {
      provide: PAYMENT_PROVIDER,
      // Same fallback shape as ThrottlerStorageFactory falling back to
      // in-memory when Redis is unreachable: the app stays usable (with the
      // fake gateway) instead of failing to boot when STRIPE_SECRET_KEY
      // isn't configured.
      useFactory: (config: AppConfigService, stripe: StripePaymentProvider, fake: FakePaymentProvider) =>
        config.stripeSecretKey ? stripe : fake,
      inject: [AppConfigService, StripePaymentProvider, FakePaymentProvider],
    },
  ],
  exports: [PaymentsService, PAYMENT_PROVIDER],
})
export class PaymentsModule {}
