import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderStatus, PaymentAttemptStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { PAYMENT_PROVIDER, PaymentProvider } from './providers/payment-provider.interface';

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export interface ReconciliationSummary {
  checked: number;
  approved: number;
  declined: number;
  stillUnknown: number;
}

// Recovers payments stuck at PROCESSING — the crash-window gap documented in
// README.md's Limitations section: the provider approved but this process
// died before the follow-up transaction committed. Runs by querying the
// provider (using the payment's providerIdempotencyKey — see
// PaymentProvider.checkStatus) instead of guessing from local state alone.
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async runScheduled(): Promise<void> {
    await this.reconcileStuckPayments();
  }

  async reconcileStuckPayments(staleAfterMs = DEFAULT_STALE_AFTER_MS): Promise<ReconciliationSummary> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const stuck = await this.prisma.payment.findMany({
      where: { status: PaymentStatus.PROCESSING, processingAt: { lte: cutoff } },
      include: { order: true },
    });

    const summary: ReconciliationSummary = { checked: stuck.length, approved: 0, declined: 0, stillUnknown: 0 };
    for (const payment of stuck) {
      const outcome = await this.reconcileOne(payment, payment.order);
      summary[outcome]++;
    }
    if (summary.checked > 0) {
      this.logger.log(
        `Reconciliation: checked=${summary.checked} approved=${summary.approved} declined=${summary.declined} stillUnknown=${summary.stillUnknown}`,
      );
    }
    return summary;
  }

  private async reconcileOne(
    payment: { id: string; amount: Prisma.Decimal; providerIdempotencyKey: string },
    order: { id: string; status: OrderStatus },
  ): Promise<'approved' | 'declined' | 'stillUnknown'> {
    const result = await this.provider.checkStatus(payment.amount, order.id, payment.providerIdempotencyKey);
    if (result.status === 'unknown') {
      return 'stillUnknown';
    }

    // The attempt PaymentsService.pay() created before calling the provider —
    // reconciliation updates that record rather than creating a new one, so
    // the attempt history still reads as "one call, resolved late" instead
    // of inventing a second attempt that never happened.
    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { paymentId: payment.id },
      orderBy: { startedAt: 'desc' },
    });

    if (result.status === 'declined') {
      if (attempt) {
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
      }
      // Condition on still-PROCESSING: if this payment somehow already
      // settled through another path between the provider call above and
      // this write, don't clobber it.
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PROCESSING },
        data: { status: PaymentStatus.FAILED, providerRef: result.providerRef ?? null, processingAt: null },
      });
      await this.audit.log({
        action: 'payment.reconciled_declined',
        entity: 'order',
        entityId: order.id,
        metadata: {
          provider: this.provider.name,
          providerRef: result.providerRef,
          message: result.message,
        } as Prisma.InputJsonValue,
      });
      return 'declined';
    }

    // Approved — same order-vs-payment atomicity as PaymentsService.pay():
    // if the order was cancelled while this payment was stuck, reverse the
    // charge instead of marking a cancelled order as paid.
    const outcome = await this.prisma.$transaction(async (tx) => {
      if (attempt) {
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: PaymentAttemptStatus.APPROVED, providerRef: result.providerRef ?? null, finishedAt: new Date() },
        });
      }

      const orderStillPending = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PENDING },
        data: { status: OrderStatus.PAID },
      });

      const claim = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PROCESSING },
        data: {
          status: orderStillPending.count > 0 ? PaymentStatus.APPROVED : PaymentStatus.REFUNDED,
          providerRef: result.providerRef ?? null,
          paidAt: new Date(),
          processingAt: null,
        },
      });

      return { orderCancelledDuringPayment: orderStillPending.count === 0, claimed: claim.count === 1 };
    });

    await this.audit.log({
      action: outcome.orderCancelledDuringPayment
        ? 'payment.reconciled_reversed_order_cancelled'
        : 'payment.reconciled_approved',
      entity: 'order',
      entityId: order.id,
      metadata: {
        provider: this.provider.name,
        providerRef: result.providerRef,
      } as Prisma.InputJsonValue,
    });
    return 'approved';
  }
}
