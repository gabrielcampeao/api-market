import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
  });

  it('exposes every documented metric name in the scrape output', async () => {
    service.httpRequestsTotal.inc({ method: 'GET', route: '/api/products', status_code: '200' });
    service.paymentAttemptTotal.inc({ provider: 'fake' });
    service.paymentApprovedTotal.inc({ provider: 'fake' });
    service.paymentFailedTotal.inc({ provider: 'fake', reason: 'declined' });
    service.paymentReconciliationTotal.inc({ outcome: 'approved' });
    service.stuckPaymentsTotal.set(2);
    service.stripeRequestDurationSeconds.observe({ operation: 'charge' }, 0.2);
    service.stripeErrorsTotal.inc({ operation: 'charge' });
    service.webhookReceivedTotal.inc({ provider: 'stripe', type: 'payment_intent.succeeded' });
    service.webhookDuplicateTotal.inc({ provider: 'stripe' });
    service.webhookInvalidSignatureTotal.inc({ provider: 'stripe' });

    const output = await service.getMetrics();

    for (const name of [
      'http_requests_total',
      'http_request_duration_seconds',
      'payment_attempt_total',
      'payment_approved_total',
      'payment_failed_total',
      'payment_reconciliation_total',
      'stuck_payments_total',
      'stripe_request_duration_seconds',
      'stripe_errors_total',
      'webhook_received_total',
      'webhook_duplicate_total',
      'webhook_invalid_signature_total',
    ]) {
      expect(output).toContain(name);
    }
  });

  it("scopes metrics to its own registry instead of prom-client's shared default", async () => {
    const other = new MetricsService();
    other.paymentAttemptTotal.inc({ provider: 'fake' });

    const output = await service.getMetrics();

    expect(output).not.toContain('payment_attempt_total{provider="fake"} 1');
  });
});
