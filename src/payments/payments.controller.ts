import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { PaymentsService } from './payments.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { getRequestContext } from '../common/utils/request-context.util';
import { AuthenticatedUser } from '../auth/interfaces/auth.types';
import { PaymentDto } from '../orders/dto/order.dto';

@ApiTags('payments')
@ApiBearerAuth()
@Controller()
@SkipThrottle({ auth: true })
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('orders/:id/pay')
  @Idempotent()
  @ApiOperation({ summary: 'Charge a PENDING order via the payment provider' })
  @ApiCreatedResponse({ type: PaymentDto })
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') orderId: string,
    @Req() req: Request,
  ): Promise<PaymentDto> {
    return this.paymentsService.pay(user, orderId, getRequestContext(req));
  }

  @Get('orders/:id/payment')
  @ApiOperation({ summary: 'Get the payment record for an order' })
  @ApiOkResponse({ type: PaymentDto })
  getPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') orderId: string,
  ): Promise<PaymentDto> {
    return this.paymentsService.getPayment(user, orderId);
  }
}
