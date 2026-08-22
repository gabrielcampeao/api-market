import { Test } from '@nestjs/testing';
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { MetricsService } from '../metrics/metrics.service';

const decimal = (value: string) => new Prisma.Decimal(value);

function stuckPayment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pay-1',
    amount: decimal('50.00'),
    providerIdempotencyKey: 'idem-key-1',
    order: { id: 'o-1', status: OrderStatus.PENDING },
    ...overrides,
  };
}

describe('PaymentReconciliationService', () => {
  let service: PaymentReconciliationService;

  const payment_ = { findMany: jest.fn(), updateMany: jest.fn(), update: jest.fn() };
  const paymentAttempt_ = {
    findFirst: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
    update: jest.fn(),
  };
  const order_ = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
  const txMock = {
    order: order_,
    payment: payment_,
    paymentAttempt: paymentAttempt_,
  };

  const prismaMock = {
    payment: payment_,
    paymentAttempt: paymentAttempt_,
    $transaction: jest.fn((arg: unknown) => {
      return (arg as (tx: typeof txMock) => Promise<unknown>)(txMock);
    }),
  };

  const auditMock = { log: jest.fn().mockResolvedValue(undefined) };
  const providerMock = { name: 'fake', checkStatus: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.paymentAttempt.findFirst.mockResolvedValue({ id: 'attempt-1' });
    prismaMock.payment.updateMany.mockResolvedValue({ count: 1 });
    order_.updateMany.mockResolvedValue({ count: 1 });
    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentReconciliationService,
        MetricsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: auditMock },
        { provide: PAYMENT_PROVIDER, useValue: providerMock },
      ],
    }).compile();
    service = moduleRef.get(PaymentReconciliationService);
  });

  it('does nothing when no payment is stuck', async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    const summary = await service.reconcileStuckPayments();
    expect(summary).toEqual({ checked: 0, approved: 0, declined: 0, stillUnknown: 0 });
    expect(providerMock.checkStatus).not.toHaveBeenCalled();
  });

  it('leaves the payment PROCESSING when the provider still does not know', async () => {
    prismaMock.payment.findMany.mockResolvedValue([stuckPayment()]);
    providerMock.checkStatus.mockResolvedValue({ status: 'unknown' });

    const summary = await service.reconcileStuckPayments();

    expect(summary.stillUnknown).toBe(1);
    expect(prismaMock.payment.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('leaves the payment PROCESSING when checkStatus times out', async () => {
    prismaMock.payment.findMany.mockResolvedValue([stuckPayment()]);
    providerMock.checkStatus.mockReturnValue(new Promise(() => {}));

    jest.useFakeTimers();
    const pending = service.reconcileStuckPayments();
    const assertion = expect(pending).resolves.toEqual(
      expect.objectContaining({ stillUnknown: 1 }),
    );
    await jest.advanceTimersByTimeAsync(15_000);
    await assertion;
    jest.useRealTimers();

    expect(prismaMock.payment.updateMany).not.toHaveBeenCalled();
  });

  it('marks the payment FAILED when the provider says it was declined', async () => {
    prismaMock.payment.findMany.mockResolvedValue([stuckPayment()]);
    providerMock.checkStatus.mockResolvedValue({
      status: 'declined',
      providerRef: 'ref-1',
      failureCode: 'card_declined',
    });

    const summary = await service.reconcileStuckPayments();

    expect(summary.declined).toBe(1);
    expect(prismaMock.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: PaymentStatus.PROCESSING },
      data: { status: PaymentStatus.FAILED, providerRef: 'ref-1', processingAt: null },
    });
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.reconciled_declined' }),
    );
  });

  it('does not log or count a decline it lost the race to claim', async () => {
    prismaMock.payment.findMany.mockResolvedValue([stuckPayment()]);
    providerMock.checkStatus.mockResolvedValue({ status: 'declined', providerRef: 'ref-1' });
    prismaMock.payment.updateMany.mockResolvedValue({ count: 0 });

    const summary = await service.reconcileStuckPayments();

    expect(summary).toEqual({ checked: 1, approved: 0, declined: 0, stillUnknown: 0 });
    expect(prismaMock.paymentAttempt.update).not.toHaveBeenCalled();
    expect(auditMock.log).not.toHaveBeenCalled();
  });

  it('approves the payment and pays the order when the provider says it was approved', async () => {
    prismaMock.payment.findMany.mockResolvedValue([stuckPayment()]);
    providerMock.checkStatus.mockResolvedValue({ status: 'approved', providerRef: 'ref-1' });

    const summary = await service.reconcileStuckPayments();

    expect(summary.approved).toBe(1);
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.reconciled_approved' }),
    );
  });

  it('does not log, pay the order, or count an approval it lost the race to claim', async () => {
    prismaMock.payment.findMany.mockResolvedValue([stuckPayment()]);
    providerMock.checkStatus.mockResolvedValue({ status: 'approved', providerRef: 'ref-1' });
    payment_.updateMany.mockResolvedValue({ count: 0 });

    const summary = await service.reconcileStuckPayments();

    expect(summary).toEqual({ checked: 1, approved: 0, declined: 0, stillUnknown: 0 });
    expect(order_.updateMany).not.toHaveBeenCalled();
    expect(paymentAttempt_.update).not.toHaveBeenCalled();
    expect(auditMock.log).not.toHaveBeenCalled();
  });

  it('reverses to REFUNDED instead of paying an order that was cancelled while stuck', async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      stuckPayment({ order: { id: 'o-1', status: OrderStatus.CANCELLED } }),
    ]);
    providerMock.checkStatus.mockResolvedValue({ status: 'approved', providerRef: 'ref-1' });
    order_.updateMany.mockResolvedValue({ count: 0 });

    await service.reconcileStuckPayments();

    expect(payment_.update).toHaveBeenCalledWith({
      where: { id: 'pay-1' },
      data: { status: PaymentStatus.REFUNDED },
    });
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.reconciled_reversed_order_cancelled' }),
    );
  });

  it('processes multiple stuck payments independently', async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      stuckPayment({ id: 'pay-1' }),
      stuckPayment({ id: 'pay-2', order: { id: 'o-2', status: OrderStatus.PENDING } }),
    ]);
    providerMock.checkStatus
      .mockResolvedValueOnce({ status: 'approved', providerRef: 'ref-1' })
      .mockResolvedValueOnce({ status: 'unknown' });

    const summary = await service.reconcileStuckPayments();

    expect(summary).toEqual({ checked: 2, approved: 1, declined: 0, stillUnknown: 1 });
  });

  it('keeps checking the rest of the batch when one payment errors', async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      stuckPayment({ id: 'pay-1' }),
      stuckPayment({ id: 'pay-2', order: { id: 'o-2', status: OrderStatus.PENDING } }),
    ]);
    providerMock.checkStatus
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'approved', providerRef: 'ref-2' });

    const summary = await service.reconcileStuckPayments();

    expect(summary).toEqual({ checked: 2, approved: 1, declined: 0, stillUnknown: 0 });
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'o-2', action: 'payment.reconciled_approved' }),
    );
  });

  it('skips a run that starts while a previous one is still in flight', async () => {
    let resolveFirstCheckStatus!: (value: { status: 'unknown' }) => void;
    prismaMock.payment.findMany.mockResolvedValue([stuckPayment()]);
    providerMock.checkStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveFirstCheckStatus = resolve;
      }),
    );

    const first = service.reconcileStuckPayments();
    const second = await service.reconcileStuckPayments();

    expect(second).toEqual({ checked: 0, approved: 0, declined: 0, stillUnknown: 0 });
    expect(prismaMock.payment.findMany).toHaveBeenCalledTimes(1);

    resolveFirstCheckStatus({ status: 'unknown' });
    await first;
  });
});
