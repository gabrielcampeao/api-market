import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { RequestContext } from '../common/utils/request-context.util';
import { AuthenticatedUser } from '../auth/interfaces/auth.types';
import { PaymentDto } from '../orders/dto/order.dto';
import { PAYMENT_PROVIDER, PaymentProvider } from './providers/payment-provider.interface';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async pay(
    user: AuthenticatedUser,
    orderId: string,
    ctx: RequestContext,
  ): Promise<PaymentDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payment: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (user.role !== Role.ADMIN && order.userId !== user.id) {
      throw new ForbiddenException('Access denied to this order');
    }
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException(
        `Only PENDING orders can be paid (current: ${order.status})`,
      );
    }

    const payment = order.payment;
    if (!payment) {
      throw new BadRequestException('This order has no payment record');
    }
    if (payment.status === PaymentStatus.APPROVED) {
      throw new BadRequestException('This order is already paid');
    }

    // The conditional update is the concurrency boundary: reading the
    // payment's status and then writing it in a separate statement would let
    // two concurrent requests both observe PENDING and both call the
    // provider. `updateMany` with the status filter is a single atomic
    // compare-and-swap at the database level — only one caller's WHERE
    // clause matches, so only one gets `claimed.count === 1`.
    //
    // FAILED is claimable too so a declined payment can be retried; APPROVED
    // is excluded (checked above) and PROCESSING is excluded because another
    // request already holds the claim.
    const claimed = await this.prisma.payment.updateMany({
      where: {
        id: payment.id,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
      },
      data: { status: PaymentStatus.PROCESSING, processingAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ConflictException(
        'This payment is already being processed or has been settled',
      );
    }

    let result;
    try {
      result = await this.provider.charge(order.total, order.id);
    } catch (err) {
      // Provider call failed before returning a result — we don't know if
      // the gateway actually captured the charge or not (e.g. a timeout on
      // our side after the provider processed it). Reverting to PENDING
      // makes the payment retryable, which is correct for a network error
      // but would double-charge if the provider *did* capture it. Closing
      // this gap for real needs a provider-side idempotency key on the
      // charge request so a retry is safe even if the first attempt landed;
      // FakePaymentProvider doesn't model that, so this is a known limitation.
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PROCESSING },
        data: { status: PaymentStatus.PENDING, processingAt: null },
      });
      await this.audit.log({
        userId: user.id,
        action: 'payment.provider_error',
        entity: 'order',
        entityId: orderId,
        metadata: {
          provider: this.provider.name,
          message: err instanceof Error ? err.message : String(err),
        } as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new BadRequestException('Payment provider unavailable');
    }

    if (!result.approved) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.FAILED,
          providerRef: result.providerRef ?? null,
          processingAt: null,
        },
      });
      await this.audit.log({
        userId: user.id,
        action: 'payment.failed',
        entity: 'order',
        entityId: orderId,
        metadata: {
          provider: this.provider.name,
          message: result.message,
        } as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new BadRequestException('Payment was declined by the provider');
    }

    // Use an interactive transaction so the payment update and the order
    // update are truly atomic — no partial state if the process dies mid-write.
    // The order update is conditioned on the order still being PENDING: if it
    // was cancelled while the provider charge was in flight, the charge is
    // reversed instead of silently overwriting the cancellation.
    const outcome = await this.prisma.$transaction(async (tx) => {
      const orderStillPending = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING },
        data: { status: OrderStatus.PAID },
      });

      if (orderStillPending.count === 0) {
        const reversed = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.REFUNDED,
            providerRef: result.providerRef ?? null,
            paidAt: new Date(),
            processingAt: null,
          },
        });
        return { payment: reversed, orderCancelledDuringPayment: true };
      }

      const p = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.APPROVED,
          providerRef: result.providerRef ?? null,
          paidAt: new Date(),
          processingAt: null,
        },
      });
      return { payment: p, orderCancelledDuringPayment: false };
    });

    if (outcome.orderCancelledDuringPayment) {
      await this.audit.log({
        userId: user.id,
        action: 'payment.reversed_order_cancelled',
        entity: 'order',
        entityId: orderId,
        metadata: {
          provider: this.provider.name,
          providerRef: result.providerRef,
          amount: order.total.toFixed(2),
        } as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new BadRequestException(
        'This order was cancelled before the payment could be confirmed. The charge has been reversed.',
      );
    }

    const updated = outcome.payment;
    await this.audit.log({
      userId: user.id,
      action: 'payment.approved',
      entity: 'order',
      entityId: orderId,
      metadata: {
        provider: this.provider.name,
        providerRef: result.providerRef,
        amount: order.total.toFixed(2),
      } as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return this.toPaymentDto(updated);
  }

  async getPayment(
    user: AuthenticatedUser,
    orderId: string,
  ): Promise<PaymentDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payment: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (user.role !== Role.ADMIN && order.userId !== user.id) {
      throw new ForbiddenException('Access denied to this order');
    }
    if (!order.payment) {
      throw new NotFoundException('No payment record for this order');
    }
    return this.toPaymentDto(order.payment);
  }

  private toPaymentDto(payment: {
    id: string;
    provider: string;
    providerRef: string | null;
    status: PaymentStatus;
    amount: { toFixed: (digits?: number) => string };
    paidAt: Date | null;
    createdAt: Date;
  }): PaymentDto {
    return {
      id: payment.id,
      provider: payment.provider,
      providerRef: payment.providerRef,
      status: payment.status,
      amount: payment.amount.toFixed(2),
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
    };
  }
}
