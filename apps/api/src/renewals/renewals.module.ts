import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RenewalsController } from './renewals.controller';
import { RenewalsService } from './renewals.service';

@Module({
  imports: [AuthModule],
  controllers: [RenewalsController],
  providers: [RenewalsService],
  exports: [RenewalsService],
})
export class RenewalsModule {}
