import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Field, ID, ObjectType } from '@nestjs/graphql';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';

export type OrderWithRelations = Prisma.OrderGetPayload<{
  include: { items: { include: { product: true } }; payment: true };
}>;

@ObjectType('OrderItem')
export class OrderItemDto {
  @ApiProperty({ format: 'uuid' })
  @Field(() => ID)
  id: string;

  @ApiProperty({ format: 'uuid' })
  @Field(() => ID)
  productId: string;

  @ApiProperty({ example: 'Wireless Mouse' })
  @Field()
  productName: string;

  @ApiProperty({ example: 2 })
  @Field()
  quantity: number;

  @ApiProperty({ example: '29.90' })
  @Field()
  price: string;
}

@ObjectType('Payment')
export class PaymentDto {
  @ApiProperty({ format: 'uuid' })
  @Field(() => ID)
  id: string;

  @ApiProperty({ example: 'fake' })
  @Field()
  provider: string;

  @ApiPropertyOptional()
  @Field(() => String, { nullable: true })
  providerRef?: string | null;

  @ApiProperty({ enum: PaymentStatus })
  @Field(() => PaymentStatus)
  status: PaymentStatus;

  @ApiProperty({ example: '59.80' })
  @Field()
  amount: string;

  @ApiPropertyOptional()
  @Field(() => Date, { nullable: true })
  paidAt?: Date | null;

  @ApiProperty()
  @Field()
  createdAt: Date;
}

@ObjectType('Order')
export class OrderDto {
  @ApiProperty({ format: 'uuid' })
  @Field(() => ID)
  id: string;

  @ApiProperty({ format: 'uuid' })
  @Field(() => ID)
  userId: string;

  @ApiProperty({ enum: OrderStatus })
  @Field(() => OrderStatus)
  status: OrderStatus;

  @ApiProperty({ example: '59.80' })
  @Field()
  total: string;

  @ApiProperty({ type: [OrderItemDto] })
  @Field(() => [OrderItemDto])
  items: OrderItemDto[];

  @ApiPropertyOptional({ type: PaymentDto })
  @Field(() => PaymentDto, { nullable: true })
  payment?: PaymentDto | null;

  @ApiProperty()
  @Field()
  createdAt: Date;

  @ApiProperty()
  @Field()
  updatedAt: Date;
}

export function toOrderDto(order: OrderWithRelations): OrderDto {
  return {
    id: order.id,
    userId: order.userId,
    status: order.status,
    total: order.total.toFixed(2),
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productName: item.product.name,
      quantity: item.quantity,
      price: item.price.toFixed(2),
    })),
    payment: order.payment
      ? {
          id: order.payment.id,
          provider: order.payment.provider,
          providerRef: order.payment.providerRef,
          status: order.payment.status,
          amount: order.payment.amount.toFixed(2),
          paidAt: order.payment.paidAt,
          createdAt: order.payment.createdAt,
        }
      : null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
