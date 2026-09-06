import { Decimal } from '@prisma/client/runtime/library';
export interface PaymentResult {
  approved: boolean;
  providerRef?: string;
  failureCode?: string;
  message?: string;
}
export type PaymentStatusResult =
  | {
      status: 'approved';
      providerRef?: string;
    }
  | {
      status: 'declined';
      providerRef?: string;
      failureCode?: string;
      message?: string;
    }
  | {
      status: 'unknown';
    };
export interface PaymentProvider {
  readonly name: string;
  charge(amount: Decimal, reference: string, idempotencyKey: string): Promise<PaymentResult>;
  checkStatus(
    amount: Decimal,
    reference: string,
    idempotencyKey: string,
  ): Promise<PaymentStatusResult>;
}
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
