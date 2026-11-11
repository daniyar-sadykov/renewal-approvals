import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { APP_CONFIG } from './config.module';
import { AppConfig } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port, config.host);
  new Logger('Bootstrap').log(`API слушает http://${config.host}:${config.port}/api`);
}

bootstrap().catch((error) => {
  new Logger('Bootstrap').error(`API не запустился: ${(error as Error).message}`);
  process.exit(1);
});
