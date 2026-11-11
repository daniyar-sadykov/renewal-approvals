// Считает хэш пароля для db/seed.sql в том же формате, что apps/api/src/auth/password.ts:
// scrypt$<salt hex>$<hash hex>, keylen 64, параметры scrypt по умолчанию.
// Запуск: node scripts/hash-password.mjs <пароль> [сколько хэшей]
import { randomBytes, scryptSync } from 'node:crypto';

const [password, count = '1'] = process.argv.slice(2);
if (!password) {
  console.error('Использование: node scripts/hash-password.mjs <пароль> [сколько хэшей]');
  process.exit(1);
}
for (let i = 0; i < Number(count); i += 1) {
  const salt = randomBytes(16);
  console.log(`scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`);
}
