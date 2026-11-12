import { Args, Context, ID, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { ProductsService } from '../../products/products.service';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { getRequestContext } from '../../common/utils/request-context.util';
import { AuthenticatedUser } from '../../auth/interfaces/auth.types';
import { ProductDto, toProductDto } from '../../products/dto/product.dto';
import { CreateProductDto } from '../../products/dto/create-product.dto';
import { UpdateProductDto } from '../../products/dto/update-product.dto';
import { QueryProductsDto } from '../../products/dto/query-products.dto';
import { MessageResponse } from '../types/message.type';
import { Paginated } from '../paginated.type';

@ObjectType()
export class PaginatedProductsDto extends Paginated(ProductDto) {}

@Resolver(() => ProductDto)
export class ProductsResolver {
  constructor(private readonly productsService: ProductsService) {}

  @Public()
  @Query(() => PaginatedProductsDto)
  products(@Args('query', { nullable: true }) query: QueryProductsDto = new QueryProductsDto()) {
    return this.productsService.findAll(query);
  }

  @Public()
  @Query(() => ProductDto)
  async product(@Args('id', { type: () => ID }) id: string): Promise<ProductDto> {
    const product = await this.productsService.findById(id, true);
    return toProductDto(product);
  }

  @Roles(Role.ADMIN)
  @Mutation(() => ProductDto)
  async createProduct(
    @Args('input') dto: CreateProductDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<ProductDto> {
    return this.productsService.create(admin.id, dto, getRequestContext(req));
  }

  @Roles(Role.ADMIN)
  @Mutation(() => ProductDto)
  async updateProduct(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') dto: UpdateProductDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<ProductDto> {
    return this.productsService.update(admin.id, id, dto, getRequestContext(req));
  }

  @Roles(Role.ADMIN)
  @Mutation(() => MessageResponse)
  async deactivateProduct(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<MessageResponse> {
    return this.productsService.softDelete(admin.id, id, getRequestContext(req));
  }
}
