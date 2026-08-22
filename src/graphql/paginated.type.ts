import { Type } from '@nestjs/common';
import { Field, ObjectType } from '@nestjs/graphql';
import { PaginationMetaDto } from '../common/dto/paginated-response.dto';

// GraphQL has no notion of TS generics, so a paginated response type has to
// be generated per item type. This mirrors PaginatedResponseDto<T> from the
// REST layer so both APIs expose the same pagination shape.
export function Paginated<T>(ItemType: Type<T>) {
  @ObjectType(`Paginated${ItemType.name}`, { isAbstract: true })
  abstract class PaginatedType {
    @Field(() => [ItemType])
    items: T[];

    @Field(() => PaginationMetaDto)
    meta: PaginationMetaDto;
  }
  return PaginatedType;
}
