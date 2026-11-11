import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Формат хэша: scrypt$<salt hex>$<hash hex>. Длина ключа 64 байта, параметры scrypt по умолчанию.
const PREFIX = 'scrypt';
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt);
  return `${PREFIX}$${salt.toString('hex')}$${key.toString('hex')}`;
}

// Возвращает false и для неверного пароля, и для хэша в чужом или битом формате.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [prefix, saltHex, hashHex, ...rest] = stored.split('$');
  if (prefix !== PREFIX || !saltHex || !hashHex || rest.length > 0) return false;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, Buffer.from(saltHex, 'hex'));
  return timingSafeEqual(actual, expected);
}
