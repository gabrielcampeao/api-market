import { ApiProperty } from '@nestjs/swagger';
import { Field, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

@InputType()
export class UpdateCartItemDto {
  @ApiProperty({ example: 3, minimum: 1, maximum: 99 })
  @Field()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity: number;
}
