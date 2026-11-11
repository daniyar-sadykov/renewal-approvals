import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, types } from 'pg';
import { defaultDatabaseUrl } from '../../src/config';

export const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

// Как и в приложении: date приходит строкой 'YYYY-MM-DD'.
types.setTypeParser(types.builtins.DATE, (value) => value);

const envFile = path.join(repoRoot, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// База тестов. Отдельная от базы приложения: тесты пересоздают в ней схему.
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL || defaultDatabaseUrl(process.env, 'renewals_test');
  const database = new URL(url).pathname.replace(/^\//, '');
  if (!database.includes('test')) {
    throw new Error(`TEST_DATABASE_URL указывает на базу "${database}". Тесты стирают данные, имя базы должно содержать "test".`);
  }
  return url;
}

// Направляет приложение, поднятое внутри теста, на тестовую базу. Вызывать до создания модуля Nest.
export function useTestDatabase(): string {
  const url = testDatabaseUrl();
  process.env.DATABASE_URL = url;
  return url;
}

export async function connectTestDb(): Promise<Client> {
  const client = new Client({ connectionString: testDatabaseUrl() });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Тестовая база недоступна: ${(error as Error).message}. ` +
        'Поднимите её в отдельном терминале: npm run db:start',
    );
  }
  return client;
}

// Запускает скрипт базы из корня (db-reset, db-migrate, db-seed) против тестовой базы.
export function runDbScript(name: 'db-reset' | 'db-migrate' | 'db-seed'): string {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', `${name}.mjs`)], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${name} завершился с кодом ${result.status}:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

// Чистая схема, миграции, начальные данные. Вызывать в beforeAll тестов, которым нужна база.
export function resetTestDatabase(): string {
  return runDbScript('db-reset');
}
