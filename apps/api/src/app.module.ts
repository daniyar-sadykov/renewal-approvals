import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { RenewalsModule } from './renewals/renewals.module';

@Module({
  imports: [ConfigModule, DatabaseModule, AuthModule, RenewalsModule],
  controllers: [HealthController],
})
export class AppModule {}
