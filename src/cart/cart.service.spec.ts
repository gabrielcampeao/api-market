import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartService } from './cart.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { RequestContext } from '../common/utils/request-context.util';

const ctx: RequestContext = { ip: '127.0.0.1', userAgent: 'jest' };
const decimal = (value: string) => new Prisma.Decimal(value);

function product(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p-1',
    name: 'Wireless Mouse',
    description: null,
    price: decimal('29.90'),
    stock: 10,
    isActive: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('CartService', () => {
  let service: CartService;

  const prismaMock = {
    cartItem: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
    product: {
      findUnique: jest.fn(),
    },
  };

  const auditMock = { log: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CartService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: auditMock },
      ],
    }).compile();

    service = moduleRef.get(CartService);
  });

  it('returns cart items with totals', async () => {
    prismaMock.cartItem.findMany.mockResolvedValue([
      {
        id: 'ci-1',
        userId: 'u-1',
        productId: 'p-1',
        quantity: 2,
        product: product(),
      },
      {
        id: 'ci-2',
        userId: 'u-1',
        productId: 'p-2',
        quantity: 1,
        product: product({ id: 'p-2', price: decimal('10.00') }),
      },
    ]);

    const cart = await service.getCart('u-1');

    expect(cart.totalItems).toBe(3);
    expect(cart.total).toBe('69.80');
  });

  it('adds an item to the cart', async () => {
    prismaMock.product.findUnique.mockResolvedValue(product());
    prismaMock.cartItem.findUnique.mockResolvedValue(null);
    prismaMock.cartItem.upsert.mockResolvedValue({
      id: 'ci-1',
      userId: 'u-1',
      productId: 'p-1',
      quantity: 2,
    });

    const item = await service.addItem('u-1', { productId: 'p-1', quantity: 2 }, ctx);

    expect(prismaMock.cartItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ quantity: 2 }),
      }),
    );
    expect(item.quantity).toBe(2);
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cart.add_item', userId: 'u-1' }),
    );
  });

  it('sums quantities when the product is already in the cart', async () => {
    prismaMock.product.findUnique.mockResolvedValue(product({ stock: 20 }));
    prismaMock.cartItem.findUnique.mockResolvedValue({
      id: 'ci-1',
      quantity: 2,
    });
    prismaMock.cartItem.upsert.mockResolvedValue({
      id: 'ci-1',
      userId: 'u-1',
      productId: 'p-1',
      quantity: 5,
    });

    const item = await service.addItem('u-1', { productId: 'p-1', quantity: 3 }, ctx);

    expect(prismaMock.cartItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ quantity: 5 }),
      }),
    );
    expect(item.quantity).toBe(5);
  });

  it('rejects adding more than the available stock', async () => {
    prismaMock.product.findUnique.mockResolvedValue(product({ stock: 1 }));

    await expect(
      service.addItem('u-1', { productId: 'p-1', quantity: 5 }, ctx),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects adding an inactive product', async () => {
    prismaMock.product.findUnique.mockResolvedValue(product({ isActive: false }));

    await expect(
      service.addItem('u-1', { productId: 'p-1', quantity: 1 }, ctx),
    ).rejects.toThrow(NotFoundException);
  });

  it('updates the quantity of an existing item', async () => {
    prismaMock.cartItem.findUnique.mockResolvedValue({
      id: 'ci-1',
      userId: 'u-1',
      productId: 'p-1',
      quantity: 1,
    });
    prismaMock.product.findUnique.mockResolvedValue(product());
    prismaMock.cartItem.update.mockResolvedValue({
      id: 'ci-1',
      userId: 'u-1',
      productId: 'p-1',
      quantity: 3,
    });

    const item = await service.updateItem('u-1', 'p-1', { quantity: 3 }, ctx);

    expect(prismaMock.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'ci-1' },
      data: { quantity: 3 },
    });
    expect(item.quantity).toBe(3);
  });

  it('removes an item from the cart', async () => {
    prismaMock.cartItem.findUnique.mockResolvedValue({ id: 'ci-1' });
    prismaMock.cartItem.delete.mockResolvedValue({});

    const result = await service.removeItem('u-1', 'p-1', ctx);

    expect(prismaMock.cartItem.delete).toHaveBeenCalledWith({
      where: { id: 'ci-1' },
    });
    expect(result.message).toContain('removed');
  });
});
