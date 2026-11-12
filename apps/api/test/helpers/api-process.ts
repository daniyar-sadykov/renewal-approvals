import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

// Собранный API (dist/main.js) отдельным процессом node. Нужен, чтобы проверить восстановление
// после настоящей гибели процесса, а не после app.close() внутри Jest.

const API_DIR = path.resolve(__dirname, '..', '..');
const MAIN_JS = path.join(API_DIR, 'dist', 'main.js');
const HOST = '127.0.0.1';
const START_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 10000;
const OUTPUT_LIMIT = 8000;

export interface ApiExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

let child: ChildProcess | null = null;
let exited: Promise<ApiExit> | null = null;
let port = 0;
let output = '';
const spawned = new Set<ChildProcess>();
let exitHookInstalled = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Адрес текущего процесса API, например http://127.0.0.1:53211.
export function apiUrl(): string {
  if (!port) throw new Error('Процесс API не запускался');
  return `http://${HOST}:${port}`;
}

export function apiPid(): number | undefined {
  return child?.pid;
}

// Последние строки вывода процессов API (stdout и stderr вместе). Строки подключения к базе маскируются.
export function apiOutputTail(lines = 40): string {
  return output
    .replace(/postgres(ql)?:\/\/[^\s'"]+/g, 'postgres://***')
    .split(/\r?\n/)
    .slice(-lines)
    .join('\n');
}

// Ошибку ожидания дополняет хвостом вывода процесса API: иначе причина сбоя внутри процесса не видна.
export async function withApiOutput<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    const e = error as Error;
    e.message = `${e.message}\n--- вывод процесса API (хвост) ---\n${apiOutputTail()}`;
    throw e;
  }
}

// Свободный порт: временный сервер на порту 0, порт берётся у системы.
export async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  const { port: found } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return found;
}

// Синхронная сборка API в dist. Падает с выводом tsc.
export function buildApi(): void {
  const tsc = require.resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: API_DIR,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Сборка API (tsc -p tsconfig.build.json) не удалась: ${result.error?.message ?? `код ${result.status}`}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

export function portListening(target: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port: target });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

// Страховка на случай падения теста до afterAll: процессы API не остаются сиротами.
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const proc of spawned) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }
  });
}

// Запускает dist/main.js напрямую через node (без оболочки, поэтому pid это сам API) и ждёт /api/health 200.
// PORT берётся из env; если не задан, выбирается свободный.
export async function startApiProcess(env: Record<string, string>): Promise<string> {
  if (child) throw new Error('Процесс API уже запущен');
  port = env.PORT ? Number(env.PORT) : await freePort();
  if (await portListening(port)) throw new Error(`Порт ${port} уже занят`);

  const proc = spawn(process.execPath, [MAIN_JS], {
    cwd: API_DIR,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  child = proc;
  spawned.add(proc);
  installExitHook();
  const append = (chunk: string) => {
    output = (output + chunk).slice(-OUTPUT_LIMIT);
  };
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', append);
  proc.stderr?.on('data', append);
  let spawnError: Error | null = null;
  proc.once('error', (error) => {
    spawnError = error;
  });
  exited = new Promise<ApiExit>((resolve) => {
    proc.once('exit', (code, signal) => {
      append(`\n[процесс API ${proc.pid} завершился: code=${code} signal=${signal}]\n`);
      resolve({ code, signal });
    });
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError || proc.exitCode !== null || proc.signalCode !== null) {
      child = null;
      throw new Error(
        `Процесс API не запустился: ${spawnError ? (spawnError as Error).message : `код ${proc.exitCode}`}\n${apiOutputTail()}`,
      );
    }
    try {
      const response = await fetch(`${apiUrl()}/api/health`, { signal: AbortSignal.timeout(2000) });
      await response.text();
      if (response.status === 200) return apiUrl();
    } catch {
      // ещё не слушает
    }
    await sleep(100);
  }
  await killApiProcess().catch(() => undefined);
  throw new Error(`Процесс API не ответил на /api/health за ${START_TIMEOUT_MS} мс\n${apiOutputTail()}`);
}

// Жёсткое убийство без штатного завершения: SIGKILL (на Windows TerminateProcess).
// Хуки Nest и обработчики сигналов в процессе не выполняются. Ждёт выхода и освобождения порта.
export async function killApiProcess(): Promise<ApiExit | null> {
  const proc = child;
  const done = exited;
  child = null;
  exited = null;
  if (!proc || !done) return null;
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    done,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), STOP_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (!result) throw new Error(`Процесс API ${proc.pid} не завершился за ${STOP_TIMEOUT_MS} мс после SIGKILL`);
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  spawned.delete(proc);

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (await portListening(port)) {
    if (Date.now() > deadline) throw new Error(`Процесс API убит, но порт ${port} всё ещё слушает`);
    await sleep(100);
  }
  return result;
}
