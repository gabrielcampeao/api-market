import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { OrderStatus, Prisma, PaymentStatus, Role } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { MetricsService } from '../metrics/metrics.service';
import { RequestContext } from '../common/utils/request-context.util';
import { AuthenticatedUser } from '../auth/interfaces/auth.types';

const ctx: RequestContext = { ip: '127.0.0.1', userAgent: 'jest' };
const decimal = (value: string) => new Prisma.Decimal(value);
const user: AuthenticatedUser = { id: 'u-1', email: 'jane@test.dev', role: Role.USER };

function payment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pay-1',
    orderId: 'o-1',
    provider: 'fake',
    providerRef: null,
    status: PaymentStatus.PENDING,
    amount: decimal('50.00'),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    paidAt: null,
    processingAt: null,
    providerIdempotencyKey: 'idem-key-1',
    ...overrides,
  };
}

function order(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'o-1',
    userId: 'u-1',
    status: OrderStatus.PENDING,
    total: decimal('50.00'),
    payment: payment(),
    ...overrides,
  };
}

describe('PaymentsService', () => {
  let service: PaymentsService;

  const order_ = { findUnique: jest.fn() };
  const payment_ = { updateMany: jest.fn(), update: jest.fn() };
  const paymentAttempt_ = {
    create: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
    update: jest.fn().mockResolvedValue({}),
  };
  const txMock = {
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    payment: payment_,
    paymentAttempt: paymentAttempt_,
  };

  const prismaMock = {
    order: order_,
    payment: payment_,
    paymentAttempt: paymentAttempt_,
    $transaction: jest.fn((arg: unknown) => {
      return (arg as (tx: typeof txMock) => Promise<unknown>)(txMock);
    }),
  };

  const auditMock = { log: jest.fn().mockResolvedValue(undefined) };
  const providerMock = { name: 'fake', charge: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        MetricsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: auditMock },
        { provide: PAYMENT_PROVIDER, useValue: providerMock },
      ],
    }).compile();
    service = moduleRef.get(PaymentsService);
  });

  it('rejects an order that does not belong to the caller', async () => {
    prismaMock.order.findUnique.mockResolvedValue(order({ userId: 'someone-else' }));
    await expect(service.pay(user, 'o-1', ctx)).rejects.toThrow(ForbiddenException);
  });

  it('rejects a non-PENDING order', async () => {
    prismaMock.order.findUnique.mockResolvedValue(order({ status: OrderStatus.PAID }));
    await expect(service.pay(user, 'o-1', ctx)).rejects.toThrow(BadRequestException);
  });

  it('rejects the claim when another request already holds it (PROCESSING)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(order());
    prismaMock.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.pay(user, 'o-1', ctx)).rejects.toThrow(ConflictException);
    expect(providerMock.charge).not.toHaveBeenCalled();
  });

  it('reverts PROCESSING back to PENDING and does not settle the payment when the provider throws', async () => {
    prismaMock.order.findUnique.mockResolvedValue(order());
    prismaMock.payment.updateMany.mockResolvedValue({ count: 1 });
    providerMock.charge.mockRejectedValue(new Error('gateway timeout'));

    await expect(service.pay(user, 'o-1', ctx)).rejects.toThrow(BadRequestException);

    expect(prismaMock.payment.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'pay-1', status: PaymentStatus.PROCESSING },
      data: { status: PaymentStatus.PENDING, processingAt: null },
    });
    expect(prismaMock.paymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'attempt-1' },
        data: expect.objectContaining({ status: 'ERROR', failureMessage: 'gateway timeout' }),
      }),
    );
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('times out (rather than hanging forever) and reverts to PENDING when the provider never responds', async () => {
    jest.useFakeTimers();
    prismaMock.order.findUnique.mockResolvedValue(order());
    prismaMock.payment.updateMany.mockResolvedValue({ count: 1 });
    // A provider that never resolves or rejects — a network stall, not an
    // error. Without a timeout, this would hang the request indefinitely.
    providerMock.charge.mockReturnValue(new Promise(() => {}));

    const pending = service.pay(user, 'o-1', ctx);
    const assertion = expect(pending).rejects.toThrow(BadRequestException);
    await jest.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(prismaMock.payment.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'pay-1', status: PaymentStatus.PROCESSING },
      data: { status: PaymentStatus.PENDING, processingAt: null },
    });
    jest.useRealTimers();
  });

  it('sends the same providerIdempotencyKey to the provider on a retry after a decline', async () => {
    prismaMock.order.findUnique.mockResolvedValue(order());
    prismaMock.payment.updateMany.mockResolvedValue({ count: 1 });
    providerMock.charge.mockResolvedValue({ approved: false, message: 'insufficient funds' });

    await expect(service.pay(user, 'o-1', ctx)).rejects.toThrow(BadRequestException);
    await expect(service.pay(user, 'o-1', ctx)).rejects.toThrow(BadRequestException);

    expect(providerMock.charge).toHaveBeenNthCalledWith(1, decimal('50.00'), 'o-1', 'idem-key-1');
    expect(providerMock.charge).toHaveBeenNthCalledWith(2, decimal('50.00'), 'o-1', 'idem-key-1');
  });

  it('marks the payment FAILED (not stuck in PROCESSING) when the provider declines', async () => {
    prismaMock.order.findUnique.mockResolvedValue(order());
    prismaMock.payment.updateMany.mockResolvedValue({ count: 1 });
    providerMock.charge.mockResolvedValue({ approved: false, message: 'insufficient funds' });

    await expect(service.pay(user, 'o-1', ctx)).rejects.toThrow(BadRequestException);

    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { id: 'pay-1' },
      data: { status: PaymentStatus.FAILED, providerRef: null, processingAt: null },
    });
  });

  it('approves the payment and pays the order on a successful charge', async () => {
    prismaMock.order.findUnique.mockResolvedValue(order());
    prismaMock.payment.updateMany.mockResolvedValue({ count: 1 });
    providerMock.charge.mockResolvedValue({ approved: true, providerRef: 'fake_ref_123' });
    const txPaymentUpdate = jest
      .fn()
      .mockResolvedValue({ ...payment(), status: PaymentStatus.APPROVED, providerRef: 'fake_ref_123' });
    prismaMock.$transaction.mockImplementationOnce((arg: unknown) =>
      (arg as (tx: unknown) => Promise<unknown>)({
        order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        payment: { update: txPaymentUpdate },
        paymentAttempt: { update: jest.fn().mockResolvedValue({}) },
      }),
    );

    const result = await service.pay(user, 'o-1', ctx);

    expect(result.status).toBe(PaymentStatus.APPROVED);
    expect(result.providerRef).toBe('fake_ref_123');
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.approved' }),
    );
  });

  it('reverses the charge to REFUNDED if the order was cancelled while the provider call was in flight', async () => {
    prismaMock.order.findUnique.mockResolvedValue(order());
    prismaMock.payment.updateMany.mockResolvedValue({ count: 1 });
    providerMock.charge.mockResolvedValue({ approved: true, providerRef: 'fake_ref_123' });
    const txPaymentUpdate = jest
      .fn()
      .mockResolvedValue({ ...payment(), status: PaymentStatus.REFUNDED, providerRef: 'fake_ref_123' });
    prismaMock.$transaction.mockImplementationOnce((arg: unknown) =>
      (arg as (tx: unknown) => Promise<unknown>)({
        order: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, // order no longer PENDING
        payment: { update: txPaymentUpdate },
        paymentAttempt: { update: jest.fn().mockResolvedValue({}) },
      }),
    );

    await expect(service.pay(user, 'o-1', ctx)).rejects.toThrow(BadRequestException);
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.reversed_order_cancelled' }),
    );
  });
});
