import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { unauthorized } from '../common/api-error';
import { IS_PUBLIC } from './auth.decorators';
import { AuthedRequest } from './auth.types';
import { readCookie, SESSION_COOKIE } from './cookies';
import { SessionService } from './session.service';

// Глобальный guard: без действующей сессии 401 на всём, кроме маршрутов с @Public().
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const session = await this.sessions.findUser(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw unauthorized();
    request.user = session.user;
    request.sessionTokenHash = session.tokenHash;
    return true;
  }
}
