import { INestApplication } from '@nestjs/common';

// Общая настройка приложения. Вызывается и в main.ts, и в тестах, чтобы они не расходились.
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  // Закрывает пул базы при остановке процесса (SIGINT, SIGTERM).
  app.enableShutdownHooks();
}
