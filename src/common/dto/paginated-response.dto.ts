import { ApiProperty } from '@nestjs/swagger';
import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType('PaginationMeta')
export class PaginationMetaDto {
  @ApiProperty({ example: 1 })
  @Field()
  page: number;

  @ApiProperty({ example: 10 })
  @Field()
  limit: number;

  @ApiProperty({ example: 42 })
  @Field()
  total: number;

  @ApiProperty({ example: 5 })
  @Field()
  totalPages: number;

  @ApiProperty({ example: true })
  @Field()
  hasNextPage: boolean;

  @ApiProperty({ example: false })
  @Field()
  hasPreviousPage: boolean;
}

export class PaginatedResponseDto<T> {
  items: T[];
  meta: PaginationMetaDto;

  constructor(items: T[], meta: PaginationMetaDto) {
    this.items = items;
    this.meta = meta;
  }
}

export function buildPaginationMeta(
  total: number,
  page: number,
  limit: number,
): PaginationMetaDto {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

