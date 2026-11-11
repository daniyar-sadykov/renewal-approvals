import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { createTestApp, DEMO_PASSWORD, httpServer, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';

function sessionCookie(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = list.find((value) => value.startsWith('renewals_session='));
  if (!cookie) throw new Error('Нет cookie сессии');
  return cookie;
}

function tokenOf(cookie: string): string {
  return decodeURIComponent(cookie.split(';')[0].split('=')[1]);
}

// Фича 02: вход, выход, текущий пользователь, 401 без сессии, единый формат ошибок.
describe('02: вход и сессия', () => {
  let app: INestApplication;
  let db: Client;

  beforeAll(async () => {
    resetTestDatabase();
    db = await connectTestDb();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  const api = () => request(httpServer(app));

  it('успешный вход ставит cookie HttpOnly, SameSite=Lax, Path=/ и отдаёт пользователя', async () => {
    const response = await api().post('/api/auth/login').send({ login: 'initiator.alpha', password: DEMO_PASSWORD });
    expect(response.status).toBe(200);
    const cookie = sessionCookie(response.headers['set-cookie']);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; Max-Age=604800/);
    expect(tokenOf(cookie)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.body.user).toEqual({ id: 'usr-initiator-alpha', login: 'initiator.alpha', displayName: 'Инициатор Alpha' });
    expect(JSON.stringify(response.body)).not.toContain(tokenOf(cookie));
  });

  it('me возвращает пользователя и его членства', async () => {
    const agent = await loginAs(app, 'universal.alpha');
    const response = await agent.get('/api/auth/me');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      user: { id: 'usr-universal-alpha', login: 'universal.alpha', displayName: 'Универсальный Alpha' },
      memberships: [{ workspaceId: 'ws-alpha', workspaceName: 'Alpha', canInitiate: true, canApprove: true }],
    });

    const beta = await (await loginAs(app, 'initiator.beta')).get('/api/auth/me');
    expect(beta.body.memberships).toEqual([
      { workspaceId: 'ws-beta', workspaceName: 'Beta', canInitiate: true, canApprove: false },
    ]);
  });

  it('неверный пароль и несуществующий логин дают одинаковый 401 без cookie', async () => {
    const wrongPassword = await api().post('/api/auth/login').send({ login: 'initiator.alpha', password: 'wrong' });
    const unknownLogin = await api().post('/api/auth/login').send({ login: 'nobody', password: DEMO_PASSWORD });
    for (const response of [wrongPassword, unknownLogin]) {
      expect(response.status).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(wrongPassword.body).toEqual({ error: 'unauthorized', message: 'Неверный логин или пароль' });
    expect(unknownLogin.body).toEqual(wrongPassword.body);
  });

  it('вход без логина или пароля: 400 validation_error', async () => {
    for (const body of [{}, { login: 'initiator.alpha' }, { login: 1, password: 2 }, { login: '', password: '' }]) {
      const response = await api().post('/api/auth/login').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('validation_error');
    }
    const broken = await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{"login":');
    expect(broken.status).toBe(400);
    expect(broken.body).toEqual({ error: 'validation_error', message: expect.any(String) });
  });

  it('без cookie: 401 на защищённых маршрутах, health открыт', async () => {
    for (const path of ['/api/auth/me', '/api/resources', '/api/renewal-requests', '/api/resources/res-a-01']) {
      const response = await api().get(path);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'unauthorized', message: expect.any(String) });
    }
    expect((await api().post('/api/auth/logout')).status).toBe(401);
    expect((await api().post('/api/resources/res-a-01/renewal-requests')).status).toBe(401);
    expect((await api().get('/api/health')).status).toBe(200);
  });

  it('мусорный cookie: 401', async () => {
    for (const value of ['garbage', 'A'.repeat(43), '%E0%A4%A', '']) {
      const response = await api().get('/api/auth/me').set('Cookie', `renewals_session=${value}`);
      expect(response.status).toBe(401);
    }
  });

  it('после logout сессия удалена и cookie сброшен', async () => {
    const login = await api().post('/api/auth/login').send({ login: 'approver.alpha', password: DEMO_PASSWORD });
    const cookie = sessionCookie(login.headers['set-cookie']).split(';')[0];
    expect((await api().get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);

    const logout = await api().post('/api/auth/logout').set('Cookie', cookie);
    expect(logout.status).toBe(204);
    const cleared = sessionCookie(logout.headers['set-cookie']);
    expect(cleared).toMatch(/^renewals_session=;/);
    expect(cleared).toMatch(/Max-Age=0/);

    expect((await api().get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    const hash = createHash('sha256').update(tokenOf(cookie)).digest('hex');
    expect((await db.query('select 1 from sessions where token_hash = $1', [hash])).rowCount).toBe(0);
  });

  it('просроченная сессия: 401', async () => {
    const login = await api().post('/api/auth/login').send({ login: 'initiator.beta', password: DEMO_PASSWORD });
    const cookie = sessionCookie(login.headers['set-cookie']).split(';')[0];
    expect((await api().get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);

    const hash = createHash('sha256').update(tokenOf(cookie)).digest('hex');
    await db.query(`update sessions set expires_at = now() - interval '1 second' where token_hash = $1`, [hash]);
    expect((await api().get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('в sessions лежит только sha256 токена, срок около 7 дней', async () => {
    const login = await api().post('/api/auth/login').send({ login: 'initiator.alpha', password: DEMO_PASSWORD });
    const token = tokenOf(sessionCookie(login.headers['set-cookie']));
    const { rows } = await db.query(
      `select token_hash, user_id, extract(epoch from expires_at - now()) as ttl from sessions where user_id = 'usr-initiator-alpha'`,
    );
    const hash = createHash('sha256').update(token).digest('hex');
    expect(rows.map((row) => row.token_hash)).toContain(hash);
    for (const row of rows) {
      expect(row.token_hash).not.toContain(token);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const own = rows.find((row) => row.token_hash === hash);
    expect(Number(own.ttl)).toBeGreaterThan(7 * 24 * 3600 - 60);
    expect(Number(own.ttl)).toBeLessThanOrEqual(7 * 24 * 3600);
  });

  it('пользователь берётся только из сессии: поля запроса не подменяют его', async () => {
    const agent = await loginAs(app, 'initiator.beta');
    const response = await agent
      .get('/api/auth/me?userId=usr-universal-alpha&login=universal.alpha')
      .set('X-User-Id', 'usr-universal-alpha');
    expect(response.body.user.id).toBe('usr-initiator-beta');
  });

  it('неизвестный маршрут: 404 в едином формате', async () => {
    const agent = await loginAs(app, 'initiator.alpha');
    const response = await agent.get('/api/no-such-route');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found', message: expect.any(String) });
  });
});
