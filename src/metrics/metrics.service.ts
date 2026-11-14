import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests handled',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [this.registry],
  });
  readonly httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    registers: [this.registry],
  });
  readonly paymentAttemptTotal = new Counter({
    name: 'payment_attempt_total',
    help: 'Total payment attempts made to a provider',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });
  readonly paymentApprovedTotal = new Counter({
    name: 'payment_approved_total',
    help: 'Total payments approved',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });
  readonly paymentFailedTotal = new Counter({
    name: 'payment_failed_total',
    help: 'Total payments that failed or were declined',
    labelNames: ['provider', 'reason'] as const,
    registers: [this.registry],
  });
  readonly paymentReconciliationTotal = new Counter({
    name: 'payment_reconciliation_total',
    help: 'Total payments processed by the reconciliation job, by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  readonly stuckPaymentsTotal = new Gauge({
    name: 'stuck_payments_total',
    help: 'Number of payments left PROCESSING after the last reconciliation run',
    registers: [this.registry],
  });
  readonly stripeRequestDurationSeconds = new Histogram({
    name: 'stripe_request_duration_seconds',
    help: 'Duration of outbound Stripe API calls in seconds',
    labelNames: ['operation'] as const,
    buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });
  readonly stripeErrorsTotal = new Counter({
    name: 'stripe_errors_total',
    help: 'Total errors from outbound Stripe API calls',
    labelNames: ['operation'] as const,
    registers: [this.registry],
  });
  readonly webhookReceivedTotal = new Counter({
    name: 'webhook_received_total',
    help: 'Total webhook events received',
    labelNames: ['provider', 'type'] as const,
    registers: [this.registry],
  });
  readonly webhookDuplicateTotal = new Counter({
    name: 'webhook_duplicate_total',
    help: 'Total webhook deliveries recognized as duplicates of an already-processed event',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });
  readonly webhookInvalidSignatureTotal = new Counter({
    name: 'webhook_invalid_signature_total',
    help: 'Total webhook requests rejected for a missing or invalid signature',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });
  readonly dependencyUp = new Gauge({
    name: 'dependency_up',
    help: '1 if the last check of this dependency succeeded, 0 otherwise',
    labelNames: ['dependency'] as const,
    registers: [this.registry],
  });
  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
