import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const role = request.headers['x-user-role'];

    if (!role) {
      throw new UnauthorizedException('X-User-Role header is required');
    }

    if (!requiredRoles.includes(role)) {
      throw new ForbiddenException(`Role '${role}' is not permitted to perform this action`);
    }

    return true;
  }
}
