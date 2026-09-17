import { Injectable, Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
export const REQUEST_ID_HEADER = 'x-request-id';
@Injectable()
export class RequestLoggerMiddleware {
  private readonly logger = new Logger('HTTP');
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const { method, originalUrl } = req;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'log';
      const userId = (
        req as Request & {
          user?: {
            id?: string;
          };
        }
      ).user?.id;
      const userPart = userId ? ` user=${userId}` : '';
      this.logger[level](
        `${requestId} ${method} ${originalUrl} ${res.statusCode} ${durationMs}ms${userPart}`,
      );
    });
    next();
  }
}
