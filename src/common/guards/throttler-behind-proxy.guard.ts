import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as {
      ip?: string;
      ips?: string[];
    };
    const forwarded = request.ips?.[0] ?? request.ip ?? 'unknown';
    return forwarded;
  }
  protected override getRequestResponse(context: ExecutionContext) {
    if (context.getType<'graphql'>() === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context).getContext<{
        req: unknown;
        res: unknown;
      }>();
      return { req: gqlCtx.req, res: gqlCtx.res };
    }
    const http = context.switchToHttp();
    return {
      req: http.getRequest(),
      res: http.getResponse(),
    };
  }
}
