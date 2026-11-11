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

export function defaultDatabaseUrl(env: NodeJS.ProcessEnv = process.env, database = 'renewals'): string {
  return `postgres://renewals:renewals@127.0.0.1:${intFromEnv(env, 'PGPORT', 5433)}/${database}`; // allowlist secret: тестовая открытая роль локальной базы
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.HOST || '127.0.0.1',
    port: intFromEnv(env, 'PORT', 3000),
    databaseUrl: env.DATABASE_URL || defaultDatabaseUrl(env),
    providerBaseUrl: env.PROVIDER_BASE_URL || 'http://127.0.0.1:8091',
    providerRetryDelayMs: intFromEnv(env, 'PROVIDER_RETRY_DELAY_MS', 15000),
    providerTimeoutMs: intFromEnv(env, 'PROVIDER_TIMEOUT_MS', 5000),
    workerPollMs: intFromEnv(env, 'WORKER_POLL_MS', 1000),
    providerMaxPostAttempts: intFromEnv(env, 'PROVIDER_MAX_POST_ATTEMPTS', 3),
    cookieSecure: env.COOKIE_SECURE === 'true',
  };
}
