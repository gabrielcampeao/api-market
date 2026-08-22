import { ApiProperty } from '@nestjs/swagger';
import { Field, ObjectType } from '@nestjs/graphql';
import { Prisma } from '@prisma/client';
import { toProductDto, ProductDto } from '../../products/dto/product.dto';

export type CartItemWithProduct = Prisma.CartItemGetPayload<{
  include: { product: true };
}>;

@ObjectType('CartItem')
export class CartItemDto {
  @ApiProperty()
  @Field(() => ProductDto)
  product: ProductDto;

  @ApiProperty({ example: 2 })
  @Field()
  quantity: number;

  @ApiProperty({ example: '59.80' })
  @Field()
  subtotal: string;
}

@ObjectType('Cart')
export class CartDto {
  @ApiProperty({ type: [CartItemDto] })
  @Field(() => [CartItemDto])
  items: CartItemDto[];

  @ApiProperty({ example: 2 })
  @Field()
  totalItems: number;

  @ApiProperty({ example: '59.80' })
  @Field()
  total: string;
}

export function toCartItemDto(cartItem: CartItemWithProduct): CartItemDto {
  return {
    product: toProductDto(cartItem.product),
    quantity: cartItem.quantity,
    subtotal: cartItem.product.price.mul(cartItem.quantity).toFixed(2),
  };
}
