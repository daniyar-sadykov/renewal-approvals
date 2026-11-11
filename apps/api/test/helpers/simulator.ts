import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { repoRoot } from './db';

// Настоящий имитатор провайдера (tools/provider_simulator.py) для тестов.
// Порт фиксирован в самом имитаторе, поэтому тесты с ним нельзя гонять в двух местах сразу.
export const SIMULATOR_HOST = '127.0.0.1';
export const SIMULATOR_PORT = 8091;
export const SIMULATOR_URL = `http://${SIMULATOR_HOST}:${SIMULATOR_PORT}`;

const START_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 10000;

let child: ChildProcess | null = null;
let exitHookInstalled = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// true, если на порту кто-то слушает.
function portBusy(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: SIMULATOR_HOST, port: SIMULATOR_PORT });
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

// Убивает процесс вместе с потомками. На Windows только taskkill /T надёжно снимает дерево.
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // уже завершился
    }
  }
}

// Синхронная страховка: если тест упал и afterAll не дошёл до stopSimulator, процесс не остаётся сиротой.
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    if (child?.pid && child.exitCode === null) killTree(child.pid);
  });
}

async function getJson(pathAndQuery: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${SIMULATOR_URL}${pathAndQuery}`, { signal: AbortSignal.timeout(3000) });
  return { status: response.status, body: await response.json() };
}

// Тот же выбор интерпретатора, что в scripts/simulator.mjs: PYTHON; на Windows python, затем py;
// на остальных python3, затем python. Годится тот, у кого `--version` завершается с кодом 0.
function findPython(): string {
  const candidates = process.env.PYTHON
    ? [process.env.PYTHON]
    : process.platform === 'win32'
      ? ['python', 'py']
      : ['python3', 'python'];
  const found = candidates.find((command) => {
    const result = spawnSync(command, ['--version'], { stdio: 'ignore', windowsHide: true });
    return !result.error && result.status === 0;
  });
  if (!found) {
    throw new Error(`Не найден Python 3 для имитатора (пробовал: ${candidates.join(', ')}). Укажите его в переменной PYTHON.`);
  }
  return found;
}

// Запускает свежий имитатор (данные в памяти пустые) и ждёт ответа GET /health.
export async function startSimulator(): Promise<void> {
  if (child) throw new Error('Имитатор уже запущен этим тестом');
  if (await portBusy()) {
    throw new Error(
      `Порт ${SIMULATOR_PORT} уже занят другим процессом (старый имитатор или чужой сервер). ` +
        'Остановите его: тестам нужен свежий имитатор с пустой статистикой.',
    );
  }

  const python = findPython();
  const script = path.join(repoRoot, 'tools', 'provider_simulator.py');
  const proc = spawn(python, [script], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  child = proc;
  installExitHook();

  let stderr = '';
  let spawnError: Error | null = null;
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  proc.once('error', (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError || proc.exitCode !== null) {
      child = null;
      throw new Error(
        `Имитатор не запустился (${python} ${script}): ${spawnError ? (spawnError as Error).message : `код ${proc.exitCode}`}\n${stderr}`,
      );
    }
    try {
      const health = await getJson('/health');
      if (health.status === 200) return;
    } catch {
      // ещё не слушает
    }
    await sleep(100);
  }
  await stopSimulator();
  throw new Error(`Имитатор не ответил на /health за ${START_TIMEOUT_MS} мс\n${stderr}`);
}

// Останавливает имитатор и ждёт, пока освободится порт. Безопасно вызывать повторно.
export async function stopSimulator(): Promise<void> {
  const proc = child;
  child = null;
  if (!proc?.pid) return;
  if (proc.exitCode === null) {
    // Таймер ожидания снимается сразу после выхода, иначе он держит jest открытым.
    let timer: NodeJS.Timeout | undefined;
    const exited = new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      timer = setTimeout(resolve, STOP_TIMEOUT_MS);
    });
    killTree(proc.pid);
    await exited;
    clearTimeout(timer);
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await portBusy())) return;
    await sleep(100);
  }
  throw new Error(`Имитатор остановлен, но порт ${SIMULATOR_PORT} всё ещё занят`);
}

// GET /stats?resource_id=...: число операций по ресурсу.
export async function simulatorStats(resourceId: string): Promise<{ resource_id: string; operation_count: number }> {
  const { status, body } = await getJson(`/stats?resource_id=${encodeURIComponent(resourceId)}`);
  if (status !== 200) throw new Error(`GET /stats вернул ${status}: ${JSON.stringify(body)}`);
  return body as { resource_id: string; operation_count: number };
}

export interface SimulatorOperation {
  operation_id: string;
  status: string;
  started_count: number;
  resource_id: string;
  period_months: number;
  amount_minor: number;
  currency: string;
}

// GET /renewals/{key}: операция по ключу или null, если имитатор её не знает (404).
export async function simulatorOperation(key: string): Promise<SimulatorOperation | null> {
  const { status, body } = await getJson(`/renewals/${encodeURIComponent(key)}`);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`GET /renewals/{key} вернул ${status}: ${JSON.stringify(body)}`);
  return body as SimulatorOperation;
}
