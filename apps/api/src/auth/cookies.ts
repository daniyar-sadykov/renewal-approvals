// Минимальный разбор и сборка cookie: нужна одна cookie сессии, пакет ради неё не ставим.

export const SESSION_COOKIE = 'renewals_session';

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
}

// HttpOnly, SameSite=Lax, Path=/. maxAgeSeconds = 0 удаляет cookie.
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.maxAgeSeconds === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
