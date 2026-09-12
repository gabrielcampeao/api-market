import { Injectable } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { randomBytes } from 'crypto';
import { PaymentProvider, PaymentResult, PaymentStatusResult } from './payment-provider.interface';

/**
 * Simulated payment provider.
 *
 * Always approves charges. To simulate an external provider behind this seam,
 * implement PaymentProvider and swap the provider in PaymentsModule.
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';

  // Keyed by idempotencyKey, mirroring how a real provider would dedupe a
  // repeated charge — checkStatus reads from this instead of an in-memory
  // "always approved" shortcut, so a payment PaymentsService never told this
  // map about (simulating a crash before the charge call even returned)
  // correctly comes back as 'unknown', not a guessed answer.
  private readonly charges = new Map<string, PaymentResult>();

  async charge(_amount: Decimal, reference: string, idempotencyKey: string): Promise<PaymentResult> {
    // Simulated gateway latency.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result: PaymentResult = {
      approved: true,
      providerRef: `fake_${reference.slice(0, 8)}_${randomBytes(6).toString('hex')}`,
    };
    this.charges.set(idempotencyKey, result);
    return result;
  }

  async checkStatus(
    _amount: Decimal,
    _reference: string,
    idempotencyKey: string,
  ): Promise<PaymentStatusResult> {
    const result = this.charges.get(idempotencyKey);
    if (!result) {
      return { status: 'unknown' };
    }
    return result.approved
      ? { status: 'approved', providerRef: result.providerRef }
      : {
          status: 'declined',
          providerRef: result.providerRef,
          failureCode: result.failureCode,
          message: result.message,
        };
  }
}
