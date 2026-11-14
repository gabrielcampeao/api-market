import { Type } from '@nestjs/common';
import { Field, ObjectType } from '@nestjs/graphql';
import { PaginationMetaDto } from '../common/dto/paginated-response.dto';
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
