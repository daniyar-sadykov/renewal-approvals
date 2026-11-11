import { Global, Logger, Module } from '@nestjs/common';
import { Pool, types } from 'pg';
import { APP_CONFIG } from '../config.module';
import { AppConfig } from '../config';
import { PG_POOL } from './database.constants';
import { DatabaseService } from './database.service';

// Тип date отдаём строкой 'YYYY-MM-DD'. По умолчанию pg делает из него Date в местном
// часовом поясе, и календарная дата может съехать на день.
types.setTypeParser(types.builtins.DATE, (value) => value);

// Глобальный модуль: PG_POOL и DatabaseService доступны во всех модулях без импорта.
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Pool => {
        const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
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
