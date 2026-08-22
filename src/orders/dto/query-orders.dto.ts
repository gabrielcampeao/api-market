import { ApiPropertyOptional } from '@nestjs/swagger';
import { Field, InputType } from '@nestjs/graphql';
import { OrderStatus } from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

@InputType()
export class QueryOrdersDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: OrderStatus })
  @Field(() => OrderStatus, { nullable: true })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ example: '2026-01-01' })
  @Field({ nullable: true })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @Field({ nullable: true })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
