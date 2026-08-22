import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/interfaces/auth.types';
import { getHttpRequest } from '../utils/graphql-context.util';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = getHttpRequest<{ user: AuthenticatedUser }>(ctx);
    return request.user;
  },
);
