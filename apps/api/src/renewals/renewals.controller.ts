import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { RenewalsService } from './renewals.service';

// Тело и query не читаются нигде: пользователь из сессии, пространство из сущности.
@Controller()
export class RenewalsController {
  constructor(private readonly renewals: RenewalsService) {}

  @Get('resources')
  listResources(@CurrentUser() user: AuthUser) {
    return this.renewals.listResources(user);
  }

  @Get('resources/:id')
  getResource(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.renewals.getResource(user, id);
  }

  @Post('resources/:id/renewal-requests')
  @HttpCode(201)
  createRequest(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.renewals.createRequest(user, id);
  }

  @Get('renewal-requests')
  listRequests(@CurrentUser() user: AuthUser) {
    return this.renewals.listRequests(user);
  }

  @Get('renewal-requests/:id')
  getRequest(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.renewals.getRequest(user, id);
  }
}
