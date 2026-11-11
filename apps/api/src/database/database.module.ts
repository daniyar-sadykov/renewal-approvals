import { Global, Logger, Module } from '@nestjs/common';
import { Pool, types } from 'pg';
import { APP_CONFIG } from '../config.module';
import { AppConfig } from '../config';
import { PG_POOL } from './database.constants';
import { DatabaseService } from './database.service';

// Тип date отдаём строкой 'YYYY-MM-DD'. По умолчанию pg делает из него Date в местном
// часовом поясе, и календарная дата может съехать на день.
types.setTypeParser(types.builtins.DATE, (value) => value);

// Сколько ждать соединения из пула или новой сессии базы, мс.
export const DB_CONNECT_TIMEOUT_MS = 5000;
// Предел одного SQL-запроса на стороне PostgreSQL, мс. Обычные запросы идут миллисекунды.
export const DB_STATEMENT_TIMEOUT_MS = 10000;

// Глобальный модуль: PG_POOL и DatabaseService доступны во всех модулях без импорта.
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Pool => {
        // Таймауты: зависшая база не должна вешать запрос API, шаг обработчика и остановку процесса.
        // Оба заметно меньше аренды задачи по умолчанию (2 * PROVIDER_TIMEOUT_MS + 10000).
        const pool = new Pool({
          connectionString: config.databaseUrl,
          max: 10,
          connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
          statement_timeout: DB_STATEMENT_TIMEOUT_MS,
        });
        // Ошибка простаивающего соединения не должна ронять процесс.
        pool.on('error', (error) => new Logger('Database').error(`Ошибка соединения в пуле: ${error.message}`));
        return pool;
      },
    },
    DatabaseService,
  ],
  exports: [PG_POOL, DatabaseService],
})
export class DatabaseModule {}
