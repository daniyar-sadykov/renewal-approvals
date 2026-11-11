import { Global, Module } from '@nestjs/common';
import { loadConfig } from './config';

// Токен для внедрения настроек: @Inject(APP_CONFIG) config: AppConfig
export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
