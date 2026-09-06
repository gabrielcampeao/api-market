import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { CartService } from './cart.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { getRequestContext } from '../common/utils/request-context.util';
import { AuthenticatedUser } from '../auth/interfaces/auth.types';
import { CartDto, toCartItemDto } from './dto/cart.dto';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';

@ApiTags('cart')
@ApiBearerAuth()
@Controller('cart')
@SkipThrottle({ auth: true })
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  @ApiOperation({ summary: 'Get the current user cart' })
  @ApiOkResponse({ type: CartDto })
  async getCart(@CurrentUser() user: AuthenticatedUser): Promise<CartDto> {
    const cart = await this.cartService.getCart(user.id);
    return {
      items: cart.items.map(toCartItemDto),
      totalItems: cart.totalItems,
      total: cart.total,
    };
  }

  @Get('count')
  @ApiOperation({ summary: 'Get the number of cart items' })
  @ApiOkResponse({ description: 'Item count' })
  async count(@CurrentUser() user: AuthenticatedUser): Promise<{ count: number }> {
    const count = await this.cartService.countItems(user.id);
    return { count };
  }

  @Post('items')
  @ApiOperation({ summary: 'Add a product to the cart (upserts quantity)' })
  @ApiCreatedResponse({ description: 'Product added to cart' })
  async addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddCartItemDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const item = await this.cartService.addItem(user.id, dto, getRequestContext(req));
    return { message: `Added to cart (quantity: ${item.quantity})` };
  }

  @Patch('items/:productId')
  @ApiOperation({ summary: 'Update the quantity of a cart item' })
  @ApiOkResponse({ description: 'Quantity updated' })
  async updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body() dto: UpdateCartItemDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const item = await this.cartService.updateItem(user.id, productId, dto, getRequestContext(req));
    return { message: `Quantity updated (quantity: ${item.quantity})` };
  }

  @Delete('items/:productId')
  @ApiOperation({ summary: 'Remove a product from the cart' })
  @ApiOkResponse({ description: 'Item removed' })
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.cartService.removeItem(user.id, productId, getRequestContext(req));
  }

  @Delete()
  @ApiOperation({ summary: 'Clear the entire cart' })
  @ApiOkResponse({ description: 'Cart cleared' })
  clear(@CurrentUser() user: AuthenticatedUser, @Req() req: Request): Promise<{ message: string }> {
    return this.cartService.clear(user.id, getRequestContext(req));
  }
}
