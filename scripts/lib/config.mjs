// Общие настройки скриптов базы. Все значения тестовые и открытые.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Подхватываем .env из корня, если он есть. Уже заданные переменные окружения не перетираются.
const envFile = path.join(rootDir, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export const pgPort = Number(process.env.PGPORT ?? 5433);
export const dataDir = path.join(rootDir, '.pgdata');
export const migrationsDir = path.join(rootDir, 'db', 'migrations');
export const seedFile = path.join(rootDir, 'db', 'seed.sql');

// Суперпользователь встроенного кластера: нужен только скрипту db:start.
export const superUser = { user: 'postgres', password: 'postgres' };

// Роль приложения и её базы.
export const appRole = { user: 'renewals', password: 'renewals' };
export const appDatabases = ['renewals', 'renewals_test'];

export const databaseUrl =
  process.env.DATABASE_URL ??
  `postgres://${appRole.user}:${appRole.password}@127.0.0.1:${pgPort}/renewals`; // allowlist secret: тестовая открытая роль локальной базы

// Адрес без пароля, для вывода в консоль.
export function maskUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<некорректный DATABASE_URL>';
  }
}
