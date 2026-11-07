# Runbook and SLOs

One page: what "healthy" means, and what to do when a specific alert fires. Pairs with the Grafana alert rules in `observability/grafana/provisioning/alerting/rules.yml` and the metrics documented in the [README's Observability section](../README.md#observability).

## SLOs

Targets, not guarantees. This runs on a single self-hosted instance with no HA. Numbers are grounded in the measured baseline in [`docs/load-testing.md`](load-testing.md) (20 concurrent workers, single instance, `FakePaymentProvider`), not aspirational round numbers.

| SLI | Target | Measured baseline |
|---|---|---|
| Availability (`up{job="marketplace-api"}`) | 99.9% | no long-window uptime data yet (single self-hosted box) |
| Read path p95 (`GET /products`) | < 100ms | 24ms |
| Write path p95 (`checkout`, `pay`) | < 300ms | 117ms / 172ms |
| 5xx error rate | < 5% over 5min | 0% at load-test concurrency |
| Payment failure rate | < 1 failure / 2s sustained over 5min | 0% at load-test concurrency |

A breach doesn't page anyone by itself beyond the Grafana alert already firing (see Alerting below); there's no separate SLO-burn-rate alert. Treat an SLO breach as "this alert firing for longer than it should," not a distinct signal.

## Alerting

Seven rules are provisioned in Grafana, routed to a Mailtrap SMTP contact point (`observability/grafana/provisioning/alerting/`). The fire-to-resolve cycle was verified end to end on 2026-08-22 for `postgres-down`, `redis-down`, and `readiness-down`.

## Runbooks

### Postgres down (`postgres-down`, critical)

**Detect**: alert fires on `dependency_up{dependency="postgres"} < 1` for 1min, or `GET /api/health/ready` returns `"postgres":"error"`.

**Investigate**:
```
docker compose -f docker-compose.prod.yml ps postgres
docker compose -f docker-compose.prod.yml logs postgres --tail 100
```
Common causes: container OOM-killed, disk full (`df -h` on the host, check the `postgres_data` volume), or the container was manually stopped or recreated with the wrong `POSTGRES_PASSWORD` (see the env-file guardrail below).

**Recover**:
```
docker compose --env-file ~/marketplace-prod.env -f docker-compose.prod.yml up -d postgres
```
If it won't start (data corruption, disk issue), treat this as a restore-from-backup situation. See [`scripts/backup-restore-drill.sh`](../scripts/backup-restore-drill.sh) for the tested procedure (adjust it to restore into the real volume instead of a throwaway one).

**Guardrail**: never run `docker compose up` against `docker-compose.prod.yml` on this host without `--env-file ~/marketplace-prod.env`. The repo's own `.env` has a blank dev password that doesn't match the real volume's password, and will crash-loop the API with `P1000: Authentication failed` instead of fixing anything.

### Redis down (`redis-down`, warning)

**Detect**: alert fires on `dependency_up{dependency="redis"} < 1` for 1min.

**Impact**: rate limiting fails open (`RedisThrottlerStorage`), so every request is allowed through unthrottled while Redis is down. This is a deliberate trade-off (availability over rate-limit enforcement), not a bug, but it means the API has zero abuse protection until Redis is back.

**Investigate/recover**:
```
docker compose -f docker-compose.prod.yml logs redis --tail 100
docker compose --env-file ~/marketplace-prod.env -f docker-compose.prod.yml up -d redis
```
No data-loss risk to worry about urgently. Redis here only backs rate-limit counters, not anything durable (sessions and JWTs are stateless, and cart, orders, and payments live in Postgres).

### Stripe degraded (`high-stripe-latency`, warning)

**Detect**: alert fires when p95 of `stripe_request_duration_seconds` exceeds 3s for 5min. Also watch `stripe_errors_total` climbing.

**Investigate**: check [Stripe status](https://status.stripe.com) first. This is almost always upstream, not local. Cross-check `payment_failed_total` and whether `high-payment-failure-rate` is firing alongside it; Stripe being slow often shows up as both.

**Recover**: there's nothing to do locally except wait, since there's no circuit breaker or fallback provider. Once Stripe recovers, any payment that got stuck `PROCESSING` during the degradation window self-heals via reconciliation within 5 minutes (`payment-reconciliation.service.ts`, cron `EVERY_5_MINUTES`), or you can trigger it immediately with `POST /api/payments/reconcile` (admin auth required).

### Payments stuck in PROCESSING (`payments-stuck-processing`, warning)

**Detect**: alert fires when `stuck_payments_total` (gauge, live count) stays above 0 for 10min, meaning at least one payment has survived two reconciliation passes without resolving.

**Investigate**:
```sql
SELECT id, order_id, provider, status, processing_at, provider_idempotency_key
FROM payments WHERE status = 'PROCESSING' AND processing_at < now() - interval '10 minutes';
```
If `checkStatus` keeps returning `unknown` for the same payment across multiple reconciliation runs, either the provider genuinely doesn't know the outcome yet (rare, but possible on Stripe's side), or `checkStatus` itself is erroring. Check `stripe_errors_total` and the reconciliation run's own logs (`docker compose logs api | grep -i reconcil`).

**Recover**: this usually self-heals once the provider resolves. If it's been stuck for hours, resolve manually via the Stripe dashboard (look up the PaymentIntent by `provider_idempotency_key`) and update the row directly. There's no admin endpoint for a manual override today.

### Elevated 5xx rate (`high-5xx-rate`, critical)

**Detect**: alert fires when 5xx responses exceed 5% of total requests over 5min.

**Investigate**:
```
docker compose -f docker-compose.prod.yml logs api --tail 200 | grep -i error
```
Check the Grafana dashboard's per-route breakdown (labeled by matched route pattern, not raw URL) to find which endpoint is failing. Cross-check `postgres-down` and `redis-down` first; a dependency outage is the most common root cause of a 5xx spike, not application code.

**Recover**: depends on the cause. If it's a bad deploy, roll back:
```
docker compose -f docker-compose.prod.yml up -d --no-build api  # if a rollback-tagged image exists from the CI deploy job's snapshot step
```
See the [Deployment section](../README.md#deployment). The CI deploy job already snapshots the previous image as a rollback tag and auto-rolls-back if the new one never reaches `/api/health/ready` within 5 minutes, so a bad deploy usually self-heals before a human needs to.

### Webhook failures

There's no dedicated alert rule for this today (a gap worth closing, likely on `webhook_invalid_signature_total` or `webhook_received_total` dropping to zero unexpectedly). Watch:
- `webhook_invalid_signature_total` climbing: usually a `STRIPE_WEBHOOK_SECRET` mismatch between this deployment and the Stripe webhook endpoint config. Verify they match.
- `webhook_duplicate_total` climbing fast: expected under Stripe's own retry behavior, not itself a problem. That's the dedup working.
- A payment stuck `PROCESSING` despite Stripe showing it succeeded: check `webhook_events` for the event. If it's missing entirely, either the webhook was never delivered (check Stripe's dashboard for delivery attempts and failures) or it was delivered before the app started listening. Reconciliation is the safety net either way.
