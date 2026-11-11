import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { createTestApp, httpServer, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';

// Фича 04: создание заявки. Снимок суммы и дат, плюс 30 дней, только с правом инициатора.
describe('04: создание заявки', () => {
  let app: INestApplication;
  let db: Client;

  beforeAll(async () => {
    db = await connectTestDb();
  });

  beforeEach(async () => {
    await app?.close();
    resetTestDatabase();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  const resourceRow = async (id: string) =>
    (await db.query('select expires_on, price_minor from resources where id = $1', [id])).rows[0];

  it('инициатор Alpha создаёт заявку на res-a-01 со снимком и ключом', async () => {
    const agent = await loginAs(app, 'initiator.alpha');
    const response = await agent.post('/api/resources/res-a-01/renewal-requests');
    expect(response.status).toBe(201);
    const body = response.body;
    expect(body).toMatchObject({
      workspaceId: 'ws-alpha',
      resourceId: 'res-a-01',
      resourceName: 'Хранилище A',
      status: 'pending',
      createdBy: { id: 'usr-initiator-alpha', displayName: 'Инициатор Alpha' },
      decidedBy: null,
      oldExpiresOn: '2027-03-01',
      newExpiresOn: '2027-03-31',
      amountMinor: 128000,
      currency: 'RUB',
      idempotencyKey: `renewal-${body.id}`,
      providerOperationId: null,
      lastErrorCode: null,
      decidedAt: null,
      completedAt: null,
      canApprove: false,
      canReject: false,
      canRetry: false,
    });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.createdAt).toBe('string');

    // Срок ресурса при создании не меняется.
    expect(await resourceRow('res-a-01')).toEqual({ expires_on: '2027-03-01', price_minor: 128000 });

    const stored = await db.query('select * from renewal_requests where id = $1', [body.id]);
    expect(stored.rows[0]).toMatchObject({
      status: 'pending',
      created_by: 'usr-initiator-alpha',
      old_expires_on: '2027-03-01',
      new_expires_on: '2027-03-31',
      amount_minor: 128000,
      idempotency_key: `renewal-${body.id}`,
    });

    const events = await db.query('select actor_user_id, from_status, to_status, kind from request_events where request_id = $1', [
      body.id,
    ]);
    expect(events.rows).toEqual([{ actor_user_id: 'usr-initiator-alpha', from_status: null, to_status: 'pending', kind: 'created' }]);

    // Заявка видна в карточке и активна у ресурса.
    const detail = await agent.get(`/api/renewal-requests/${body.id}`);
    expect(detail.body.events).toHaveLength(1);
    const resource = await agent.get('/api/resources/res-a-01');
    expect(resource.body.resource.activeRequest).toEqual({ id: body.id, status: 'pending' });
    expect(resource.body.resource.canCreateRequest).toBe(false);
  });

  it('плюс 30 календарных дней считает база, в том числе через конец месяца', async () => {
    const agent = await loginAs(app, 'initiator.alpha');
    const response = await agent.post('/api/resources/res-a-02/renewal-requests');
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ oldExpiresOn: '2027-05-20', newExpiresOn: '2027-06-19', amountMinor: 250000 });
  });

  it('сумма, даты, автор и пространство из тела и query игнорируются', async () => {
    const agent = await loginAs(app, 'initiator.alpha');
    const response = await agent
      .post('/api/resources/res-a-01/renewal-requests?workspaceId=ws-beta&userId=usr-universal-alpha')
      .send({
        amountMinor: 1,
        amount_minor: 1,
        currency: 'USD',
        oldExpiresOn: '2020-01-01',
        newExpiresOn: '2099-01-01',
        status: 'completed',
        createdBy: 'usr-universal-alpha',
        created_by: 'usr-universal-alpha',
        workspaceId: 'ws-beta',
        idempotencyKey: 'renewal-mine',
      });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      workspaceId: 'ws-alpha',
      status: 'pending',
      createdBy: { id: 'usr-initiator-alpha' },
      oldExpiresOn: '2027-03-01',
      newExpiresOn: '2027-03-31',
      amountMinor: 128000,
      currency: 'RUB',
      idempotencyKey: `renewal-${response.body.id}`,
    });
  });

  it('согласующий без права инициатора: 403, заявка не создана', async () => {
    const agent = await loginAs(app, 'approver.alpha');
    const response = await agent.post('/api/resources/res-a-01/renewal-requests');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden', message: expect.any(String) });
    expect((await db.query('select count(*)::int as n from renewal_requests')).rows[0].n).toBe(0);
  });

  it('инициатор Beta на ресурс Alpha: 403, на свой ресурс 201', async () => {
    const agent = await loginAs(app, 'initiator.beta');
    expect((await agent.post('/api/resources/res-a-01/renewal-requests')).status).toBe(403);
    expect((await agent.post('/api/resources/res-a-02/renewal-requests')).status).toBe(403);
    expect((await db.query('select count(*)::int as n from renewal_requests')).rows[0].n).toBe(0);

    const own = await agent.post('/api/resources/res-b-01/renewal-requests');
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ workspaceId: 'ws-beta', oldExpiresOn: '2027-06-01', newExpiresOn: '2027-07-01', amountMinor: 150000 });
  });

  it('инициатор Alpha на ресурс Beta: 403', async () => {
    const agent = await loginAs(app, 'initiator.alpha');
    expect((await agent.post('/api/resources/res-b-01/renewal-requests')).status).toBe(403);
  });

  it('универсальный Alpha может создать заявку', async () => {
    const agent = await loginAs(app, 'universal.alpha');
    const response = await agent.post('/api/resources/res-a-01/renewal-requests');
    expect(response.status).toBe(201);
    expect(response.body.createdBy).toEqual({ id: 'usr-universal-alpha', displayName: 'Универсальный Alpha' });
    // Свою заявку решать нельзя, флаги это отражают.
    expect(response.body).toMatchObject({ canApprove: false, canReject: false });
  });

  it('несуществующий ресурс: 404', async () => {
    const agent = await loginAs(app, 'initiator.alpha');
    const response = await agent.post('/api/resources/res-x-99/renewal-requests');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('not_found');
  });

  it('без сессии: 401, заявка не создана', async () => {
    const response = await request(httpServer(app)).post('/api/resources/res-a-01/renewal-requests');
    expect(response.status).toBe(401);
    expect((await db.query('select count(*)::int as n from renewal_requests')).rows[0].n).toBe(0);
  });
});
