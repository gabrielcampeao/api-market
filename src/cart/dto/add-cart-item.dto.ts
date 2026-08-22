import { ApiProperty } from '@nestjs/swagger';
import { Field, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

@InputType()
export class AddCartItemDto {
  @ApiProperty({ format: 'uuid' })
  @Field()
  @IsUUID()
  productId: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 99 })
  @Field()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity: number;
}
