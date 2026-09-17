import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
export function getHttpRequest<T = Record<string, unknown>>(context: ExecutionContext): T {
  if (context.getType<'graphql'>() === 'graphql') {
    return GqlExecutionContext.create(context).getContext().req as T;
  }
  return context.switchToHttp().getRequest<T>();
}
