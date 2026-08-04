import { Product } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType('Product')
export class ProductDto {
  @ApiProperty({ format: 'uuid' })
  @Field(() => ID)
  id: string;

  @ApiProperty({ example: 'Wireless Mouse' })
  @Field()
  name: string;

  @ApiPropertyOptional()
  @Field(() => String, { nullable: true })
  description?: string | null;

  // Represented as a decimal string (like the REST DTO) instead of Float —
  // floats can't losslessly round-trip currency amounts.
  @ApiProperty({ example: '29.90' })
  @Field()
  price: string;

  @ApiProperty({ example: 100 })
  @Field()
  stock: number;

  @ApiProperty({ example: true })
  @Field()
  isActive: boolean;

  @ApiProperty()
  @Field()
  createdAt: Date;

  @ApiProperty()
  @Field()
  updatedAt: Date;
}

export function toProductDto(product: Product): ProductDto {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price.toFixed(2),
    stock: product.stock,
    isActive: product.isActive,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}
