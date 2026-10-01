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

// Recovers payments stuck at PROCESSING — the crash-window gap documented in
// README.md's Limitations section: the provider approved but this process
// died before the follow-up transaction committed. Runs by querying the
// provider (using the payment's providerIdempotencyKey — see
// PaymentProvider.checkStatus) instead of guessing from local state alone.
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);
  // Guards against the cron tick firing again while a previous run (or an
  // admin-triggered POST /payments/reconcile) is still in flight on this
  // same instance — without it, two overlapping runs would both fetch the
  // same stuck payment and both call the provider for it. This only
  // protects a single instance; the updateMany count-check below is what
  // protects against two *different* instances (or this guard's own
  // process, if it somehow slipped past) both trying to settle the same
  // payment at once.
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
          // One payment's DB error (or an unexpected provider throw —
          // checkStatus is documented to resolve 'unknown' rather than
          // throw, but this is the backstop if a provider implementation
          // doesn't honor that) must not stop the other stuck payments in
          // this batch from being checked.
          this.logger.error(
            `Reconciliation failed for payment ${payment.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          outcome = 'error';
        }
        // approved/declined/stillUnknown are the only outcomes the public
        // summary reports (unchanged shape); alreadySettled/error are
        // still counted in payment_reconciliation_total for visibility but
        // don't inflate a bucket that would misrepresent what actually
        // changed this run.
        if (outcome === 'approved' || outcome === 'declined' || outcome === 'stillUnknown') {
          summary[outcome]++;
        }
        this.metrics.paymentReconciliationTotal.inc({ outcome });
      }
      // Payments this run couldn't resolve — a live count of what's actually
      // stuck right now, not a running total (which paymentReconciliationTotal
      // already is), so this is a gauge rather than a counter.
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
        // Same treatment as the provider itself returning 'unknown': try
        // again next run rather than guessing an outcome for a call that
        // may still be in flight on the provider's side.
        this.logger.warn(`Reconciliation checkStatus timed out for payment ${payment.id}`);
        return 'stillUnknown';
      }
      throw err;
    }
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
      // Claim first, update the attempt record second: if another
      // reconciliation run (or the webhook handler) already moved this
      // payment out of PROCESSING, this updateMany matches zero rows and
      // the function returns before ever touching paymentAttempt — writing
      // DECLINED into the attempt history first would be wrong if the
      // payment's real final status (set by whichever run actually won)
      // turns out to be APPROVED.
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
    // if the order was cancelled while this payment was stuck, reverse the
    // charge instead of marking a cancelled order as paid. Unlike
    // PaymentsService.pay(), this run never atomically claimed the payment
    // before calling the provider (there's no earlier PENDING/FAILED ->
    // PROCESSING transition to piggyback on — it was already PROCESSING
    // when this batch found it), so the claim has to happen as the very
    // first write here, before the order is touched at all. Otherwise a
    // second reconciliation run racing on the same payment could flip the
    // order to PAID a second time (harmless, `status: PENDING` is already
    // gone) but then, on losing the payment claim below, misreport this
    // run's own outcome as a reversal it never actually performed.
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
