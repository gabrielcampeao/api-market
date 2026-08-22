import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { OrdersService } from './orders.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiPaginatedResponse } from '../common/decorators/api-paginated-response.decorator';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { getRequestContext } from '../common/utils/request-context.util';
import { AuthenticatedUser } from '../auth/interfaces/auth.types';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { OrderDto, toOrderDto } from './dto/order.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
@SkipThrottle({ auth: true })
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('checkout')
  @Idempotent()
  @ApiOperation({ summary: 'Checkout the current cart into a new order' })
  @ApiCreatedResponse({ type: OrderDto })
  checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<OrderDto> {
    return this.ordersService.checkout(user.id, getRequestContext(req));
  }

  @Get('mine')
  @ApiOperation({ summary: 'List my orders with pagination and filters' })
  @ApiPaginatedResponse(OrderDto)
  findMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryOrdersDto,
  ): Promise<PaginatedResponseDto<OrderDto>> {
    return this.ordersService.findAllForUser(user.id, query);
  }

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List all orders with pagination and filters (admin)' })
  @ApiPaginatedResponse(OrderDto)
  findAll(@Query() query: QueryOrdersDto): Promise<PaginatedResponseDto<OrderDto>> {
    return this.ordersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an order (owner or admin)' })
  @ApiOkResponse({ type: OrderDto })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<OrderDto> {
    const order =
      user.role === Role.ADMIN
        ? await this.ordersService.findById(id)
        : await this.ordersService.findById(id, user.id);
    return toOrderDto(order);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a PENDING order (owner)' })
  @ApiOkResponse({ type: OrderDto })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<OrderDto> {
    return this.ordersService.cancel(user.id, id, getRequestContext(req));
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Advance an order status (admin)' })
  @ApiOkResponse({ type: OrderDto })
  updateStatus(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @Req() req: Request,
  ): Promise<OrderDto> {
    return this.ordersService.updateStatus(admin.id, id, dto, getRequestContext(req));
  }
}
