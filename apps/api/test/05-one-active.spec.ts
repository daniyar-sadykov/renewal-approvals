import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { isActiveRequestViolation } from '../src/renewals/renewals.service';
import { createTestApp, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';

const PARALLEL = 8;

// Фича 05: у ресурса не больше одной активной заявки. Закреплено в базе и в API.
describe('05: одна активная заявка', () => {
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

  const count = async (resourceId: string, extra = '') =>
    (await db.query(`select count(*)::int as n from renewal_requests where resource_id = $1 ${extra}`, [resourceId])).rows[0].n;

  it('вторая заявка на ресурс: 409 active_request_exists', async () => {
    const agent = await loginAs(app, 'initiator.alpha');
    expect((await agent.post('/api/resources/res-a-01/renewal-requests')).status).toBe(201);

    const second = await agent.post('/api/resources/res-a-01/renewal-requests');
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'active_request_exists', message: expect.any(String) });

    // Другой пользователь того же пространства тоже получает 409.
    const universal = await loginAs(app, 'universal.alpha');
    expect((await universal.post('/api/resources/res-a-01/renewal-requests')).status).toBe(409);
    // Другой ресурс не занят.
    expect((await agent.post('/api/resources/res-a-02/renewal-requests')).status).toBe(201);
    expect(await count('res-a-01')).toBe(1);
  });

  it(`${PARALLEL} одновременных созданий: ровно один 201, остальные 409, в базе одна заявка`, async () => {
    const agents = await Promise.all([loginAs(app, 'initiator.alpha'), loginAs(app, 'universal.alpha')]);
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => agents[i % 2].post('/api/resources/res-a-01/renewal-requests')),
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, ...Array(PARALLEL - 1).fill(409)]);
    for (const response of responses.filter((r) => r.status === 409)) {
      expect(response.body.error).toBe('active_request_exists');
    }
    expect(await count('res-a-01')).toBe(1);
    const events = await db.query(
      `select count(*)::int as n from request_events e join renewal_requests r on r.id = e.request_id where r.resource_id = 'res-a-01'`,
    );
    expect(events.rows[0].n).toBe(1);
  });

  it('прямая вставка второй активной заявки в базу отбивается индексом', async () => {
    const agent = await loginAs(app, 'initiator.alpha');
    expect((await agent.post('/api/resources/res-a-01/renewal-requests')).status).toBe(201);
    for (const status of ['pending', 'processing', 'needs_attention']) {
      await expect(
        db.query(
          `insert into renewal_requests
             (workspace_id, resource_id, status, created_by, old_expires_on, new_expires_on, amount_minor, idempotency_key)
           values ('ws-alpha', 'res-a-01', $1, 'usr-universal-alpha', date '2027-03-01', date '2027-03-31', 128000,
                   'renewal-direct-' || $1)`,
          [status],
        ),
      ).rejects.toMatchObject({ code: '23505', constraint: 'renewal_requests_one_active_per_resource' });
    }
    expect(await count('res-a-01')).toBe(1);
  });

  it.each(['rejected', 'completed'])('после перевода заявки в %s можно создать новую', async (finalStatus) => {
    const agent = await loginAs(app, 'initiator.alpha');
    const first = await agent.post('/api/resources/res-a-01/renewal-requests');
    expect(first.status).toBe(201);
    await db.query(`update renewal_requests set status = $1, decided_by = 'usr-approver-alpha' where id = $2`, [
      finalStatus,
      first.body.id,
    ]);

    const next = await agent.post('/api/resources/res-a-01/renewal-requests');
    expect(next.status).toBe(201);
    expect(next.body.id).not.toBe(first.body.id);
    expect(next.body.idempotencyKey).toBe(`renewal-${next.body.id}`);
    expect(await count('res-a-01')).toBe(2);
    expect(await count('res-a-01', `and status = 'pending'`)).toBe(1);
  });

  it('needs_attention тоже занимает ресурс', async () => {
    const agent = await loginAs(app, 'initiator.alpha');
    const first = await agent.post('/api/resources/res-a-01/renewal-requests');
    await db.query(`update renewal_requests set status = 'needs_attention' where id = $1`, [first.body.id]);
    expect((await agent.post('/api/resources/res-a-01/renewal-requests')).status).toBe(409);
  });

  it('нарушение индекса распознаётся и превращается в 409, другие ошибки нет', async () => {
    let violation: unknown;
    await db.query(
      `insert into renewal_requests
         (workspace_id, resource_id, status, created_by, old_expires_on, new_expires_on, amount_minor, idempotency_key)
       values ('ws-alpha', 'res-a-02', 'pending', 'usr-initiator-alpha', date '2027-05-20', date '2027-06-19', 250000, 'renewal-x1')`,
    );
    try {
      await db.query(
        `insert into renewal_requests
           (workspace_id, resource_id, status, created_by, old_expires_on, new_expires_on, amount_minor, idempotency_key)
         values ('ws-alpha', 'res-a-02', 'pending', 'usr-initiator-alpha', date '2027-05-20', date '2027-06-19', 250000, 'renewal-x2')`,
      );
    } catch (error) {
      violation = error;
    }
    expect(isActiveRequestViolation(violation)).toBe(true);
    expect(isActiveRequestViolation({ code: '23505', constraint: 'renewal_requests_idempotency_key_key' })).toBe(false);
    expect(isActiveRequestViolation(new Error('другое'))).toBe(false);
    expect(isActiveRequestViolation(null)).toBe(false);
  });
});
