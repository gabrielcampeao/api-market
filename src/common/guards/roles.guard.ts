import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/auth.types';
import { getHttpRequest } from '../utils/graphql-context.util';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = getHttpRequest<{ user?: AuthenticatedUser }>(context);
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Missing authenticated user');
    }

    const hasRole = requiredRoles.includes(user.role);
    if (!hasRole) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
