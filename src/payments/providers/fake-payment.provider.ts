import { Injectable } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { randomBytes } from 'crypto';
import { PaymentProvider, PaymentResult } from './payment-provider.interface';

/**
 * Simulated payment provider.
 *
 * Always approves charges. To simulate an external provider behind this seam,
 * implement PaymentProvider and swap the provider in PaymentsModule.
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';

  async charge(_amount: Decimal, reference: string, _idempotencyKey: string): Promise<PaymentResult> {
    // Simulated gateway latency.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      approved: true,
      providerRef: `fake_${reference.slice(0, 8)}_${randomBytes(6).toString('hex')}`,
    };
  }
}
