// npm run db:migrate: применить новые миграции к базе из DATABASE_URL.
import { databaseUrl, maskUrl } from './lib/config.mjs';
import { connect, migrate } from './lib/db.mjs';

try {
  const client = await connect();
  try {
    const done = await migrate(client);
    console.log(`[db:migrate] ${maskUrl(databaseUrl)}`);
    console.log(done.length ? `[db:migrate] применено: ${done.join(', ')}` : '[db:migrate] новых миграций нет');
  } finally {
    await client.end();
  }
} catch (error) {
  console.error(`[db:migrate] ${error.message}`);
  process.exitCode = 1;
}
