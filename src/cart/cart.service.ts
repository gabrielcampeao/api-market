import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CartItem } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { RequestContext } from '../common/utils/request-context.util';
import { CartItemWithProduct } from './dto/cart.dto';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';

const MAX_QUANTITY = 99;

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async getCart(userId: string): Promise<{
    items: CartItemWithProduct[];
    totalItems: number;
    total: string;
  }> {
    const items = await this.prisma.cartItem.findMany({
      where: { userId },
      include: { product: true },
      orderBy: { createdAt: 'asc' },
    });

    const total = items.reduce(
      (acc, item) => acc.add(item.product.price.mul(item.quantity)),
      new Decimal(0),
    );

    return {
      items,
      totalItems: items.reduce((acc, item) => acc + item.quantity, 0),
      total: total.toFixed(2),
    };
  }

  async addItem(
    userId: string,
    dto: AddCartItemDto,
    ctx: RequestContext,
  ): Promise<CartItem> {
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
    });
    if (!product || !product.isActive) {
      throw new NotFoundException('Product not found');
    }

    const existing = await this.prisma.cartItem.findUnique({
      where: { userId_productId: { userId, productId: dto.productId } },
    });

    const newQuantity = (existing?.quantity ?? 0) + dto.quantity;
    if (newQuantity > MAX_QUANTITY) {
      throw new BadRequestException(
        `A single cart item cannot exceed ${MAX_QUANTITY} units`,
      );
    }
    if (newQuantity > product.stock) {
      throw new BadRequestException(
        `Insufficient stock for "${product.name}" (available: ${product.stock})`,
      );
    }

    const item = await this.prisma.cartItem.upsert({
      where: { userId_productId: { userId, productId: dto.productId } },
      create: { userId, productId: dto.productId, quantity: newQuantity },
      update: { quantity: newQuantity },
    });

    await this.audit.log({
      userId,
      action: 'cart.add_item',
      entity: 'cart_item',
      entityId: item.id,
      metadata: { productId: dto.productId, quantity: newQuantity },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return item;
  }

  async updateItem(
    userId: string,
    productId: string,
    dto: UpdateCartItemDto,
    ctx: RequestContext,
  ): Promise<CartItem> {
    const item = await this.prisma.cartItem.findUnique({
      where: { userId_productId: { userId, productId } },
    });
    if (!item) {
      throw new NotFoundException('Cart item not found');
    }

    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product || !product.isActive) {
      throw new NotFoundException('Product not found');
    }
    if (dto.quantity > product.stock) {
      throw new BadRequestException(
        `Insufficient stock for "${product.name}" (available: ${product.stock})`,
      );
    }

    const updated = await this.prisma.cartItem.update({
      where: { id: item.id },
      data: { quantity: dto.quantity },
    });

    await this.audit.log({
      userId,
      action: 'cart.update_item',
      entity: 'cart_item',
      entityId: item.id,
      metadata: { productId, quantity: dto.quantity },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  }

  async removeItem(
    userId: string,
    productId: string,
    ctx: RequestContext,
  ): Promise<{ message: string }> {
    const item = await this.prisma.cartItem.findUnique({
      where: { userId_productId: { userId, productId } },
    });
    if (!item) {
      throw new NotFoundException('Cart item not found');
    }
    await this.prisma.cartItem.delete({ where: { id: item.id } });

    await this.audit.log({
      userId,
      action: 'cart.remove_item',
      entity: 'cart_item',
      entityId: item.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { message: 'Item removed from cart' };
  }

  async clear(userId: string, ctx: RequestContext): Promise<{ message: string }> {
    const deleted = await this.prisma.cartItem.deleteMany({ where: { userId } });

    await this.audit.log({
      userId,
      action: 'cart.clear',
      entity: 'cart_item',
      metadata: { removed: deleted.count },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { message: 'Cart cleared' };
  }

  async countItems(userId: string): Promise<number> {
    return this.prisma.cartItem.count({ where: { userId } });
  }
}
