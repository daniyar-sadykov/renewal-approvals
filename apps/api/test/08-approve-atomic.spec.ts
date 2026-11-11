import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { isProviderJobDuplicate } from '../src/renewals/renewal-decisions.service';
import { createTestApp, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';

const PARALLEL = 8;

// Фича 08: одобрение и задача отправки сохраняются одной транзакцией,
// параллельные решения сериализуются блокировкой строки заявки.
describe('08: атомарность и параллельное одобрение', () => {
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

  const state = async (id: string) => {
    const { rows } = await db.query(
      `select rr.status, rr.decided_by,
              (select count(*)::int from provider_jobs j where j.request_id = rr.id) as jobs,
              (select count(*)::int from request_events e where e.request_id = rr.id and e.kind = 'approved') as approved,
              (select count(*)::int from request_events e where e.request_id = rr.id and e.kind = 'rejected') as rejected
         from renewal_requests rr where rr.id = $1`,
      [id],
    );
    return rows[0];
  };

  it(`${PARALLEL} одновременных одобрений: один 200, остальные 409, одна задача, одно событие`, async () => {
    const id = await createRequest();
    const agents = await Promise.all([loginAs(app, 'approver.alpha'), loginAs(app, 'universal.alpha')]);
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => agents[i % 2].post(`/api/renewal-requests/${id}/approve`)),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, ...Array(PARALLEL - 1).fill(409)]);
    for (const response of responses.filter((r) => r.status === 409)) {
      expect(response.body.error).toBe('invalid_transition');
    }
    const winner = responses.find((r) => r.status === 200)!;
    const s = await state(id);
    expect(s).toMatchObject({ status: 'processing', jobs: 1, approved: 1, rejected: 0 });
    expect(s.decided_by).toBe(winner.body.decidedBy.id);
    expect((await db.query('select count(*)::int as n from provider_jobs')).rows[0].n).toBe(1);
  });

  it('одобрение без задачи невозможно: сбой вставки задачи откатывает одобрение целиком', async () => {
    const id = await createRequest();
    // Задача на эту заявку уже есть: вставка в provider_jobs при одобрении упадёт на request_id unique.
    await db.query(`insert into provider_jobs (request_id, state) values ($1, 'queued')`, [id]);

    const approver = await loginAs(app, 'approver.alpha');
    const response = await approver.post(`/api/renewal-requests/${id}/approve`);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'invalid_transition', message: expect.any(String) });

    // Смена статуса и событие шли раньше вставки задачи в той же транзакции и откатились вместе с ней.
    const row = (await db.query('select status, decided_by, decided_at from renewal_requests where id = $1', [id])).rows[0];
    expect(row).toEqual({ status: 'pending', decided_by: null, decided_at: null });
    expect(await state(id)).toMatchObject({ jobs: 1, approved: 0 });
    const kinds = (await db.query('select kind from request_events where request_id = $1 order by id', [id])).rows;
    expect(kinds).toEqual([{ kind: 'created' }]);
  });

  it('распознавание дубля задачи: только request_id unique в provider_jobs', () => {
    expect(isProviderJobDuplicate({ code: '23505', constraint: 'provider_jobs_request_id_key' })).toBe(true);
    expect(isProviderJobDuplicate({ code: '23505', constraint: 'renewal_requests_one_active_per_resource' })).toBe(false);
    expect(isProviderJobDuplicate(new Error('другое'))).toBe(false);
    expect(isProviderJobDuplicate(null)).toBe(false);
  });

  it('одновременные одобрения и отклонения одной заявки: один успех, состояние согласовано с победителем', async () => {
    const approver = await loginAs(app, 'approver.alpha');
    const universal = await loginAs(app, 'universal.alpha');
    // Несколько раундов, чтобы побеждали разные действия.
    for (let round = 0; round < 6; round++) {
      const resourceId = round % 2 === 0 ? 'res-a-01' : 'res-a-02';
      const active = await db.query(
        `select id from renewal_requests where resource_id = $1 and status in ('pending', 'processing')`,
        [resourceId],
      );
      // Ресурс занят одобренной заявкой прошлого раунда: освобождаем его прямым SQL.
      for (const r of active.rows) {
        await db.query(`update renewal_requests set status = 'completed' where id = $1`, [r.id]);
      }
      const id = await createRequest(resourceId);
      const calls = [
        approver.post(`/api/renewal-requests/${id}/approve`),
        universal.post(`/api/renewal-requests/${id}/reject`),
        universal.post(`/api/renewal-requests/${id}/approve`),
        approver.post(`/api/renewal-requests/${id}/reject`),
      ];
      const responses = await Promise.all(round % 2 === 0 ? calls : calls.reverse());
      const ok = responses.filter((r) => r.status === 200);
      expect(ok).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(3);
      for (const r of responses.filter((r) => r.status === 409)) expect(r.body.error).toBe('invalid_transition');

      const s = await state(id);
      if (ok[0].body.status === 'processing') {
        expect(s).toMatchObject({ status: 'processing', jobs: 1, approved: 1, rejected: 0 });
      } else {
        expect(ok[0].body.status).toBe('rejected');
        expect(s).toMatchObject({ status: 'rejected', jobs: 0, approved: 0, rejected: 1 });
      }
      expect(s.decided_by).toBe(ok[0].body.decidedBy.id);
    }
  });
});
