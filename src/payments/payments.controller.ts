import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { PaymentsService } from './payments.service';
import { PaymentReconciliationService, ReconciliationSummary } from './payment-reconciliation.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { getRequestContext } from '../common/utils/request-context.util';
import { AuthenticatedUser } from '../auth/interfaces/auth.types';
import { PaymentDto } from '../orders/dto/order.dto';

@ApiTags('payments')
@ApiBearerAuth()
@Controller()
@SkipThrottle({ auth: true })
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly reconciliation: PaymentReconciliationService,
  ) {}

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

  @Post('payments/reconcile')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Manually trigger reconciliation of payments stuck in PROCESSING',
    description:
      'Runs automatically every 5 minutes; this exists to trigger it on demand ' +
      '(e.g. right after simulating a crash) without waiting for the schedule.',
  })
  @ApiOkResponse({
    schema: {
      properties: {
        checked: { type: 'number' },
        approved: { type: 'number' },
        declined: { type: 'number' },
        stillUnknown: { type: 'number' },
      },
    },
  })
  reconcile(): Promise<ReconciliationSummary> {
    return this.reconciliation.reconcileStuckPayments();
  }
}
