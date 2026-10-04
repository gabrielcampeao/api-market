import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique constraint', {
    code: 'P2002',
    clientVersion: '6.0.0',
  });
}
import { StripeWebhookService } from './stripe-webhook.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { AppConfigService } from '../config/app-config.service';
import { MetricsService } from '../metrics/metrics.service';

const constructEventMock = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent: constructEventMock },
  }));
});

function paymentIntentEvent(type: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'evt_1',
    type,
    data: {
      object: {
        id: 'pi_1',
        last_payment_error: null,
        ...overrides,
      },
    },
  };
}

describe('StripeWebhookService', () => {
  let service: StripeWebhookService;

  const configMock = {
    stripeSecretKey: 'sk_test_x',
    stripeWebhookSecret: 'whsec_x',
  } as unknown as AppConfigService;

  const payment_ = { findFirst: jest.fn(), updateMany: jest.fn() };
  const paymentAttempt_ = { findFirst: jest.fn(), update: jest.fn() };
  const txMock = {
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    payment: payment_,
    paymentAttempt: paymentAttempt_,
  };

  const prismaMock = {
    webhookEvent: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    payment: payment_,
    paymentAttempt: paymentAttempt_,
    order: { findUniqueOrThrow: jest.fn() },
    $transaction: jest.fn((arg: unknown) => {
      return (arg as (tx: typeof txMock) => Promise<unknown>)(txMock);
    }),
  };

  const auditMock = { log: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.webhookEvent.findUnique.mockResolvedValue(null);
    prismaMock.webhookEvent.create.mockResolvedValue({ id: 'we-1' });
    prismaMock.paymentAttempt.findFirst.mockResolvedValue({ id: 'attempt-1' });
    prismaMock.payment.updateMany.mockResolvedValue({ count: 1 });

    const moduleRef = await Test.createTestingModule({
      providers: [
        StripeWebhookService,
        MetricsService,
        { provide: AppConfigService, useValue: configMock },
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: auditMock },
      ],
    }).compile();
    service = moduleRef.get(StripeWebhookService);
  });

  it('rejects requests with no verifiable signature', async () => {
    await expect(service.handleEvent(Buffer.from('{}'), undefined)).rejects.toThrow(BadRequestException);
    expect(prismaMock.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a payload whose signature does not verify', async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('invalid signature');
    });
    await expect(service.handleEvent(Buffer.from('{}'), 'bad-sig')).rejects.toThrow(BadRequestException);
  });

  it('processes payment_intent.succeeded and approves the payment', async () => {
    constructEventMock.mockReturnValue(paymentIntentEvent('payment_intent.succeeded'));
    prismaMock.payment.findFirst.mockResolvedValue({
      id: 'pay-1',
      orderId: 'o-1',
      status: PaymentStatus.PROCESSING,
    });
    prismaMock.order.findUniqueOrThrow.mockResolvedValue({ id: 'o-1', status: 'PENDING' });

    const result = await service.handleEvent(Buffer.from('{}'), 'sig');

    expect(result).toEqual({ status: 'processed' });
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.webhook_approved' }),
    );
    expect(prismaMock.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ processedAt: expect.any(Date) }) }),
    );
  });

  it('does not downgrade a payment that is already APPROVED (out-of-order delivery)', async () => {
    constructEventMock.mockReturnValue(paymentIntentEvent('payment_intent.payment_failed'));
    prismaMock.payment.findFirst.mockResolvedValue({
      id: 'pay-1',
      orderId: 'o-1',
      status: PaymentStatus.APPROVED,
    });

    await service.handleEvent(Buffer.from('{}'), 'sig');

    expect(prismaMock.payment.updateMany).not.toHaveBeenCalled();
    expect(auditMock.log).not.toHaveBeenCalled();
  });

  it('ignores an event for a PaymentIntent this API never created', async () => {
    constructEventMock.mockReturnValue(paymentIntentEvent('payment_intent.succeeded'));
    prismaMock.payment.findFirst.mockResolvedValue(null);

    const result = await service.handleEvent(Buffer.from('{}'), 'sig');

    expect(result).toEqual({ status: 'processed' });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('ignores an event whose metadata.orderId does not match any payment', async () => {
    constructEventMock.mockReturnValue(
      paymentIntentEvent('payment_intent.succeeded', { metadata: { orderId: 'o-does-not-exist' } }),
    );
    prismaMock.payment.findFirst.mockResolvedValue(null);

    const result = await service.handleEvent(Buffer.from('{}'), 'sig');

    expect(result).toEqual({ status: 'processed' });
    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith({ where: { orderId: 'o-does-not-exist' } });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('does not resurrect a payment that is already REFUNDED (out-of-order delivery)', async () => {
    constructEventMock.mockReturnValue(paymentIntentEvent('payment_intent.succeeded'));
    prismaMock.payment.findFirst.mockResolvedValue({
      id: 'pay-1',
      orderId: 'o-1',
      status: PaymentStatus.REFUNDED,
    });

    await service.handleEvent(Buffer.from('{}'), 'sig');

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(auditMock.log).not.toHaveBeenCalled();
  });

  it('ignores an unhandled event type without touching the payment', async () => {
    constructEventMock.mockReturnValue(paymentIntentEvent('charge.dispute.created'));

    const result = await service.handleEvent(Buffer.from('{}'), 'sig');

    expect(result).toEqual({ status: 'processed' });
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ processedAt: expect.any(Date) }) }),
    );
  });

  it('does not mark the order PAID from a stale succeeded event after the payment already failed', async () => {
    // A "succeeded" event delivered after an earlier "failed" event (or
    // after PaymentsService.pay() itself already recorded a decline) for the
    // same PaymentIntent — the payment is FAILED, not PENDING/PROCESSING, so
    // it's outside this webhook's claimable set entirely.
    constructEventMock.mockReturnValue(paymentIntentEvent('payment_intent.succeeded'));
    prismaMock.payment.findFirst.mockResolvedValue({
      id: 'pay-1',
      orderId: 'o-1',
      status: PaymentStatus.FAILED,
    });
    prismaMock.order.findUniqueOrThrow.mockResolvedValue({ id: 'o-1', status: 'PENDING' });
    payment_.updateMany.mockResolvedValue({ count: 0 });

    await service.handleEvent(Buffer.from('{}'), 'sig');

    expect(txMock.order.updateMany).not.toHaveBeenCalled();
    expect(paymentAttempt_.update).not.toHaveBeenCalled();
    expect(auditMock.log).not.toHaveBeenCalled();
  });

  it('is a no-op for a duplicate delivery of an already-processed event', async () => {
    constructEventMock.mockReturnValue(paymentIntentEvent('payment_intent.succeeded'));
    prismaMock.webhookEvent.findUnique.mockResolvedValue({ id: 'we-1', processedAt: new Date() });

    const result = await service.handleEvent(Buffer.from('{}'), 'sig');

    expect(result).toEqual({ status: 'duplicate' });
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled();
  });

  it('treats a concurrent create-race loss (P2002) as a duplicate, not an error', async () => {
    constructEventMock.mockReturnValue(paymentIntentEvent('payment_intent.succeeded'));
    // Two requests both read "doesn't exist yet" before either has inserted —
    // the exact TOCTOU gap between findUnique and create.
    prismaMock.webhookEvent.findUnique.mockResolvedValue(null);
    prismaMock.webhookEvent.create.mockRejectedValue(p2002());

    const result = await service.handleEvent(Buffer.from('{}'), 'sig');

    expect(result).toEqual({ status: 'duplicate' });
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled();
  });

  it('sending the same event 20 times settles the payment exactly once', async () => {
    constructEventMock.mockReturnValue(paymentIntentEvent('payment_intent.succeeded'));
    prismaMock.payment.findFirst.mockResolvedValue({
      id: 'pay-1',
      orderId: 'o-1',
      status: PaymentStatus.PROCESSING,
    });
    prismaMock.order.findUniqueOrThrow.mockResolvedValue({ id: 'o-1', status: 'PENDING' });

    // First delivery actually processes and "persists" processedAt for the
    // rest of this test's mock state.
    await service.handleEvent(Buffer.from('{}'), 'sig');
    prismaMock.webhookEvent.findUnique.mockResolvedValue({ id: 'we-1', processedAt: new Date() });

    const rest = await Promise.all(
      Array.from({ length: 19 }, () => service.handleEvent(Buffer.from('{}'), 'sig')),
    );

    expect(rest.every((r) => r.status === 'duplicate')).toBe(true);
    // Settlement logic (the $transaction that pays the order) ran exactly once.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it('retries reprocess an event that failed before being marked processed', async () => {
    constructEventMock.mockReturnValue(paymentIntentEvent('payment_intent.succeeded'));
    prismaMock.payment.findFirst.mockResolvedValue(null); // e.g. transient lookup issue first time
    prismaMock.webhookEvent.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'we-1',
      processedAt: null, // first attempt never completed
    });

    await service.handleEvent(Buffer.from('{}'), 'sig');
    await service.handleEvent(Buffer.from('{}'), 'sig');

    expect(prismaMock.payment.findFirst).toHaveBeenCalledTimes(2);
  });
});
