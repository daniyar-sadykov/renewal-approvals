// npm run db:reset: пересоздать схему, применить миграции и начальные данные.
// Целевая база берётся из DATABASE_URL. Все данные в ней удаляются.
import { databaseUrl, maskUrl } from './lib/config.mjs';
import { connect, dropSchema, migrate, seed } from './lib/db.mjs';

try {
  const client = await connect();
  try {
    await dropSchema(client);
    const done = await migrate(client);
    await seed(client);
    console.log(`[db:reset] ${maskUrl(databaseUrl)}`);
    console.log(`[db:reset] схема пересоздана, миграции: ${done.join(', ')}, начальные данные залиты`);
  } finally {
    await client.end();
  }
} catch (error) {
  console.error(`[db:reset] ${error.message}`);
  process.exitCode = 1;
}
