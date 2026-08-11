import { Args, Context, ID, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { OrdersService } from '../../orders/orders.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { getRequestContext } from '../../common/utils/request-context.util';
import { AuthenticatedUser } from '../../auth/interfaces/auth.types';
import { OrderDto, toOrderDto } from '../../orders/dto/order.dto';
import { QueryOrdersDto } from '../../orders/dto/query-orders.dto';
import { UpdateOrderStatusDto } from '../../orders/dto/update-order-status.dto';
import { Paginated } from '../paginated.type';

@ObjectType()
export class PaginatedOrdersDto extends Paginated(OrderDto) {}

@Resolver(() => OrderDto)
export class OrdersResolver {
  constructor(private readonly ordersService: OrdersService) {}

  @Mutation(() => OrderDto)
  checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<OrderDto> {
    return this.ordersService.checkout(user.id, getRequestContext(req));
  }

  @Query(() => PaginatedOrdersDto)
  myOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Args('query', { nullable: true }) query: QueryOrdersDto = new QueryOrdersDto(),
  ) {
    return this.ordersService.findAllForUser(user.id, query);
  }

  @Roles(Role.ADMIN)
  @Query(() => PaginatedOrdersDto)
  orders(@Args('query', { nullable: true }) query: QueryOrdersDto = new QueryOrdersDto()) {
    return this.ordersService.findAll(query);
  }

  @Query(() => OrderDto)
  async order(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderDto> {
    const order =
      user.role === Role.ADMIN
        ? await this.ordersService.findById(id)
        : await this.ordersService.findById(id, user.id);
    return toOrderDto(order);
  }

  @Mutation(() => OrderDto)
  cancelOrder(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<OrderDto> {
    return this.ordersService.cancel(user.id, id, getRequestContext(req));
  }

  @Roles(Role.ADMIN)
  @Mutation(() => OrderDto)
  updateOrderStatus(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') dto: UpdateOrderStatusDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<OrderDto> {
    return this.ordersService.updateStatus(admin.id, id, dto, getRequestContext(req));
  }
}
