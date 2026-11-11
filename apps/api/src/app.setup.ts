import { INestApplication } from '@nestjs/common';
import { ApiExceptionFilter } from './common/api-exception.filter';

// Общая настройка приложения. Вызывается и в main.ts, и в тестах, чтобы они не расходились.
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  // Единый формат ошибок: { error, message }.
  app.useGlobalFilters(new ApiExceptionFilter());
  // Закрывает пул базы при остановке процесса (SIGINT, SIGTERM).
  app.enableShutdownHooks();
}
