import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RenewalDecisionsService } from './renewal-decisions.service';
import { RenewalsController } from './renewals.controller';
import { RenewalsService } from './renewals.service';

@Module({
  imports: [AuthModule],
  controllers: [RenewalsController],
  providers: [RenewalsService, RenewalDecisionsService],
  exports: [RenewalsService, RenewalDecisionsService],
})
export class RenewalsModule {}
