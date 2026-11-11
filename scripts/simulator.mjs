// npm run simulator: запускает tools/provider_simulator.py подходящим интерпретатором Python.
// Порядок выбора: переменная PYTHON; на Windows python, затем py; на остальных python3, затем python.
// Остановка: Ctrl+C. Код выхода имитатора становится кодом выхода этого скрипта.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
// Импорт подхватывает корневой .env (там может быть PYTHON), как у остальных скриптов.
import { rootDir } from './lib/config.mjs';

const script = path.join(rootDir, 'tools', 'provider_simulator.py');

function candidates() {
  if (process.env.PYTHON) return [process.env.PYTHON];
  return process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
}

// Интерпретатор годится, если `--version` завершается с кодом 0. Заглушка python из Microsoft Store
// на Windows отвечает ненулевым кодом, поэтому отсеивается.
function works(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore', windowsHide: true });
  return !result.error && result.status === 0;
}

const python = candidates().find(works);
if (!python) {
  console.error(
    `[simulator] не найден Python 3 (пробовал: ${candidates().join(', ')}). ` +
      'Установите Python 3 или укажите путь к нему в переменной PYTHON.',
  );
  process.exit(1);
}

const child = spawn(python, [script], { cwd: rootDir, stdio: 'inherit' });

// Ctrl+C в терминале получают и этот процесс, и имитатор (одна группа процессов). Здесь сигнал
// не завершает node: ждём, пока имитатор выйдет сам. Если сигнал пришёл только сюда
// (kill по PID), передаём его имитатору.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    }, 200).unref();
  });
}

child.on('error', (error) => {
  console.error(`[simulator] не удалось запустить ${python}: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    // Завершаемся тем же сигналом, чтобы вызывающий видел настоящую причину.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
