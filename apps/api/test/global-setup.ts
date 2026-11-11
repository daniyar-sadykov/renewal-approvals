import { connectTestDb } from './helpers/db';

// Один раз перед всеми тестами: база должна быть уже поднята. Если нет, падаем с понятным текстом.
export default async function globalSetup(): Promise<void> {
  const client = await connectTestDb();
  await client.end();
}
