import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { createTestApp, DEMO_PASSWORD, DemoLogin, httpServer, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';

type Agent = ReturnType<typeof request.agent>;

// Независимая сверка ожидаемых дат: плюс 30 суток в UTC, без часовых поясов.
const plus30 = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);

// Фича 22: плюс 30 календарных дней через границы месяца, года и 29 февраля.
describe('22: новый срок через границы календаря', () => {
  let app: INestApplication;
  let db: Client;
  let initiator: Agent;
  let approver: Agent;

  beforeAll(async () => {
    db = await connectTestDb();
    resetTestDatabase();
    app = await createTestApp();
    initiator = await loginAs(app, 'initiator.alpha');
    approver = await loginAs(app, 'approver.alpha');
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it.each([
    ['конец года', '2026-12-15', '2027-01-14'],
    ['31 января, невисокосный февраль', '2027-01-31', '2027-03-02'],
    ['28 февраля невисокосного года', '2027-02-28', '2027-03-30'],
    ['попадание на 29 февраля', '2028-01-30', '2028-02-29'],
    ['от 29 февраля', '2028-02-29', '2028-03-30'],
    ['через весь високосный февраль', '2028-02-01', '2028-03-02'],
  ])('%s: %s -> %s', async (_case, from, to) => {
    expect(plus30(from)).toBe(to);
    await db.query(`update resources set expires_on = $1::date where id = 'res-a-01'`, [from]);

    const created = await initiator.post('/api/resources/res-a-01/renewal-requests');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ oldExpiresOn: from, newExpiresOn: to, status: 'pending' });

    const row = await db.query(
      `select rr.old_expires_on, rr.new_expires_on, r.expires_on
         from renewal_requests rr join resources r on r.id = rr.resource_id
        where rr.id = $1`,
      [created.body.id],
    );
    // Срок ресурса при создании заявки не меняется.
    expect(row.rows[0]).toEqual({ old_expires_on: from, new_expires_on: to, expires_on: from });

    // Отклонение освобождает ресурс для следующего случая.
    const rejected = await approver.post(`/api/renewal-requests/${created.body.id}/reject`);
    expect(rejected.status).toBe(200);
    expect((await db.query(`select expires_on from resources where id = 'res-a-01'`)).rows[0].expires_on).toBe(from);
  });
});

// Фича 22: пользователь, роль и пространство берутся только из сессии. Заголовки с данными
// согласующего Alpha (в том числе его настоящий токен в Authorization) ничего не дают.
describe('22: подмена пользователя и роли заголовками на действиях с заявкой', () => {
  let app: INestApplication;
  let db: Client;
  let spoof: Record<string, string>;
  let alphaId = '';
  let universalId = '';

  const as = (login: DemoLogin) => loginAs(app, login);

  beforeAll(async () => {
    db = await connectTestDb();
    resetTestDatabase();
    app = await createTestApp();

    // Настоящий токен сессии согласующего: если бы сервер читал Authorization, подмена сработала бы.
    const login = await request(httpServer(app)).post('/api/auth/login').send({ login: 'approver.alpha', password: DEMO_PASSWORD });
    expect(login.status).toBe(200);
    const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? []).find((c) => c.startsWith('renewals_session='));
    const token = decodeURIComponent(cookie!.split(';')[0].slice('renewals_session='.length));
    expect(token.length).toBeGreaterThan(0);
    spoof = {
      'X-User-Id': 'usr-approver-alpha',
      'X-User': 'approver.alpha',
      'X-Workspace-Id': 'ws-alpha',
      'X-Role': 'approver',
      'X-Forwarded-User': 'approver.alpha',
      Authorization: `Bearer ${token}`,
    };

    const alpha = await (await as('initiator.alpha')).post('/api/resources/res-a-01/renewal-requests');
    expect(alpha.status).toBe(201);
    alphaId = alpha.body.id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  const expectForbidden = (response: request.Response) => {
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
  };

  it('initiator.beta: 403 на approve, reject, retry заявки Alpha и на создание в Alpha', async () => {
    const beta = await as('initiator.beta');
    for (const action of ['approve', 'reject', 'retry']) {
      expectForbidden(await beta.post(`/api/renewal-requests/${alphaId}/${action}`).set(spoof));
    }
    // res-a-02 свободен: кроме 403 создать заявку не мешает ничего.
    expectForbidden(await beta.post('/api/resources/res-a-02/renewal-requests').set(spoof));
  });

  it('approver.alpha: 403 на создание заявки', async () => {
    const approver = await as('approver.alpha');
    expectForbidden(await approver.post('/api/resources/res-a-02/renewal-requests').set(spoof));
  });

  it('initiator.alpha без права согласующего: 403 на approve и reject своей и чужой заявки', async () => {
    const universal = await (await as('universal.alpha')).post('/api/resources/res-a-02/renewal-requests');
    expect(universal.status).toBe(201);
    universalId = universal.body.id;

    const initiator = await as('initiator.alpha');
    for (const id of [alphaId, universalId]) {
      for (const action of ['approve', 'reject']) {
        expectForbidden(await initiator.post(`/api/renewal-requests/${id}/${action}`).set(spoof));
      }
    }
  });

  it('universal.alpha с заголовками другого пользователя: 403 на approve и reject своей заявки', async () => {
    const universal = await as('universal.alpha');
    expectForbidden(await universal.post(`/api/renewal-requests/${universalId}/approve`).set(spoof));
    expectForbidden(await universal.post(`/api/renewal-requests/${universalId}/reject`).set(spoof));
  });

  it('без cookie только с заголовками: 401', async () => {
    const anonymous = request(httpServer(app));
    const attempts = [
      ...['approve', 'reject', 'retry'].map((action) => `/api/renewal-requests/${alphaId}/${action}`),
      '/api/resources/res-b-01/renewal-requests',
      '/api/resources/res-a-01/renewal-requests',
    ];
    for (const path of attempts) {
      const response = await anonymous.post(path).set(spoof);
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('unauthorized');
    }
  });

  it('после всех попыток: заявки pending, задач нет, событий кроме created нет', async () => {
    const requests = await db.query('select id, status from renewal_requests order by created_at');
    expect(requests.rows).toEqual([
      { id: alphaId, status: 'pending' },
      { id: universalId, status: 'pending' },
    ]);
    expect((await db.query('select count(*)::int as n from provider_jobs')).rows[0].n).toBe(0);
    const kinds = await db.query('select request_id, kind from request_events order by id');
    expect(kinds.rows).toEqual([
      { request_id: alphaId, kind: 'created' },
      { request_id: universalId, kind: 'created' },
    ]);
  });
});
