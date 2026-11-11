import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [HealthController],
})
export class AppModule {}
