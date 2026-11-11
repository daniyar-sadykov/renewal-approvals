import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessService } from './access.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { LoginThrottle } from './login-throttle.service';
import { SessionService } from './session.service';

// Вход, сессии, глобальный AuthGuard, ограничение попыток входа и проверка прав по memberships.
@Module({
  controllers: [AuthController],
  providers: [SessionService, AccessService, LoginThrottle, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [SessionService, AccessService, LoginThrottle],
})
export class AuthModule {}
