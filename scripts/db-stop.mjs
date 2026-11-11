// npm run db:stop: штатно остановить встроенный PostgreSQL из другого терминала.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDir } from './lib/config.mjs';
import { pgBinaries } from './lib/pg-binaries.mjs';

try {
  const { pg_ctl } = await pgBinaries();
  await promisify(execFile)(pg_ctl, ['stop', '-D', dataDir, '-m', 'fast', '-w', '-t', '20']);
  console.log('[db:stop] база остановлена');
} catch (error) {
  console.error(`[db:stop] не удалось остановить базу: ${String(error.stderr || error.message).trim()}`);
  process.exitCode = 1;
}
