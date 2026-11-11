// Настройки приложения из переменных окружения. Значения по умолчанию рабочие без .env:
// роль и пароль базы тестовые и открытые.

export interface AppConfig {
  // Адрес, на котором слушает API. По умолчанию только локальный.
  host: string;
  port: number;
  databaseUrl: string;
  providerBaseUrl: string;
  providerRetryDelayMs: number;
  providerTimeoutMs: number;
  workerPollMs: number;
  providerMaxPostAttempts: number;
  // Фоновый обработчик задач провайдера в этом процессе. По умолчанию включён.
  workerEnabled: boolean;
  // Аренда задачи: столько другой обработчик не возьмёт задачу, пока этот её ведёт.
  workerLeaseMs: number;
  // Флаг Secure у cookie сессии. Включать, когда API отдаётся по https.
  cookieSecure: boolean;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Переменная ${name} должна быть целым неотрицательным числом`);
  }
  return value;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`Переменная ${name} должна быть true или false`);
}

export function defaultDatabaseUrl(env: NodeJS.ProcessEnv = process.env, database = 'renewals'): string {
  return `postgres://renewals:renewals@127.0.0.1:${intFromEnv(env, 'PGPORT', 5433)}/${database}`; // allowlist secret: тестовая открытая роль локальной базы
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const providerTimeoutMs = intFromEnv(env, 'PROVIDER_TIMEOUT_MS', 5000);
  // Шаг обработчика это до двух запросов к провайдеру (GET и POST) плюс короткие транзакции.
  // Аренда должна пережить такой шаг, иначе задачу возьмут второй раз, пока первый ещё работает.
  const minLeaseMs = providerTimeoutMs * 2 + 1000;
  const workerLeaseMs = intFromEnv(env, 'WORKER_LEASE_MS', providerTimeoutMs * 2 + 10000);
  if (workerLeaseMs < minLeaseMs) {
    throw new Error(`WORKER_LEASE_MS должна быть не меньше ${minLeaseMs} (2 * PROVIDER_TIMEOUT_MS + 1000)`);
  }
  const providerMaxPostAttempts = intFromEnv(env, 'PROVIDER_MAX_POST_ATTEMPTS', 3);
  if (providerMaxPostAttempts < 1) throw new Error('PROVIDER_MAX_POST_ATTEMPTS должна быть не меньше 1');
  const workerPollMs = intFromEnv(env, 'WORKER_POLL_MS', 1000);
  if (workerPollMs < 1) throw new Error('WORKER_POLL_MS должна быть не меньше 1');
  return {
    host: env.HOST || '127.0.0.1',
    port: intFromEnv(env, 'PORT', 3000),
    databaseUrl: env.DATABASE_URL || defaultDatabaseUrl(env),
    providerBaseUrl: env.PROVIDER_BASE_URL || 'http://127.0.0.1:8091',
    providerRetryDelayMs: intFromEnv(env, 'PROVIDER_RETRY_DELAY_MS', 15000),
    providerTimeoutMs,
    workerPollMs,
    providerMaxPostAttempts,
    workerEnabled: boolFromEnv(env, 'WORKER_ENABLED', true),
    workerLeaseMs,
    cookieSecure: env.COOKIE_SECURE === 'true',
  };
}
