// npm run db:start: встроенный PostgreSQL в переднем плане, данные в .pgdata/.
// Первый запуск создаёт кластер, роль приложения и базы renewals, renewals_test.
// Остановка: Ctrl+C в этом терминале или `npm run db:stop` из другого.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { appDatabases, appRole, dataDir, pgPort, superUser } from './lib/config.mjs';
import { pgBinaries } from './lib/pg-binaries.mjs';

const log = (message) => console.log(`[db:start] ${message}`);

// Штатная остановка через pg_ctl. Родной stop() на Windows убивает процесс через taskkill /f,
// после чего следующий запуск идёт через восстановление журнала.
class LocalPostgres extends EmbeddedPostgres {
  async stop() {
    const child = this.process;
    this.process = undefined;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      const { pg_ctl } = await pgBinaries();
      await promisify(execFile)(pg_ctl, ['stop', '-D', dataDir, '-m', 'fast', '-w', '-t', '10']);
    } catch {
      // Сервер уже останавливается сам (Ctrl+C в Windows приходит и ему) либо pg_ctl не справился.
      if (child.exitCode === null) {
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
        if (child.exitCode === null) child.kill();
      }
    }
    await exited;
  }
}

async function isAlreadyRunning() {
  const client = new pg.Client({ host: '127.0.0.1', port: pgPort, database: 'postgres', ...superUser });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

// Роль и базы создаются, только если их ещё нет: повторный запуск ничего не меняет.
async function ensureRoleAndDatabases() {
  const client = new pg.Client({ host: '127.0.0.1', port: pgPort, database: 'postgres', ...superUser });
  await client.connect();
  try {
    const role = await client.query('select 1 from pg_roles where rolname = $1', [appRole.user]);
    if (role.rowCount === 0) {
      await client.query(
        `create role ${client.escapeIdentifier(appRole.user)} login password ${client.escapeLiteral(appRole.password)}`,
      );
      log(`создана роль ${appRole.user}`);
    }
    for (const name of appDatabases) {
      const db = await client.query('select 1 from pg_database where datname = $1', [name]);
      if (db.rowCount === 0) {
        await client.query(
          `create database ${client.escapeIdentifier(name)} owner ${client.escapeIdentifier(appRole.user)}`,
        );
        log(`создана база ${name}`);
      }
    }
  } finally {
    await client.end();
  }
}

async function main() {
  if (await isAlreadyRunning()) {
    console.error(`[db:start] на порту ${pgPort} база уже отвечает. Второй экземпляр не нужен.`);
    process.exitCode = 1;
    return;
  }

  const postgres = new LocalPostgres({
    databaseDir: dataDir,
    port: pgPort,
    user: superUser.user,
    password: superUser.password,
    authMethod: 'scram-sha-256',
    persistent: true,
    // Кодировка и локаль заданы явно, чтобы не зависеть от языка Windows.
    initdbFlags: ['--encoding=UTF8', '--locale=C', '--locale-provider=builtin', '--builtin-locale=C.UTF-8'],
    onLog: (message) => process.stdout.write(message),
    onError: (error) => console.error(error),
  });

  try {
    if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
      log(`первый запуск, создаю кластер в ${dataDir}`);
      await postgres.initialise();
    }
    await postgres.start();
    await ensureRoleAndDatabases();
  } catch (error) {
    console.error(
      `[db:start] база не поднялась${error?.message ? `: ${error.message}` : ''}. ` +
        `Проверьте, не занят ли порт ${pgPort} (переменная PGPORT) и вывод PostgreSQL выше.`,
    );
    await postgres.stop().catch(() => {});
    process.exitCode = 1;
    return;
  }

  log(`готово: 127.0.0.1:${pgPort}, базы ${appDatabases.join(', ')}, роль ${appRole.user}`);
  log('остановка: Ctrl+C здесь или `npm run db:stop` в другом терминале');

  // Сервер остановили снаружи (db:stop) или он упал: процессу больше нечего ждать, он завершится сам.
  postgres.process?.once('exit', (code) => {
    if (postgres.process) {
      postgres.process = undefined;
      log(`PostgreSQL завершился (код ${code ?? 'нет'}), выхожу`);
      process.exitCode = code === 0 ? 0 : 1;
    }
  });
  // Ctrl+C и SIGTERM обрабатывает сам embedded-postgres: вызывает stop() всех экземпляров, то есть код выше.
  // process.exit здесь не зовём: он обрывает асинхронную остановку.
}

await main();
