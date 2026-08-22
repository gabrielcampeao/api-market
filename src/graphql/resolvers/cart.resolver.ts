import { Args, Context, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Request } from 'express';
import { CartService } from '../../cart/cart.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { getRequestContext } from '../../common/utils/request-context.util';
import { AuthenticatedUser } from '../../auth/interfaces/auth.types';
import { CartDto, toCartItemDto } from '../../cart/dto/cart.dto';
import { AddCartItemDto } from '../../cart/dto/add-cart-item.dto';
import { UpdateCartItemDto } from '../../cart/dto/update-cart-item.dto';
import { MessageResponse } from '../types/message.type';

@Resolver(() => CartDto)
export class CartResolver {
  constructor(private readonly cartService: CartService) {}

  @Query(() => CartDto)
  async cart(@CurrentUser() user: AuthenticatedUser): Promise<CartDto> {
    const cart = await this.cartService.getCart(user.id);
    return {
      items: cart.items.map(toCartItemDto),
      totalItems: cart.totalItems,
      total: cart.total,
    };
  }

  @Query(() => Int)
  cartCount(@CurrentUser() user: AuthenticatedUser): Promise<number> {
    return this.cartService.countItems(user.id);
  }

  @Mutation(() => MessageResponse)
  async addCartItem(
    @Args('input') dto: AddCartItemDto,
    @CurrentUser() user: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<MessageResponse> {
    const item = await this.cartService.addItem(user.id, dto, getRequestContext(req));
    return { message: `Added to cart (quantity: ${item.quantity})` };
  }

  @Mutation(() => MessageResponse)
  async updateCartItem(
    @Args('productId') productId: string,
    @Args('input') dto: UpdateCartItemDto,
    @CurrentUser() user: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<MessageResponse> {
    const item = await this.cartService.updateItem(
      user.id,
      productId,
      dto,
      getRequestContext(req),
    );
    return { message: `Quantity updated (quantity: ${item.quantity})` };
  }

  @Mutation(() => MessageResponse)
  removeCartItem(
    @Args('productId') productId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<MessageResponse> {
    return this.cartService.removeItem(user.id, productId, getRequestContext(req));
  }

  @Mutation(() => MessageResponse)
  clearCart(
    @CurrentUser() user: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<MessageResponse> {
    return this.cartService.clear(user.id, getRequestContext(req));
  }
}
