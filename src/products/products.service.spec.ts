import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ProductsService } from './products.service';
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

describe('ProductsService', () => {
  let service: ProductsService;

  const prismaMock = {
    product: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };

  const auditMock = { log: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: auditMock },
      ],
    }).compile();

    service = moduleRef.get(ProductsService);
  });

  it('creates a product', async () => {
    const created = product();
    prismaMock.product.create.mockResolvedValue(created);

    const result = await service.create('admin-1', {
      name: 'Wireless Mouse',
      price: 29.9,
      stock: 10,
    }, ctx);

    expect(prismaMock.product.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Wireless Mouse',
        price: expect.any(Prisma.Decimal),
        stock: 10,
      }),
    });
    expect(result.price).toBe('29.90');
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'product.create', userId: 'admin-1' }),
    );
  });

  it('lists only active products by default with pagination meta', async () => {
    prismaMock.product.count.mockResolvedValue(1);
    prismaMock.product.findMany.mockResolvedValue([product()]);

    const result = await service.findAll({ page: 1, limit: 10 });

    expect(prismaMock.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
        skip: 0,
        take: 10,
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.meta.total).toBe(1);
    expect(result.meta.totalPages).toBe(1);
  });

  it('applies search and price filters', async () => {
    prismaMock.product.count.mockResolvedValue(0);
    prismaMock.product.findMany.mockResolvedValue([]);

    await service.findAll({ page: 1, limit: 10, search: 'mouse', minPrice: 10, maxPrice: 50 });

    const call = prismaMock.product.findMany.mock.calls[0][0] as { where: Prisma.ProductWhereInput };
    expect(call.where).toEqual({
      isActive: true,
      name: { contains: 'mouse', mode: 'insensitive' },
      price: { gte: decimal('10'), lte: decimal('50') },
    });
  });

  it('throws when finding an inactive product by id', async () => {
    prismaMock.product.findUnique.mockResolvedValue(product({ isActive: false }));

    await expect(service.findById('p-1', true)).rejects.toThrow('Product not found');
  });

  it('updates product fields', async () => {
    const existing = product();
    prismaMock.product.findUnique.mockResolvedValue(existing);
    prismaMock.product.update.mockResolvedValue(product({ price: decimal('39.90') }));

    const result = await service.update('admin-1', 'p-1', { price: 39.9 }, ctx);

    expect(prismaMock.product.update).toHaveBeenCalledWith({
      where: { id: 'p-1' },
      data: expect.objectContaining({ price: expect.any(Prisma.Decimal) }),
    });
    expect(result.price).toBe('39.90');
  });

  it('soft deletes a product', async () => {
    prismaMock.product.findUnique.mockResolvedValue(product());
    prismaMock.product.update.mockResolvedValue(product({ isActive: false }));

    const result = await service.softDelete('admin-1', 'p-1', ctx);

    expect(prismaMock.product.update).toHaveBeenCalledWith({
      where: { id: 'p-1' },
      data: { isActive: false },
    });
    expect(result.message).toBe('Product deactivated');
  });

  it('rejects stock adjustments below zero', async () => {
    prismaMock.product.findUnique.mockResolvedValue(product({ stock: 2 }));
    prismaMock.product.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.adjustStock('p-1', -5)).rejects.toThrow(BadRequestException);
  });
});
