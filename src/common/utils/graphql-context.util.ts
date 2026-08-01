import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

// Guards and param decorators registered globally (APP_GUARD) run for both
// REST controllers and GraphQL resolvers. `context.switchToHttp()` only
// works for the REST case — for a GraphQL resolver the underlying Express
// request has to be pulled out through GqlExecutionContext instead.
export function getHttpRequest<T = Record<string, unknown>>(
  context: ExecutionContext,
): T {
  if (context.getType<'graphql'>() === 'graphql') {
    return GqlExecutionContext.create(context).getContext().req as T;
  }
  return context.switchToHttp().getRequest<T>();
}
