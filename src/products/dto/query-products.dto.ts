import { ApiPropertyOptional } from '@nestjs/swagger';
import { Field, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

const SORTABLE = ['name', 'price', 'createdAt'] as const;

@InputType()
export class QueryProductsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Search by name (case-insensitive)' })
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({ example: 10 })
  @Field({ nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ example: 500 })
  @Field({ nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({ enum: ['name', 'price', 'createdAt'], default: 'createdAt' })
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsIn(SORTABLE)
  sortBy?: (typeof SORTABLE)[number];

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
