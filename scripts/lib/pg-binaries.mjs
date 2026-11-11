// Пути к бинарникам PostgreSQL из платформенного пакета embedded-postgres.
import os from 'node:os';

const platformNames = { win32: 'windows', darwin: 'darwin', linux: 'linux' };

export async function pgBinaries() {
  const platform = platformNames[os.platform()];
  if (!platform) {
    throw new Error(`Платформа ${os.platform()} не поддерживается embedded-postgres`);
  }
  // Экспортирует пути: postgres, initdb, pg_ctl.
  return import(`@embedded-postgres/${platform}-${os.arch()}`);
}
