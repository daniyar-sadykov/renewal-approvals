import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { createTestApp, DemoLogin, httpServer, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';

// Фича 06: одобрение и отклонение. Права, запрет на свою заявку, 409 на повтор и недопустимый переход.
describe('06: одобрение и отклонение', () => {
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

  const createRequest = async (login: DemoLogin = 'initiator.alpha', resourceId = 'res-a-01'): Promise<string> => {
    const agent = await loginAs(app, login);
    const response = await agent.post(`/api/resources/${resourceId}/renewal-requests`);
    expect(response.status).toBe(201);
    return response.body.id;
  };

  const requestRow = async (id: string) =>
    (await db.query('select status, decided_by, decided_at from renewal_requests where id = $1', [id])).rows[0];
  const jobsCount = async (id?: string) =>
    (await db.query('select count(*)::int as n from provider_jobs where ($1::uuid is null or request_id = $1)', [id ?? null]))
      .rows[0].n;
  const eventKinds = async (id: string) =>
    (await db.query('select kind from request_events where request_id = $1 order by id', [id])).rows.map((r) => r.kind);

  it('согласующий одобряет: 200, processing, decidedBy и decidedAt, задача в очереди', async () => {
    const id = await createRequest();
    const approver = await loginAs(app, 'approver.alpha');
    const response = await approver.post(`/api/renewal-requests/${id}/approve`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id,
      status: 'processing',
      decidedBy: { id: 'usr-approver-alpha', displayName: 'Согласующий Alpha' },
      oldExpiresOn: '2027-03-01',
      newExpiresOn: '2027-03-31',
      canApprove: false,
      canReject: false,
      canRetry: false,
    });
    expect(Number.isNaN(Date.parse(response.body.decidedAt))).toBe(false);

    const job = await db.query('select post_attempts, state, next_run_at from provider_jobs where request_id = $1', [id]);
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]).toMatchObject({ post_attempts: 0, state: 'queued' });
    expect(job.rows[0].next_run_at).toBeInstanceOf(Date);
    // Срок ресурса при одобрении не меняется: его сдвигает только подтверждение провайдера.
    expect((await db.query(`select expires_on from resources where id = 'res-a-01'`)).rows[0].expires_on).toBe('2027-03-01');
  });

  it('согласующий отклоняет: 200, rejected, задачи нет', async () => {
    const id = await createRequest();
    const approver = await loginAs(app, 'approver.alpha');
    const response = await approver.post(`/api/renewal-requests/${id}/reject`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id,
      status: 'rejected',
      decidedBy: { id: 'usr-approver-alpha' },
      canApprove: false,
      canReject: false,
    });
    expect(typeof response.body.decidedAt).toBe('string');
    expect(await jobsCount()).toBe(0);
  });

  it('флаги canApprove и canReject видны согласующему до решения', async () => {
    const id = await createRequest();
    const approver = await loginAs(app, 'approver.alpha');
    const detail = await approver.get(`/api/renewal-requests/${id}`);
    expect(detail.body.request).toMatchObject({ canApprove: true, canReject: true });
  });

  it.each(['approve', 'reject'])('инициатор без права согласующего: %s даёт 403, заявка pending', async (action) => {
    const id = await createRequest('universal.alpha');
    const initiator = await loginAs(app, 'initiator.alpha');
    const response = await initiator.post(`/api/renewal-requests/${id}/${action}`);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden', message: expect.any(String) });
    expect((await requestRow(id)).status).toBe('pending');
    expect(await jobsCount()).toBe(0);
  });

  it.each(['approve', 'reject'])('инициатор Beta на заявку Alpha: %s даёт 403', async (action) => {
    const id = await createRequest();
    const beta = await loginAs(app, 'initiator.beta');
    const response = await beta.post(`/api/renewal-requests/${id}/${action}`);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
    expect(await requestRow(id)).toMatchObject({ status: 'pending', decided_by: null });
  });

  it.each(['approve', 'reject'])('универсальный на своей заявке: %s даёт 403, заявка pending', async (action) => {
    const id = await createRequest('universal.alpha');
    const universal = await loginAs(app, 'universal.alpha');
    const response = await universal.post(`/api/renewal-requests/${id}/${action}`);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden', message: expect.stringContaining('Свою заявку') });
    expect(await requestRow(id)).toMatchObject({ status: 'pending', decided_by: null, decided_at: null });
    expect(await jobsCount()).toBe(0);
    expect(await eventKinds(id)).toEqual(['created']);
  });

  it('универсальный одобряет чужую заявку (инициатора Alpha)', async () => {
    const id = await createRequest('initiator.alpha');
    const universal = await loginAs(app, 'universal.alpha');
    const response = await universal.post(`/api/renewal-requests/${id}/approve`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'processing', decidedBy: { id: 'usr-universal-alpha' } });
  });

  it('согласующий одобряет заявку универсального', async () => {
    const id = await createRequest('universal.alpha');
    const approver = await loginAs(app, 'approver.alpha');
    const response = await approver.post(`/api/renewal-requests/${id}/approve`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'processing',
      createdBy: { id: 'usr-universal-alpha' },
      decidedBy: { id: 'usr-approver-alpha' },
    });
  });

  it('повторное одобрение: 409 invalid_transition, задача одна', async () => {
    const id = await createRequest();
    const approver = await loginAs(app, 'approver.alpha');
    expect((await approver.post(`/api/renewal-requests/${id}/approve`)).status).toBe(200);
    const again = await approver.post(`/api/renewal-requests/${id}/approve`);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'invalid_transition', message: expect.any(String) });
    // Другой согласующий тоже получает 409.
    const universal = await loginAs(app, 'universal.alpha');
    expect((await universal.post(`/api/renewal-requests/${id}/approve`)).body.error).toBe('invalid_transition');
    expect(await jobsCount(id)).toBe(1);
    expect(await eventKinds(id)).toEqual(['created', 'approved']);
  });

  it('одобрение отклонённой: 409, заявка rejected, задачи нет', async () => {
    const id = await createRequest();
    const approver = await loginAs(app, 'approver.alpha');
    expect((await approver.post(`/api/renewal-requests/${id}/reject`)).status).toBe(200);
    const response = await approver.post(`/api/renewal-requests/${id}/approve`);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('invalid_transition');
    expect((await requestRow(id)).status).toBe('rejected');
    expect(await jobsCount()).toBe(0);
  });

  it('отклонение одобренной и повторное отклонение: 409', async () => {
    const approved = await createRequest('initiator.alpha', 'res-a-01');
    const rejected = await createRequest('initiator.alpha', 'res-a-02');
    const approver = await loginAs(app, 'approver.alpha');
    expect((await approver.post(`/api/renewal-requests/${approved}/approve`)).status).toBe(200);
    expect((await approver.post(`/api/renewal-requests/${rejected}/reject`)).status).toBe(200);

    const rejectApproved = await approver.post(`/api/renewal-requests/${approved}/reject`);
    expect(rejectApproved.status).toBe(409);
    expect(rejectApproved.body.error).toBe('invalid_transition');
    expect((await requestRow(approved)).status).toBe('processing');

    const rejectTwice = await approver.post(`/api/renewal-requests/${rejected}/reject`);
    expect(rejectTwice.status).toBe(409);
    expect(rejectTwice.body.error).toBe('invalid_transition');
  });

  it('порядок проверок: сначала доступ (403), потом состояние (409)', async () => {
    const id = await createRequest('universal.alpha');
    const approver = await loginAs(app, 'approver.alpha');
    expect((await approver.post(`/api/renewal-requests/${id}/approve`)).status).toBe(200);
    // Заявка уже не pending, но своя: 403, а не 409.
    const universal = await loginAs(app, 'universal.alpha');
    expect((await universal.post(`/api/renewal-requests/${id}/reject`)).status).toBe(403);
    // Чужое пространство на решённую заявку: 403.
    const beta = await loginAs(app, 'initiator.beta');
    expect((await beta.post(`/api/renewal-requests/${id}/approve`)).status).toBe(403);
  });

  it.each(['approve', 'reject'])('несуществующая заявка и id не uuid: %s даёт 404', async (action) => {
    const approver = await loginAs(app, 'approver.alpha');
    const missing = await approver.post(`/api/renewal-requests/00000000-0000-4000-8000-000000000000/${action}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
    expect((await approver.post(`/api/renewal-requests/not-a-uuid/${action}`)).status).toBe(404);
  });

  it.each(['approve', 'reject'])('без сессии: %s даёт 401', async (action) => {
    const id = await createRequest();
    const response = await request(httpServer(app)).post(`/api/renewal-requests/${id}/${action}`);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
    expect((await requestRow(id)).status).toBe('pending');
  });

  it('поля в теле и query игнорируются', async () => {
    const id = await createRequest();
    const approver = await loginAs(app, 'approver.alpha');
    const response = await approver
      .post(`/api/renewal-requests/${id}/approve?decidedBy=usr-universal-alpha&status=completed`)
      .send({ decidedBy: 'usr-universal-alpha', decided_by: 'usr-universal-alpha', status: 'completed', userId: 'x' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'processing', decidedBy: { id: 'usr-approver-alpha' } });

    const other = await createRequest('initiator.alpha', 'res-a-02');
    const rejected = await approver.post(`/api/renewal-requests/${other}/reject`).send({ status: 'pending', decidedBy: 'x' });
    expect(rejected.body).toMatchObject({ status: 'rejected', decidedBy: { id: 'usr-approver-alpha' } });
  });

  it('после отклонения срок ресурса прежний, задач нет, можно создать новую заявку', async () => {
    const id = await createRequest();
    const approver = await loginAs(app, 'approver.alpha');
    expect((await approver.post(`/api/renewal-requests/${id}/reject`)).status).toBe(200);

    const resource = await approver.get('/api/resources/res-a-01');
    expect(resource.body.resource).toMatchObject({ expiresOn: '2027-03-01', activeRequest: null });
    expect(await jobsCount()).toBe(0);

    const next = await createRequest();
    expect(next).not.toBe(id);
    expect((await requestRow(next)).status).toBe('pending');
  });
});
