// npm run db:seed: залить начальные данные в базу из DATABASE_URL.
import { databaseUrl, maskUrl } from './lib/config.mjs';
import { connect, seed } from './lib/db.mjs';

try {
  const client = await connect();
  try {
    await seed(client);
    console.log(`[db:seed] ${maskUrl(databaseUrl)}: начальные данные на месте`);
  } finally {
    await client.end();
  }
} catch (error) {
  console.error(`[db:seed] ${error.message}`);
  process.exitCode = 1;
}
