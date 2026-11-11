import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { createTestApp, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';

// Фича 09: история заявки. Каждое действие пишет автора, время и переход; отказы ничего не пишут.
describe('09: история заявки', () => {
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

  const createRequest = async (resourceId = 'res-a-01'): Promise<string> => {
    const agent = await loginAs(app, 'initiator.alpha');
    const response = await agent.post(`/api/resources/${resourceId}/renewal-requests`);
    expect(response.status).toBe(201);
    return response.body.id;
  };

  const expectValidTimes = (events: { createdAt: string }[]) => {
    const times = events.map((e) => Date.parse(e.createdAt));
    for (const t of times) expect(Number.isNaN(t)).toBe(false);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
  };

  it('created -> approved: события по порядку с автором и переходом', async () => {
    const id = await createRequest();
    const approver = await loginAs(app, 'approver.alpha');
    expect((await approver.post(`/api/renewal-requests/${id}/approve`)).status).toBe(200);

    // История видна и инициатору, и согласующему.
    for (const login of ['initiator.alpha', 'approver.alpha'] as const) {
      const agent = await loginAs(app, login);
      const response = await agent.get(`/api/renewal-requests/${id}`);
      expect(response.status).toBe(200);
      const events = response.body.events;
      expect(events).toEqual([
        {
          id: expect.any(Number),
          actor: { id: 'usr-initiator-alpha', displayName: 'Инициатор Alpha' },
          fromStatus: null,
          toStatus: 'pending',
          kind: 'created',
          detail: null,
          createdAt: expect.any(String),
        },
        {
          id: expect.any(Number),
          actor: { id: 'usr-approver-alpha', displayName: 'Согласующий Alpha' },
          fromStatus: 'pending',
          toStatus: 'processing',
          kind: 'approved',
          detail: null,
          createdAt: expect.any(String),
        },
      ]);
      expect(events[1].id).toBeGreaterThan(events[0].id);
      expectValidTimes(events);
    }
  });

  it('created -> rejected: события по порядку с автором и переходом', async () => {
    const id = await createRequest();
    const universal = await loginAs(app, 'universal.alpha');
    expect((await universal.post(`/api/renewal-requests/${id}/reject`)).status).toBe(200);

    const response = await universal.get(`/api/renewal-requests/${id}`);
    expect(response.body.events.map((e: { kind: string }) => e.kind)).toEqual(['created', 'rejected']);
    expect(response.body.events[1]).toMatchObject({
      actor: { id: 'usr-universal-alpha', displayName: 'Универсальный Alpha' },
      fromStatus: 'pending',
      toStatus: 'rejected',
      kind: 'rejected',
    });
    expectValidTimes(response.body.events);
  });

  it('отказные попытки (403, 409, 404) событий не добавляют', async () => {
    const id = await createRequest();
    const initiator = await loginAs(app, 'initiator.alpha');
    const beta = await loginAs(app, 'initiator.beta');
    const approver = await loginAs(app, 'approver.alpha');

    expect((await initiator.post(`/api/renewal-requests/${id}/approve`)).status).toBe(403);
    expect((await initiator.post(`/api/renewal-requests/${id}/reject`)).status).toBe(403);
    expect((await beta.post(`/api/renewal-requests/${id}/approve`)).status).toBe(403);
    expect((await approver.post(`/api/renewal-requests/${id}/approve`)).status).toBe(200);
    expect((await approver.post(`/api/renewal-requests/${id}/approve`)).status).toBe(409);
    expect((await approver.post(`/api/renewal-requests/${id}/reject`)).status).toBe(409);

    const stale = await createRequest('res-a-02');
    await db.query(`update resources set price_minor = price_minor + 1 where id = 'res-a-02'`);
    expect((await approver.post(`/api/renewal-requests/${stale}/approve`)).status).toBe(409);

    const events = (await approver.get(`/api/renewal-requests/${id}`)).body.events;
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(['created', 'approved']);
    const staleEvents = (await approver.get(`/api/renewal-requests/${stale}`)).body.events;
    expect(staleEvents.map((e: { kind: string }) => e.kind)).toEqual(['created']);
    expect((await db.query('select count(*)::int as n from request_events')).rows[0].n).toBe(3);
  });

  it('пользователь Beta историю заявки Alpha не читает: 403', async () => {
    const id = await createRequest();
    const approver = await loginAs(app, 'approver.alpha');
    expect((await approver.post(`/api/renewal-requests/${id}/approve`)).status).toBe(200);

    const beta = await loginAs(app, 'initiator.beta');
    const response = await beta.get(`/api/renewal-requests/${id}`);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden', message: expect.any(String) });
    expect(response.body.events).toBeUndefined();
  });
});
