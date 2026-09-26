import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { MetricsService } from './metrics.service';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // GraphQL requests all share one HTTP route (POST /graphql) — the
    // interesting label there would be the operation name, not the HTTP
    // route, which is a different metric than this one. Only instrument
    // plain HTTP handlers.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const start = process.hrtime.bigint();

    // req.route.path is the matched pattern (e.g. "/api/orders/:id/pay"),
    // not the real URL — using the real URL would give every distinct
    // order ID its own time series, which is an unbounded label cardinality
    // problem for Prometheus.
    const route = req.route?.path ?? req.path;
    const method = req.method;

    const record = (statusCode: number) => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = { method, route, status_code: String(statusCode) };
      this.metrics.httpRequestsTotal.inc(labels);
      this.metrics.httpRequestDurationSeconds.observe(labels, durationSeconds);
    };

    return next.handle().pipe(
      tap(() => record(res.statusCode)),
      catchError((err: unknown) => {
        // The exception filter hasn't run yet at this point in the pipeline,
        // so res.statusCode is still whatever it was before the handler
        // threw (usually 200) — read the real status off the exception
        // itself instead. Anything that isn't a recognized HttpException is
        // an unhandled 5xx, same classification AllExceptionsFilter uses.
        record(err instanceof HttpException ? err.getStatus() : 500);
        return throwError(() => err);
      }),
    );
  }
}
