import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { unauthorized } from '../common/api-error';
import { AuthedRequest, AuthUser } from './auth.types';

export const IS_PUBLIC = 'isPublic';

// Маршрут без входа (login, health). Всё остальное закрыто глобальным AuthGuard.
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

// Текущий пользователь из сессии: @CurrentUser() user: AuthUser
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser => {
  const user = context.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw unauthorized();
  return user;
});
