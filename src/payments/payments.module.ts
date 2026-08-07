import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { FakePaymentProvider } from './providers/fake-payment.provider';

@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    // Swap the provider here (e.g. a StripePaymentProvider) when a real
    // gateway is integrated — nothing outside this module needs to change.
    { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
