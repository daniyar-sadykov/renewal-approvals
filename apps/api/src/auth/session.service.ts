import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { AuthUser } from './auth.types';

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// Больше сессий у одного пользователя не держим: старые вытесняются новыми входами.
export const MAX_SESSIONS_PER_USER = 10;

// Токен: 32 случайных байта в base64url, ровно 43 символа.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Сессии в базе: там только sha256 токена, сам токен знает лишь cookie.
@Injectable()
export class SessionService {
  constructor(private readonly db: DatabaseService) {}

  async create(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    // Отдельной чистки по расписанию нет, поэтому таблицу держит в границах сам вход:
    // просроченные сессии всех пользователей удаляются, у этого остаются только последние.
    await this.db.query('delete from sessions where expires_at <= now()');
    await this.db.withTransaction(async (client) => {
      await client.query(
        `insert into sessions (token_hash, user_id, expires_at)
         values ($1, $2, now() + make_interval(secs => $3))`,
        [tokenHash, userId, SESSION_TTL_SECONDS],
      );
      await client.query(
        `delete from sessions
          where user_id = $1
            and token_hash not in (select token_hash from sessions where user_id = $1
                                    order by created_at desc, token_hash = $2 desc limit $3)`,
        [userId, tokenHash, MAX_SESSIONS_PER_USER],
      );
    });
    return token;
  }

  async findUser(token: string | undefined): Promise<{ user: AuthUser; tokenHash: string } | null> {
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    const tokenHash = hashToken(token);
    const { rows } = await this.db.query<{ id: string; login: string; display_name: string }>(
      `select u.id, u.login, u.display_name
         from sessions s join users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now()`,
      [tokenHash],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return { user: { id: row.id, login: row.login, displayName: row.display_name }, tokenHash };
  }

  async delete(tokenHash: string): Promise<void> {
    await this.db.query('delete from sessions where token_hash = $1', [tokenHash]);
  }
}
