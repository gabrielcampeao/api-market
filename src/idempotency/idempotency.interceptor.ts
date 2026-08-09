import {
  CallHandler,
  ExecutionContext,
  ConflictException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, lastValueFrom, map } from 'rxjs';
import { Request, Response } from 'express';
import { IdempotencyService } from './idempotency.service';
import { IDEMPOTENT_KEY } from './idempotent.decorator';
import { hashRequestBody } from './request-hash.util';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!isIdempotent) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const userId = (req as unknown as { user?: { id?: string } }).user?.id;
    if (!userId) {
      throw new ConflictException('Idempotent routes require authentication.');
    }
    // Use the resolved path (with real resource ids), not the route
    // *template* (e.g. "/orders/:id/pay") — otherwise the same key reused
    // across two different orders would collide on the same route string.
    const route = `${req.method} ${req.originalUrl}`;
    const requestHash = hashRequestBody(req.body);

    // The handler (and its side effects) must only run if this is genuinely
    // the first request for this key — gate it behind the idempotency lock
    // instead of running it and deduping the response afterwards.
    return from(
      this.idempotency.execute(
        idempotencyKey ?? null,
        userId,
        route,
        requestHash,
        async () => {
          const data = await lastValueFrom(next.handle());
          return { statusCode: res.statusCode || 200, body: data };
        },
      ),
    ).pipe(
      map((result) => {
        if (result.statusCode) {
          res.status(result.statusCode);
        }
        return result.body;
      }),
    );
  }
}
