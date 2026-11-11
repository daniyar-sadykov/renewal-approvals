import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { unauthorized, validationError } from '../common/api-error';
import { APP_CONFIG } from '../config.module';
import { AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';
import { AccessService, Membership } from './access.service';
import { CurrentUser, Public } from './auth.decorators';
import { AuthedRequest, AuthUser } from './auth.types';
import { serializeCookie, SESSION_COOKIE } from './cookies';
import { verifyPassword } from './password';
import { SESSION_TTL_SECONDS, SessionService } from './session.service';

// Хэш для несуществующего логина: проверка идёт столько же, сколько для настоящего.
const DUMMY_HASH =
  'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);

const MAX_FIELD_LENGTH = 200;

interface MeResponse {
  user: AuthUser;
  memberships: Membership[];
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessions: SessionService,
    private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // POST /api/auth/login { login, password }
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: ServerResponse): Promise<MeResponse> {
    const { login, password } = (body ?? {}) as Record<string, unknown>;
    if (
      typeof login !== 'string' ||
      typeof password !== 'string' ||
      login.length === 0 ||
      password.length === 0 ||
      login.length > MAX_FIELD_LENGTH ||
      password.length > MAX_FIELD_LENGTH
    ) {
      throw validationError('Укажите логин и пароль');
    }

    const { rows } = await this.db.query<{ id: string; login: string; display_name: string; password_hash: string }>(
      'select id, login, display_name, password_hash from users where login = $1',
      [login],
    );
    const row = rows[0];
    const valid = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !valid) throw unauthorized('Неверный логин или пароль');

    const token = await this.sessions.create(row.id);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_TTL_SECONDS, secure: this.config.cookieSecure }),
    );
    const user = { id: row.id, login: row.login, displayName: row.display_name };
    return { user, memberships: await this.access.listMemberships(user.id) };
  }

  // POST /api/auth/logout: удаляет сессию и cookie.
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: ServerResponse): Promise<void> {
    if (req.sessionTokenHash) await this.sessions.delete(req.sessionTokenHash);
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: this.config.cookieSecure }));
  }

  // GET /api/auth/me
  @Get('me')
  async me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return { user, memberships: await this.access.listMemberships(user.id) };
  }
}
