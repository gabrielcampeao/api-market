import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { MailService } from '../mail/mail.service';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
} from '../payments/providers/payment-provider.interface';
import { RequestContext } from '../common/utils/request-context.util';
import { buildPaginationMeta, PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { toOrderDto, OrderDto, OrderWithRelations } from './dto/order.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { ORDER_TRANSITIONS } from './order-status.transitions';
const ORDER_INCLUDE = {
  items: { include: { product: true } },
  payment: true,
} satisfies Prisma.OrderInclude;
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly mail: MailService,
    @Inject(PAYMENT_PROVIDER)
    private readonly paymentProvider: PaymentProvider,
  ) {}
  async checkout(userId: string, ctx: RequestContext): Promise<OrderDto> {
    const cartItems = await this.prisma.cartItem.findMany({
      where: { userId },
      include: { product: true },
    });
    if (cartItems.length === 0) {
      throw new BadRequestException('Cart is empty');
    }
    const order = await this.prisma.$transaction(
      async (tx) => {
        const products = await tx.product.findMany({
          where: { id: { in: cartItems.map((i) => i.productId) } },
        });
        const productMap = new Map(products.map((p) => [p.id, p]));
        let total = new Decimal(0);
        const lines = cartItems.map((item) => {
          const product = productMap.get(item.productId);
          if (!product || !product.isActive) {
            throw new BadRequestException(`Product ${item.productId} is no longer available`);
          }
          if (product.stock < item.quantity) {
            throw new BadRequestException(
              `Insufficient stock for "${product.name}" (available: ${product.stock})`,
            );
          }
          total = total.add(product.price.mul(item.quantity));
          return { product, quantity: item.quantity };
        });
        for (const line of lines) {
          const result = await tx.product.updateMany({
            where: { id: line.product.id, stock: { gte: line.quantity } },
            data: { stock: { decrement: line.quantity } },
          });
          if (result.count === 0) {
            throw new BadRequestException(`Insufficient stock for "${line.product.name}"`);
          }
        }
        const created = await tx.order.create({
          data: {
            userId,
            total,
            items: {
              create: lines.map((line) => ({
                productId: line.product.id,
                quantity: line.quantity,
                price: line.product.price,
              })),
            },
            payment: {
              create: {
                provider: this.paymentProvider.name,
                amount: total,
                providerIdempotencyKey: randomUUID(),
              },
            },
          },
          include: ORDER_INCLUDE,
        });
        await tx.cartItem.deleteMany({ where: { userId } });
        return created;
      },
      { timeout: 10000 },
    );
    const owner = await this.prisma.user.findUnique({ where: { id: userId } });
    try {
      await this.mail.sendOrderConfirmation(
        owner?.email ?? 'unknown@marketplace.dev',
        order.id,
        order.total.toFixed(2),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send order confirmation for order ${order.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.audit.log({
      userId,
      action: 'order.checkout',
      entity: 'order',
      entityId: order.id,
      metadata: { total: order.total.toFixed(2) } as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return toOrderDto(order as OrderWithRelations);
  }
  async findAllForUser(
    userId: string,
    query: QueryOrdersDto,
  ): Promise<PaginatedResponseDto<OrderDto>> {
    return this.paginate({ ...query, userId });
  }
  async findAll(query: QueryOrdersDto): Promise<PaginatedResponseDto<OrderDto>> {
    return this.paginate(query);
  }
  async findById(orderId: string, userId?: string): Promise<OrderWithRelations> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (userId !== undefined && order.userId !== userId) {
      throw new ForbiddenException('Access denied to this order');
    }
    return order as OrderWithRelations;
  }
  async cancel(userId: string, orderId: string, ctx: RequestContext): Promise<OrderDto> {
    const order = await this.findById(orderId, userId);
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException(
        `Only PENDING orders can be cancelled (current: ${order.status})`,
      );
    }
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING },
        data: { status: OrderStatus.CANCELLED },
      });
      if (changed.count === 0) {
        throw new BadRequestException('Order status has changed — cannot cancel');
      }
      await this.restoreStock(tx, order);
      return tx.order.findUnique({
        where: { id: orderId },
        include: ORDER_INCLUDE,
      });
    });
    await this.audit.log({
      userId,
      action: 'order.cancel',
      entity: 'order',
      entityId: orderId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return toOrderDto(cancelled as OrderWithRelations);
  }
  async updateStatus(
    adminId: string,
    orderId: string,
    dto: UpdateOrderStatusDto,
    ctx: RequestContext,
  ): Promise<OrderDto> {
    const order = await this.findById(orderId);
    const allowed = ORDER_TRANSITIONS[order.status];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(
        `Cannot transition order from ${order.status} to ${dto.status}`,
      );
    }
    if (dto.status === OrderStatus.PAID) {
      throw new BadRequestException('Set the order as PAID through the payment endpoint');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status: dto.status },
      });
      if (changed.count === 0) {
        throw new BadRequestException('Order status has changed — retry');
      }
      if (dto.status === OrderStatus.CANCELLED) {
        await this.restoreStock(tx, order);
        if (order.status === OrderStatus.PAID && order.payment) {
          await tx.payment.update({
            where: { id: order.payment.id },
            data: { status: PaymentStatus.REFUNDED },
          });
        }
      }
      return tx.order.findUnique({
        where: { id: orderId },
        include: ORDER_INCLUDE,
      });
    });
    await this.audit.log({
      userId: adminId,
      action: 'order.status_change',
      entity: 'order',
      entityId: orderId,
      metadata: { from: order.status, to: dto.status } as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return toOrderDto(updated as OrderWithRelations);
  }
  private async paginate(
    query: QueryOrdersDto & {
      userId?: string;
    },
  ): Promise<PaginatedResponseDto<OrderDto>> {
    const { page, limit } = query;
    const where: Prisma.OrderWhereInput = {};
    if (query.userId) {
      where.userId = query.userId;
    }
    if (query.status) {
      where.status = query.status;
    }
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) {
        where.createdAt.gte = new Date(query.from);
      }
      if (query.to) {
        where.createdAt.lte = new Date(query.to);
      }
    }
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return new PaginatedResponseDto(
      (rows as OrderWithRelations[]).map(toOrderDto),
      buildPaginationMeta(total, page, limit),
    );
  }
  private async restoreStock(
    tx: Prisma.TransactionClient,
    order: OrderWithRelations,
  ): Promise<void> {
    for (const item of order.items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: { increment: item.quantity } },
      });
    }
  }
}
