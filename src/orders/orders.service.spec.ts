import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { MailService } from '../mail/mail.service';
import { PAYMENT_PROVIDER } from '../payments/providers/payment-provider.interface';
import { RequestContext } from '../common/utils/request-context.util';

const ctx: RequestContext = { ip: '127.0.0.1', userAgent: 'jest' };
const decimal = (value: string) => new Prisma.Decimal(value);

function product(id = 'p-1') {
  return {
    id,
    name: `Product ${id}`,
    description: null,
    price: decimal('29.90'),
    stock: 10,
    isActive: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

function order(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'o-1',
    userId: 'u-1',
    status: OrderStatus.PENDING,
    total: decimal('59.80'),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    items: [
      {
        id: 'oi-1',
        orderId: 'o-1',
        productId: 'p-1',
        quantity: 2,
        price: decimal('29.90'),
        product: product(),
      },
    ],
    payment: null,
    ...overrides,
  };
}

describe('OrdersService', () => {
  let service: OrdersService;

  const txMock = {
    product: {
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    order: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
    },
    cartItem: {
      deleteMany: jest.fn(),
    },
  };

  const prismaMock = {
    cartItem: { findMany: jest.fn() },
    product: { findMany: jest.fn() },
    order: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn((arg: unknown) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg as Promise<unknown>[]);
      }
      return (arg as (tx: typeof txMock) => Promise<unknown>)(txMock);
    }),
  };

  const auditMock = { log: jest.fn().mockResolvedValue(undefined) };
  const mailMock = {
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    sendOrderConfirmation: jest.fn().mockResolvedValue(undefined),
  };
  const paymentProviderMock = { name: 'fake' };

  beforeEach(async () => {
    jest.clearAllMocks();
    txMock.product.updateMany.mockResolvedValue({ count: 1 });
    txMock.product.findMany.mockResolvedValue([product()]);
    txMock.order.create.mockResolvedValue(order());
    txMock.cartItem.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.user.findUnique.mockResolvedValue({ email: 'jane@example.com' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: auditMock },
        { provide: MailService, useValue: mailMock },
        { provide: PAYMENT_PROVIDER, useValue: paymentProviderMock },
      ],
    }).compile();

    service = moduleRef.get(OrdersService);
  });

  it('rejects checkout with an empty cart', async () => {
    prismaMock.cartItem.findMany.mockResolvedValue([]);

    await expect(service.checkout('u-1', ctx)).rejects.toThrow(BadRequestException);
  });

  it('checkout creates an order, decrements stock and clears the cart', async () => {
    prismaMock.cartItem.findMany.mockResolvedValue([
      {
        id: 'ci-1',
        userId: 'u-1',
        productId: 'p-1',
        quantity: 2,
        product: product(),
      },
    ]);

    const result = await service.checkout('u-1', ctx);

    expect(txMock.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p-1', stock: { gte: 2 } },
        data: { stock: { decrement: 2 } },
      }),
    );
    expect(txMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u-1',
          total: decimal('59.80'),
          payment: expect.objectContaining({ create: expect.any(Object) }),
        }),
      }),
    );
    expect(txMock.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u-1' },
    });
    expect(mailMock.sendOrderConfirmation).toHaveBeenCalledWith('jane@example.com', 'o-1', '59.80');
    expect(result.status).toBe(OrderStatus.PENDING);
  });

  it('rejects checkout when stock runs out during the transaction', async () => {
    prismaMock.cartItem.findMany.mockResolvedValue([
      {
        id: 'ci-1',
        userId: 'u-1',
        productId: 'p-1',
        quantity: 5,
        product: product(),
      },
    ]);
    txMock.product.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.checkout('u-1', ctx)).rejects.toThrow(BadRequestException);
  });

  it('filters orders by user', async () => {
    prismaMock.order.count.mockResolvedValue(1);
    prismaMock.order.findMany.mockResolvedValue([order()]);

    const result = await service.findAllForUser('u-1', { page: 1, limit: 10 });

    expect(prismaMock.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'u-1' }),
      }),
    );
    expect(result.items).toHaveLength(1);
  });

  it('prevents a user from reading another user order', async () => {
    prismaMock.order.findUnique.mockResolvedValue(order());

    await expect(service.findById('o-1', 'u-2')).rejects.toThrow(ForbiddenException);
  });

  it('cancels a PENDING order and restores stock', async () => {
    const pendingOrder = order();
    prismaMock.order.findUnique.mockResolvedValue(pendingOrder);
    txMock.product.update.mockResolvedValue(product());
    txMock.order.findUnique.mockResolvedValue(order({ status: OrderStatus.CANCELLED }));

    const result = await service.cancel('u-1', 'o-1', ctx);

    expect(txMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o-1', status: OrderStatus.PENDING },
        data: { status: OrderStatus.CANCELLED },
      }),
    );
    expect(txMock.product.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p-1' },
        data: { stock: { increment: 2 } },
      }),
    );
    expect(result.status).toBe(OrderStatus.CANCELLED);
  });

  it('rejects cancelling an order that is already paid', async () => {
    prismaMock.order.findUnique.mockResolvedValue(order({ status: OrderStatus.PAID }));

    await expect(service.cancel('u-1', 'o-1', ctx)).rejects.toThrow(BadRequestException);
  });

  it('rejects cancelling when the status changed concurrently', async () => {
    prismaMock.order.findUnique.mockResolvedValue(order());
    txMock.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.cancel('u-1', 'o-1', ctx)).rejects.toThrow(BadRequestException);
  });

  it('enforces valid status transitions', async () => {
    prismaMock.order.findUnique.mockResolvedValue(order({ status: OrderStatus.PENDING }));

    await expect(
      service.updateStatus('admin-1', 'o-1', { status: OrderStatus.DELIVERED }, ctx),
    ).rejects.toThrow(BadRequestException);
  });
});
