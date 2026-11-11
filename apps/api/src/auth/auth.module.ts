import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessService } from './access.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { SessionService } from './session.service';

// Вход, сессии, глобальный AuthGuard и проверка прав по memberships.
@Module({
  controllers: [AuthController],
  providers: [SessionService, AccessService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [SessionService, AccessService],
})
export class AuthModule {}
