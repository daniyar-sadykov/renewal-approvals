// Подключение, миграции, начальные данные и сброс схемы. Используется командами db:*.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { databaseUrl, maskUrl, migrationsDir, seedFile } from './config.mjs';

const MIGRATIONS_LOCK_KEY = 20261111;

export async function connect(url = databaseUrl) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Не удалось подключиться к базе ${maskUrl(url)}: ${error.message}. ` +
        'База поднята? Запустите `npm run db:start` в отдельном терминале.',
      { cause: error },
    );
  }
  return client;
}

async function inTransaction(client, work) {
  await client.query('begin');
  try {
    const result = await work();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

// Применяет ещё не применённые миграции, каждую в своей транзакции. Возвращает список применённых.
export async function migrate(client) {
  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )`);
  // Блокировка на сессию: два одновременных прогона не применят один файл дважды.
  await client.query('select pg_advisory_lock($1)', [MIGRATIONS_LOCK_KEY]);
  try {
    const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    const { rows } = await client.query('select version from schema_migrations');
    const applied = new Set(rows.map((row) => row.version));
    const done = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      try {
        await inTransaction(client, async () => {
          await client.query(sql);
          await client.query('insert into schema_migrations (version) values ($1)', [version]);
        });
      } catch (error) {
        throw new Error(`Миграция ${file} не применилась: ${error.message}`, { cause: error });
      }
      done.push(version);
    }
    return done;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATIONS_LOCK_KEY]);
  }
}

// Начальные данные. Файл идемпотентный: повторный запуск возвращает строки к исходным значениям.
export async function seed(client) {
  const sql = await readFile(seedFile, 'utf8');
  await inTransaction(client, () => client.query(sql));
}

// Полный сброс: схема public удаляется со всем содержимым и создаётся заново.
export async function dropSchema(client) {
  await client.query('drop schema if exists public cascade');
  await client.query('create schema public');
}
