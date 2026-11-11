import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PG_POOL } from './database.constants';

// Тонкая обёртка над пулом pg: запрос вне транзакции и транзакция с одним клиентом.
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private closed = false;

  constructor(@Inject(PG_POOL) readonly pool: Pool) {}

  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, params);
  }

  // Все запросы внутри work должны идти через переданный client, иначе они окажутся вне транзакции.
  async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // Пул закрывается последним: после остановки обработчика (onModuleDestroy) и HTTP-сервера.
  // Иначе шаг обработчика, который дорабатывает при остановке, остался бы без базы.
  async onApplicationShutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
