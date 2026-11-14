import { Injectable } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { randomBytes } from 'crypto';
import { PaymentProvider, PaymentResult, PaymentStatusResult } from './payment-provider.interface';
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  private readonly charges = new Map<string, PaymentResult>();
  async charge(
    _amount: Decimal,
    reference: string,
    idempotencyKey: string,
  ): Promise<PaymentResult> {
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
