import { INestApplication } from '@nestjs/common';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Client, Pool } from 'pg';
import request from 'supertest';
import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, LoginThrottle } from '../src/auth/login-throttle.service';
import { MAX_SESSIONS_PER_USER } from '../src/auth/session.service';
import { loadConfig } from '../src/config';
import { APP_CONFIG } from '../src/config.module';
import { PG_POOL } from '../src/database/database.constants';
import { MAX_RESPONSE_BYTES, ProviderClient, renewalPayload } from '../src/provider/provider.client';
import { createTestApp, DEMO_PASSWORD, httpServer, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';
import { approve, createRequest, events, requestState } from './helpers/flow';
import { waitFor } from './helpers/wait';

// Свой адрес приложения для проверки Origin: supertest слушает случайный порт, поэтому Host задаём явно.
const OWN_HOST = '127.0.0.1:5173';
const OWN_ORIGIN = `http://${OWN_HOST}`;
const EVIL_ORIGIN = 'http://evil.example';

async function countRows(db: Client, sql: string): Promise<number> {
  return (await db.query(`select count(*)::int as n from (${sql}) t`)).rows[0].n;
}

// Защитные доработки: CSRF, только JSON, заголовки, сессии, попытки входа,
// предел ответа провайдера, ответ после записи из той же транзакции.
describe('20: защитные доработки', () => {
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

  beforeEach(async () => {
    await db.query('delete from provider_jobs');
    await db.query('delete from request_events');
    await db.query('delete from renewal_requests');
    await db.query(`update resources set expires_on = date '2027-03-01' where id = 'res-a-01'`);
  });

  const api = () => request(httpServer(app));

  describe('CSRF', () => {
    it('чужой Origin на POST: 403 forbidden, заявка не создана', async () => {
      const agent = await loginAs(app, 'initiator.alpha');
      const response = await agent
        .post('/api/resources/res-a-01/renewal-requests')
        .set('Host', OWN_HOST)
        .set('Origin', EVIL_ORIGIN);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'forbidden', message: expect.any(String) });
      expect(await countRows(db, 'select 1 from renewal_requests')).toBe(0);
    });

    it('чужой Origin на открытом login: 403, сессии нет', async () => {
      const before = await countRows(db, `select 1 from sessions where user_id = 'usr-initiator-beta'`);
      const response = await api()
        .post('/api/auth/login')
        .set('Origin', EVIL_ORIGIN)
        .send({ login: 'initiator.beta', password: DEMO_PASSWORD });
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('forbidden');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(await countRows(db, `select 1 from sessions where user_id = 'usr-initiator-beta'`)).toBe(before);
    });

    it('Origin: null и мусор считаются чужими', async () => {
      for (const origin of ['null', 'not a url']) {
        const response = await api().post('/api/auth/login').set('Origin', origin).send({ login: 'x', password: 'y' });
        expect(response.status).toBe(403);
      }
    });

    it('Sec-Fetch-Site: cross-site даёт 403 даже без Origin', async () => {
      const agent = await loginAs(app, 'initiator.alpha');
      const response = await agent.post('/api/resources/res-a-01/renewal-requests').set('Sec-Fetch-Site', 'cross-site');
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('forbidden');
      expect(await countRows(db, 'select 1 from renewal_requests')).toBe(0);
    });

    it('свой Origin (как через прокси Vite) и запрос без Origin проходят', async () => {
      const login = await api()
        .post('/api/auth/login')
        .set('Host', OWN_HOST)
        .set('Origin', OWN_ORIGIN)
        .set('Sec-Fetch-Site', 'same-origin')
        .send({ login: 'initiator.alpha', password: DEMO_PASSWORD });
      expect(login.status).toBe(200);

      const agent = await loginAs(app, 'initiator.alpha');
      const own = await agent
        .post('/api/resources/res-a-01/renewal-requests')
        .set('Host', OWN_HOST)
        .set('Origin', OWN_ORIGIN)
        .set('Sec-Fetch-Site', 'same-origin');
      expect(own.status).toBe(201);
      const noOrigin = await agent.post('/api/resources/res-a-02/renewal-requests');
      expect(noOrigin.status).toBe(201);
    });

    it('GET с чужим Origin не блокируется: чтение ничего не меняет', async () => {
      const agent = await loginAs(app, 'initiator.alpha');
      const response = await agent.get('/api/resources').set('Origin', EVIL_ORIGIN);
      expect(response.status).toBe(200);
    });
  });

  describe('только JSON', () => {
    it('login формой (urlencoded): 400, входа нет', async () => {
      const response = await api()
        .post('/api/auth/login')
        .type('form')
        .send({ login: 'initiator.alpha', password: DEMO_PASSWORD });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'validation_error', message: expect.any(String) });
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('text/plain с JSON внутри: 400, входа нет', async () => {
      const response = await api()
        .post('/api/auth/login')
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ login: 'initiator.alpha', password: DEMO_PASSWORD }));
      expect(response.status).toBe(400);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('JSON с charset проходит', async () => {
      const response = await api()
        .post('/api/auth/login')
        .set('Content-Type', 'application/json; charset=utf-8')
        .send(JSON.stringify({ login: 'initiator.alpha', password: DEMO_PASSWORD }));
      expect(response.status).toBe(200);
    });
  });

  it('защитные заголовки на успехе, ошибке и 404; X-Powered-By нет', async () => {
    const agent = await loginAs(app, 'initiator.alpha');
    const responses = [
      await api().get('/api/health'),
      await api().get('/api/resources'),
      await agent.get('/api/no-such-route'),
      await api().post('/api/auth/login').set('Origin', EVIL_ORIGIN).send({}),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 401, 404, 403]);
    for (const response of responses) {
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-powered-by']).toBeUndefined();
    }
  });

  describe('сессии', () => {
    it('вход удаляет просроченные сессии всех пользователей', async () => {
      await db.query(
        `insert into sessions (token_hash, user_id, expires_at)
         values (repeat('a', 64), 'usr-initiator-beta', now() - interval '1 minute'),
                (repeat('b', 64), 'usr-approver-alpha', now() - interval '1 day'),
                (repeat('c', 64), 'usr-approver-alpha', now() + interval '1 day')`,
      );
      await loginAs(app, 'initiator.alpha');
      expect(await countRows(db, 'select 1 from sessions where expires_at <= now()')).toBe(0);
      // Действующая чужая сессия на месте.
      expect(await countRows(db, `select 1 from sessions where token_hash = repeat('c', 64)`)).toBe(1);
    });

    it(`у пользователя остаются только ${MAX_SESSIONS_PER_USER} последних сессий`, async () => {
      const first = await loginAs(app, 'universal.alpha');
      expect((await first.get('/api/auth/me')).status).toBe(200);
      let last = first;
      for (let i = 0; i < MAX_SESSIONS_PER_USER + 2; i += 1) last = await loginAs(app, 'universal.alpha');
      expect(await countRows(db, `select 1 from sessions where user_id = 'usr-universal-alpha'`)).toBe(MAX_SESSIONS_PER_USER);
      expect((await first.get('/api/auth/me')).status).toBe(401);
      expect((await last.get('/api/auth/me')).status).toBe(200);
    });
  });

  describe('попытки входа', () => {
    const throttle = () => app.get(LoginThrottle);
    const attempt = (login: string, password: string) => api().post('/api/auth/login').send({ login, password });

    afterEach(() => {
      throttle().now = () => Date.now();
    });

    it(`после ${LOGIN_MAX_FAILURES} неудач: 429 даже с верным паролем, другой логин не задет, после окна снова можно`, async () => {
      for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
        expect((await attempt('approver.alpha', 'wrong')).status).toBe(401);
      }
      const blocked = await attempt('approver.alpha', DEMO_PASSWORD);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({ error: 'too_many_attempts', message: expect.any(String) });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.headers['set-cookie']).toBeUndefined();

      expect((await attempt('initiator.beta', DEMO_PASSWORD)).status).toBe(200);

      const start = Date.now();
      throttle().now = () => start + LOGIN_WINDOW_MS + 1;
      expect((await attempt('approver.alpha', DEMO_PASSWORD)).status).toBe(200);
    });

    it('успешный вход сбрасывает счётчик', async () => {
      for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) {
        expect((await attempt('initiator.beta', 'wrong')).status).toBe(401);
      }
      expect((await attempt('initiator.beta', DEMO_PASSWORD)).status).toBe(200);
      // Без сброса десятая из этих неудач закрыла бы вход раньше.
      for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
        expect((await attempt('initiator.beta', 'wrong')).status).toBe(401);
      }
      expect((await attempt('initiator.beta', DEMO_PASSWORD)).status).toBe(429);
    });

    it('перебор множества логинов не раздувает счётчик сверх предела', () => {
      const local = new LoginThrottle();
      for (let i = 0; i < 10_050; i += 1) local.recordFailure(`user-${i}`);
      expect(local.size).toBeLessThanOrEqual(10_000);
    });
  });

  describe('ответ после записи', () => {
    it('создание, одобрение, отклонение и повтор отдают ту же заявку, что и последующее чтение', async () => {
      const initiator = await loginAs(app, 'initiator.alpha');
      const approver = await loginAs(app, 'approver.alpha');

      const created = await initiator.post('/api/resources/res-a-01/renewal-requests');
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ status: 'pending', canApprove: false, canReject: false, canRetry: false });

      const approved = await approver.post(`/api/renewal-requests/${created.body.id}/approve`);
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({
        status: 'processing',
        decidedBy: { id: 'usr-approver-alpha', displayName: 'Согласующий Alpha' },
        canApprove: false,
        canReject: false,
        canRetry: false,
        lastErrorCode: null,
      });
      expect(approved.body.decidedAt).toEqual(expect.any(String));
      const read = await approver.get(`/api/renewal-requests/${created.body.id}`);
      expect(approved.body).toEqual(read.body.request);

      const second = await initiator.post('/api/resources/res-a-02/renewal-requests');
      const rejected = await approver.post(`/api/renewal-requests/${second.body.id}/reject`);
      expect(rejected.status).toBe(200);
      expect(rejected.body).toMatchObject({ status: 'rejected', canApprove: false, canReject: false });
      expect(rejected.body).toEqual((await approver.get(`/api/renewal-requests/${second.body.id}`)).body.request);

      await db.query(`update renewal_requests set status = 'needs_attention', last_error_code = 'attempts_exhausted' where id = $1`, [
        created.body.id,
      ]);
      await db.query(`update provider_jobs set state = 'failed' where request_id = $1`, [created.body.id]);
      const retried = await approver.post(`/api/renewal-requests/${created.body.id}/retry`);
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ status: 'processing', lastErrorCode: null, canRetry: false });
      expect(retried.body).toEqual((await approver.get(`/api/renewal-requests/${created.body.id}`)).body.request);
    });
  });

  it('таймауты пула базы заданы и меньше аренды задачи по умолчанию', () => {
    const pool = app.get<Pool>(PG_POOL) as Pool & { options: { connectionTimeoutMillis?: number; statement_timeout?: number } };
    const lease = loadConfig({}).workerLeaseMs;
    expect(pool.options.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(pool.options.statement_timeout).toBeGreaterThan(0);
    expect(pool.options.connectionTimeoutMillis!).toBeLessThan(lease);
    expect(pool.options.statement_timeout!).toBeLessThan(lease);
  });
});

// Провайдер отвечает 200, но телом больше предела. Своя заглушка: заглушке из helpers такой режим не нужен.
describe('20: слишком большой ответ провайдера', () => {
  let server: http.Server;
  let baseUrl = '';
  let chunked = false;
  let posts = 0;
  let app: INestApplication | undefined;
  let db: Client;

  const bigOperation = (body: string) =>
    JSON.stringify({
      operation_id: 'op-big',
      status: 'completed',
      ...JSON.parse(body || '{}'),
      padding: 'x'.repeat(MAX_RESPONSE_BYTES + 1024),
    });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        if (req.method === 'POST') posts += 1;
        const text = bigOperation(req.method === 'POST' ? body : '');
        if (chunked) {
          // Без Content-Length: предел должен сработать по факту прочитанного.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          for (let i = 0; i < text.length; i += 8192) res.write(text.slice(i, i + 8192));
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
          res.end(text);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    resetTestDatabase();
    db = await connectTestDb();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('клиент: и по Content-Length, и chunked без него ответ считается неизвестным (bad_response)', async () => {
    const client = new ProviderClient(loadConfig({ PROVIDER_BASE_URL: baseUrl, PROVIDER_TIMEOUT_MS: '3000' }));
    const payload = renewalPayload({ resourceId: 'res-a-01', amountMinor: 128000, currency: 'RUB' });
    for (const mode of [false, true]) {
      chunked = mode;
      expect(await client.createRenewal('renewal-test-big', payload)).toEqual({ kind: 'unknown', code: 'bad_response' });
      expect(await client.getRenewal('renewal-test-big')).toEqual({ kind: 'unknown', code: 'bad_response' });
    }
  });

  it('обработчик: попытка учтена как неизвестный результат, срок не сдвинут, процесс жив', async () => {
    chunked = false;
    posts = 0;
    app = await createTestApp({
      worker: true,
      env: {
        PROVIDER_BASE_URL: baseUrl,
        PROVIDER_RETRY_DELAY_MS: '60000',
        PROVIDER_TIMEOUT_MS: '2000',
        WORKER_POLL_MS: '50',
      },
    });
    expect(app.get(APP_CONFIG).providerBaseUrl).toBe(baseUrl);

    const created = await createRequest(app);
    await approve(app, created.id);
    const state = await waitFor(
      () => requestState(db, created.id),
      (s) => s.post_attempts === 1 && s.last_error_code === 'bad_response',
      { what: 'попытка с bad_response' },
    );
    expect(state).toMatchObject({ status: 'processing', expires_on: '2027-03-01', job_state: 'queued', next_run_in_future: true });
    expect(posts).toBe(1);
    const kinds = await events(db, created.id);
    expect(kinds.map((e) => e.kind)).toEqual(['created', 'approved', 'provider_error']);
    expect(kinds[2].detail).toBe('bad_response, попытка 1 из 3');

    const health = await request(httpServer(app)).get('/api/health');
    expect(health.status).toBe(200);
  });
});
