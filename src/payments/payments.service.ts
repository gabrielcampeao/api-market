import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentAttemptStatus, PaymentStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { RequestContext } from '../common/utils/request-context.util';
import { AuthenticatedUser } from '../auth/interfaces/auth.types';
import { PaymentDto } from '../orders/dto/order.dto';
import { withTimeout } from '../common/utils/with-timeout.util';
import { MetricsService } from '../metrics/metrics.service';
import { PAYMENT_PROVIDER, PaymentProvider } from './providers/payment-provider.interface';
import { sourceStatusesFor } from './payment-status.transitions';
const PROVIDER_TIMEOUT_MS = 15000;
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly metrics: MetricsService,
    @Inject(PAYMENT_PROVIDER)
    private readonly provider: PaymentProvider,
  ) {}
  async pay(user: AuthenticatedUser, orderId: string, ctx: RequestContext): Promise<PaymentDto> {
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
      throw new BadRequestException(`Only PENDING orders can be paid (current: ${order.status})`);
    }
    const payment = order.payment;
    if (!payment) {
      throw new BadRequestException('This order has no payment record');
    }
    if (payment.status === PaymentStatus.APPROVED) {
      throw new BadRequestException('This order is already paid');
    }
    const claimed = await this.prisma.payment.updateMany({
      where: {
        id: payment.id,
        status: { in: sourceStatusesFor(PaymentStatus.PROCESSING) },
      },
      data: { status: PaymentStatus.PROCESSING, processingAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('This payment is already being processed or has been settled');
    }
    const attempt = await this.prisma.paymentAttempt.create({
      data: {
        paymentId: payment.id,
        provider: this.provider.name,
        amount: order.total,
        status: PaymentAttemptStatus.PENDING,
      },
    });
    this.metrics.paymentAttemptTotal.inc({ provider: this.provider.name });
    let result;
    try {
      result = await withTimeout(
        this.provider.charge(order.total, order.id, payment.providerIdempotencyKey),
        PROVIDER_TIMEOUT_MS,
        `Provider "${this.provider.name}" did not respond within ${PROVIDER_TIMEOUT_MS}ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.metrics.paymentFailedTotal.inc({
        provider: this.provider.name,
        reason: 'provider_error',
      });
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: PaymentAttemptStatus.ERROR,
          failureMessage: message,
          finishedAt: new Date(),
        },
      });
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PROCESSING },
        data: { status: PaymentStatus.PENDING, processingAt: null },
      });
      await this.audit.log({
        userId: user.id,
        action: 'payment.provider_error',
        entity: 'order',
        entityId: orderId,
        metadata: { provider: this.provider.name, message } as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new BadRequestException('Payment provider unavailable');
    }
    if (!result.approved) {
      this.metrics.paymentFailedTotal.inc({ provider: this.provider.name, reason: 'declined' });
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: PaymentAttemptStatus.DECLINED,
          providerRef: result.providerRef ?? null,
          failureCode: result.failureCode ?? null,
          failureMessage: result.message ?? null,
          finishedAt: new Date(),
        },
      });
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
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: PaymentAttemptStatus.APPROVED,
          providerRef: result.providerRef ?? null,
          finishedAt: new Date(),
        },
      });
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
    this.metrics.paymentApprovedTotal.inc({ provider: this.provider.name });
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
  async getPayment(user: AuthenticatedUser, orderId: string): Promise<PaymentDto> {
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
    amount: {
      toFixed: (digits?: number) => string;
    };
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
