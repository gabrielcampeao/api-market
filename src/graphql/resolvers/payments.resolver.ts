import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Context } from '@nestjs/graphql';
import { Request } from 'express';
import { PaymentsService } from '../../payments/payments.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { getRequestContext } from '../../common/utils/request-context.util';
import { AuthenticatedUser } from '../../auth/interfaces/auth.types';
import { PaymentDto } from '../../orders/dto/order.dto';

@Resolver(() => PaymentDto)
export class PaymentsResolver {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Mutation(() => PaymentDto)
  payOrder(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<PaymentDto> {
    return this.paymentsService.pay(user, orderId, getRequestContext(req));
  }

  @Query(() => PaymentDto)
  payment(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentDto> {
    return this.paymentsService.getPayment(user, orderId);
  }
}
