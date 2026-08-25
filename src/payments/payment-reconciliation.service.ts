import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderStatus, PaymentAttemptStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { MetricsService } from '../metrics/metrics.service';
import { withTimeout, TimeoutError } from '../common/utils/with-timeout.util';
import { PAYMENT_PROVIDER, PaymentProvider } from './providers/payment-provider.interface';

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 15_000;

export interface ReconciliationSummary {
  checked: number;
  approved: number;
  declined: number;
  stillUnknown: number;
}

type ReconcileOutcome = 'approved' | 'declined' | 'stillUnknown' | 'alreadySettled' | 'error';

// Recovers payments stuck at PROCESSING (crash-window gap in README's
// Limitations: provider approved but the process died before committing).
// Queries the provider via providerIdempotencyKey instead of guessing from
// local state.
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);
  // Prevents overlapping runs on this instance; the updateMany count-check
  // below is what guards against two different instances racing.
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly metrics: MetricsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async runScheduled(): Promise<void> {
    await this.reconcileStuckPayments();
  }

  async reconcileStuckPayments(staleAfterMs = DEFAULT_STALE_AFTER_MS): Promise<ReconciliationSummary> {
    if (this.isRunning) {
      this.logger.warn('Reconciliation already in progress, skipping this trigger');
      return { checked: 0, approved: 0, declined: 0, stillUnknown: 0 };
    }
    this.isRunning = true;

    try {
      const cutoff = new Date(Date.now() - staleAfterMs);
      const stuck = await this.prisma.payment.findMany({
        where: { status: PaymentStatus.PROCESSING, processingAt: { lte: cutoff } },
        include: { order: true },
      });

      const summary: ReconciliationSummary = { checked: stuck.length, approved: 0, declined: 0, stillUnknown: 0 };
      for (const payment of stuck) {
        let outcome: ReconcileOutcome;
        try {
          outcome = await this.reconcileOne(payment, payment.order);
        } catch (err) {
          // One payment's failure (DB error, or a provider throwing instead
          // of resolving 'unknown') must not stop the rest of the batch.
          this.logger.error(
            `Reconciliation failed for payment ${payment.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          outcome = 'error';
        }
        // alreadySettled/error still count toward payment_reconciliation_total
        // but don't inflate the summary buckets reported back to the caller.
        if (outcome === 'approved' || outcome === 'declined' || outcome === 'stillUnknown') {
          summary[outcome]++;
        }
        this.metrics.paymentReconciliationTotal.inc({ outcome });
      }
      // Gauge (current stuck count), not a running total like the counter above.
      this.metrics.stuckPaymentsTotal.set(summary.stillUnknown);
      if (summary.checked > 0) {
        this.logger.log(
          `Reconciliation: checked=${summary.checked} approved=${summary.approved} declined=${summary.declined} stillUnknown=${summary.stillUnknown}`,
        );
      }
      return summary;
    } finally {
      this.isRunning = false;
    }
  }

  private async reconcileOne(
    payment: { id: string; amount: Prisma.Decimal; providerIdempotencyKey: string },
    order: { id: string; status: OrderStatus },
  ): Promise<ReconcileOutcome> {
    let result;
    try {
      result = await withTimeout(
        this.provider.checkStatus(payment.amount, order.id, payment.providerIdempotencyKey),
        PROVIDER_TIMEOUT_MS,
        `Provider "${this.provider.name}" did not respond to checkStatus within ${PROVIDER_TIMEOUT_MS}ms`,
      );
    } catch (err) {
      if (err instanceof TimeoutError) {
        // Treat like the provider returning 'unknown' — retry next run.
        this.logger.warn(`Reconciliation checkStatus timed out for payment ${payment.id}`);
        return 'stillUnknown';
      }
      throw err;
    }
    if (result.status === 'unknown') {
      return 'stillUnknown';
    }

    // Updates the attempt PaymentsService.pay() already created, rather than
    // creating a new one — history reads as "one call, resolved late".
    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { paymentId: payment.id },
      orderBy: { startedAt: 'desc' },
    });

    if (result.status === 'declined') {
      // Claim first, update the attempt second — if another run/webhook
      // already moved this payment out of PROCESSING, updateMany matches
      // zero rows and we bail before writing a DECLINED attempt that might
      // contradict the real final status set by whichever run won.
      const claim = await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PROCESSING },
        data: { status: PaymentStatus.FAILED, providerRef: result.providerRef ?? null, processingAt: null },
      });
      if (claim.count === 0) {
        return 'alreadySettled';
      }
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
    // reverse the charge if the order was cancelled while this payment was
    // stuck. The payment claim must be the first write here (unlike pay(),
    // there's no earlier PENDING->PROCESSING transition to piggyback on) —
    // otherwise a racing reconciliation run could lose the claim below but
    // still misreport a reversal it never performed.
    const outcome = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PROCESSING },
        data: {
          status: PaymentStatus.APPROVED,
          providerRef: result.providerRef ?? null,
          paidAt: new Date(),
          processingAt: null,
        },
      });
      if (claim.count === 0) {
        return { claimed: false, orderCancelledDuringPayment: false };
      }

      const orderStillPending = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PENDING },
        data: { status: OrderStatus.PAID },
      });

      if (orderStillPending.count === 0) {
        // The order was cancelled while this payment was stuck — reverse
        // the APPROVED status the claim above just wrote.
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.REFUNDED },
        });
      }

      if (attempt) {
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: PaymentAttemptStatus.APPROVED, providerRef: result.providerRef ?? null, finishedAt: new Date() },
        });
      }

      return { claimed: true, orderCancelledDuringPayment: orderStillPending.count === 0 };
    });

    if (!outcome.claimed) {
      return 'alreadySettled';
    }

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
