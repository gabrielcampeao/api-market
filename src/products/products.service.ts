import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Product } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { RequestContext } from '../common/utils/request-context.util';
import { buildPaginationMeta, PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { toProductDto, ProductDto } from './dto/product.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async create(adminId: string, dto: CreateProductDto, ctx: RequestContext): Promise<ProductDto> {
    const product = await this.prisma.product.create({
      data: {
        name: dto.name,
        description: dto.description,
        price: new Prisma.Decimal(dto.price),
        stock: dto.stock ?? 0,
      },
    });
    await this.audit.log({
      userId: adminId,
      action: 'product.create',
      entity: 'product',
      entityId: product.id,
      metadata: { name: product.name } as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return toProductDto(product);
  }

  async findAll(
    query: QueryProductsDto,
    includeInactive = false,
  ): Promise<PaginatedResponseDto<ProductDto>> {
    const { page, limit } = query;

    const where: Prisma.ProductWhereInput = {};
    if (!includeInactive) {
      where.isActive = true;
    }
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.price = {};
      if (query.minPrice !== undefined) {
        where.price.gte = new Prisma.Decimal(query.minPrice);
      }
      if (query.maxPrice !== undefined) {
        where.price.lte = new Prisma.Decimal(query.maxPrice);
      }
    }

    const orderBy: Prisma.ProductOrderByWithRelationInput = {
      [query.sortBy ?? 'createdAt']: query.sortOrder ?? 'desc',
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return new PaginatedResponseDto(
      rows.map(toProductDto),
      buildPaginationMeta(total, page, limit),
    );
  }

  async findById(id: string, onlyActive = false): Promise<Product> {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product || (onlyActive && !product.isActive)) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async update(
    adminId: string,
    id: string,
    dto: UpdateProductDto,
    ctx: RequestContext,
  ): Promise<ProductDto> {
    const existing = await this.findById(id);

    const data: Prisma.ProductUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.price !== undefined) data.price = new Prisma.Decimal(dto.price);
    if (dto.stock !== undefined) data.stock = dto.stock;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    const updated = await this.prisma.product.update({ where: { id }, data });

    await this.audit.log({
      userId: adminId,
      action: 'product.update',
      entity: 'product',
      entityId: id,
      metadata: {
        previous: {
          price: existing.price.toFixed(2),
          stock: existing.stock,
          isActive: existing.isActive,
        },
        changes: dto,
      } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return toProductDto(updated);
  }

  async softDelete(adminId: string, id: string, ctx: RequestContext): Promise<{ message: string }> {
    await this.findById(id);
    await this.prisma.product.update({ where: { id }, data: { isActive: false } });
    await this.audit.log({
      userId: adminId,
      action: 'product.deactivate',
      entity: 'product',
      entityId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { message: 'Product deactivated' };
  }

  async adjustStock(id: string, delta: number): Promise<void> {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product || !product.isActive) {
      throw new BadRequestException(`Product ${id} is not available`);
    }

    const result = await this.prisma.product.updateMany({
      where: { id, isActive: true, stock: { gte: -delta } },
      data: { stock: { increment: delta } },
    });
    if (result.count === 0) {
      throw new BadRequestException(
        `Insufficient stock for "${product.name}" (available: ${product.stock})`,
      );
    }
  }
}
