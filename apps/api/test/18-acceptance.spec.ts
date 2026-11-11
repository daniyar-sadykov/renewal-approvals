import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { ProviderJobsService } from '../src/provider/provider-jobs.service';
import { createTestApp, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';
import { events, requestState, waitForStatus } from './helpers/flow';
import {
  SIMULATOR_URL,
  SimulatorOperation,
  simulatorOperation,
  simulatorStats,
  startSimulator,
  stopSimulator,
} from './helpers/simulator';
import { waitFor } from './helpers/wait';

// Пауза после 503 длинная: окно, в которое приложение успевает остановиться до следующего шага.
const WORKER_ENV = {
  PROVIDER_BASE_URL: SIMULATOR_URL,
  PROVIDER_RETRY_DELAY_MS: '3000',
  PROVIDER_TIMEOUT_MS: '2000',
  WORKER_POLL_MS: '50',
};

const PARALLEL = 4;

interface HistoryEvent {
  kind: string;
  actor: { id: string; displayName: string } | null;
  fromStatus: string | null;
  toStatus: string;
  detail: string | null;
}

// Фича 18: контрольный сценарий приёмки из спеки, шаги 1-6 по порядку.
// Один имитатор на весь файл без перезапуска, одна база без сброса между шагами.
describe('18: контрольный сценарий приёмки', () => {
  let app: INestApplication | undefined;
  let db: Client;

  // Общее состояние шагов.
  let alphaId = '';
  let alphaKey = '';
  let universalId = '';
  let universalKey = '';
  let stored: SimulatorOperation | null = null;

  const current = (): INestApplication => {
    if (!app) throw new Error('Приложение не запущено');
    return app;
  };

  beforeAll(async () => {
    db = await connectTestDb();
    resetTestDatabase();
    await startSimulator();
    app = await createTestApp({ worker: true, env: WORKER_ENV });
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await stopSimulator();
  });

  it('1: Инициатор Alpha создаёт заявку на res-a-01, срок прежний, вторая активная заявка 409', async () => {
    const initiator = await loginAs(current(), 'initiator.alpha');
    const created = await initiator.post('/api/resources/res-a-01/renewal-requests');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      resourceId: 'res-a-01',
      status: 'pending',
      oldExpiresOn: '2027-03-01',
      newExpiresOn: '2027-03-31',
      amountMinor: 128000,
      currency: 'RUB',
      createdBy: { id: 'usr-initiator-alpha' },
      decidedBy: null,
      providerOperationId: null,
      lastErrorCode: null,
    });
    alphaId = created.body.id;
    alphaKey = created.body.idempotencyKey;
    expect(alphaKey).toBe(`renewal-${alphaId}`);

    const resource = await initiator.get('/api/resources/res-a-01');
    expect(resource.status).toBe(200);
    expect(resource.body.resource).toMatchObject({
      expiresOn: '2027-03-01',
      activeRequest: { id: alphaId, status: 'pending' },
      canCreateRequest: false,
    });

    const second = await initiator.post('/api/resources/res-a-01/renewal-requests');
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('active_request_exists');
    expect((await db.query(`select count(*)::int as n from renewal_requests where resource_id = 'res-a-01'`)).rows[0].n).toBe(1);
    expect(await requestState(db, alphaId)).toMatchObject({ status: 'pending', expires_on: '2027-03-01', job_state: null });
  });

  it('2: Инициатор Beta не видит ресурс и заявку Alpha, Универсальный не согласует свою заявку', async () => {
    const beta = await loginAs(current(), 'initiator.beta');
    const checks = await Promise.all([
      beta.get('/api/resources/res-a-01'),
      beta.get(`/api/renewal-requests/${alphaId}`),
      beta.post(`/api/renewal-requests/${alphaId}/approve`),
      beta.post(`/api/renewal-requests/${alphaId}/reject`),
      beta.post(`/api/renewal-requests/${alphaId}/retry`),
    ]);
    for (const response of checks) {
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('forbidden');
    }
    const list = await beta.get('/api/renewal-requests');
    expect(list.status).toBe(200);
    expect((list.body as { id: string }[]).map((r) => r.id)).not.toContain(alphaId);

    const universal = await loginAs(current(), 'universal.alpha');
    const created = await universal.post('/api/resources/res-a-02/renewal-requests');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'pending', oldExpiresOn: '2027-05-20', canApprove: false, canReject: false });
    universalId = created.body.id;
    universalKey = created.body.idempotencyKey;

    for (const action of ['approve', 'reject']) {
      const response = await universal.post(`/api/renewal-requests/${universalId}/${action}`);
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('forbidden');
    }
    expect(await requestState(db, universalId)).toMatchObject({ status: 'pending', expires_on: '2027-05-20', job_state: null });
    // Неудачные попытки событий не пишут.
    expect((await events(db, universalId)).map((e) => e.kind)).toEqual(['created']);
    expect((await events(db, alphaId)).map((e) => e.kind)).toEqual(['created']);
  });

  it(`3: Согласующий Alpha одобряет, ${PARALLEL} параллельных одобрения: один 200, одна задача, повтор 409`, async () => {
    const agents = await Promise.all(Array.from({ length: PARALLEL }, () => loginAs(current(), 'approver.alpha')));
    const responses = await Promise.all(agents.map((a) => a.post(`/api/renewal-requests/${alphaId}/approve`)));
    expect(responses.map((r) => r.status).sort()).toEqual([200, ...Array(PARALLEL - 1).fill(409)]);
    for (const r of responses.filter((r) => r.status === 409)) expect(r.body.error).toBe('invalid_transition');
    const winner = responses.find((r) => r.status === 200)!;
    expect(winner.body).toMatchObject({ status: 'processing', decidedBy: { id: 'usr-approver-alpha' }, idempotencyKey: alphaKey });

    const jobs = await db.query('select request_id from provider_jobs');
    expect(jobs.rows).toEqual([{ request_id: alphaId }]);
    expect((await events(db, alphaId)).filter((e) => e.kind === 'approved')).toHaveLength(1);

    const again = await agents[0].post(`/api/renewal-requests/${alphaId}/approve`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('invalid_transition');
  });

  it('4: первая отправка 503, остановка и новый запуск, тот же ключ, сохранённый результат', async () => {
    const afterFirst = await waitFor(
      async () => ({ state: await requestState(db, alphaId), kinds: (await events(db, alphaId)).map((e) => e.kind) }),
      (v) => v.state.post_attempts === 1 && v.kinds.includes('provider_error'),
      { what: 'первая 503 и событие provider_error' },
    );
    expect(afterFirst.state).toMatchObject({
      status: 'processing',
      expires_on: '2027-03-01',
      last_error_code: 'http_503',
      next_run_in_future: true,
      idempotency_key: alphaKey,
    });

    await current().close();
    app = undefined;

    // Приложение остановлено: заявка ждёт, срок прежний, у имитатора уже есть операция по ключу.
    expect(await requestState(db, alphaId)).toMatchObject({ status: 'processing', expires_on: '2027-03-01', post_attempts: 1 });
    stored = await simulatorOperation(alphaKey);
    expect(stored).toMatchObject({ status: 'completed', started_count: 1, resource_id: 'res-a-01', amount_minor: 128000 });

    app = await createTestApp({ worker: true, env: WORKER_ENV });
    const final = await waitForStatus(db, alphaId, 'completed');
    expect(final).toMatchObject({
      idempotency_key: alphaKey,
      provider_operation_id: stored!.operation_id,
      post_attempts: 1,
      job_state: 'done',
    });
  });

  it('5: completed, срок 2027-03-31, повторная обработка дату не меняет, started_count 1, operation_count 1', async () => {
    expect(await requestState(db, alphaId)).toMatchObject({ status: 'completed', expires_on: '2027-03-31', last_error_code: null });

    const jobs = current().get(ProviderJobsService);
    expect(await jobs.finalize(alphaId, stored!.operation_id)).toBe('already_final');

    // Задача снова в очереди: обработчик берёт её и только закрывает.
    await db.query(`update provider_jobs set state = 'queued', next_run_at = now(), lease_until = null where request_id = $1`, [
      alphaId,
    ]);
    await waitFor(() => requestState(db, alphaId), (s) => s.job_state === 'done', { what: 'задача снова закрыта' });

    expect(await requestState(db, alphaId)).toMatchObject({
      status: 'completed',
      expires_on: '2027-03-31',
      provider_operation_id: stored!.operation_id,
      post_attempts: 1,
    });
    expect((await events(db, alphaId)).filter((e) => e.kind === 'completed')).toHaveLength(1);
    expect(await simulatorOperation(alphaKey)).toMatchObject({ operation_id: stored!.operation_id, started_count: 1 });
    expect(await simulatorStats('res-a-01')).toEqual({ resource_id: 'res-a-01', operation_count: 1 });

    const initiator = await loginAs(current(), 'initiator.alpha');
    const resource = await initiator.get('/api/resources/res-a-01');
    expect(resource.body.resource).toMatchObject({ expiresOn: '2027-03-31', activeRequest: null });
  });

  it('6: отклонённая заявка к провайдеру не уходит, статистика других ресурсов 0, история через API', async () => {
    const approver = await loginAs(current(), 'approver.alpha');
    const rejected = await approver.post(`/api/renewal-requests/${universalId}/reject`);
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'rejected', decidedBy: { id: 'usr-approver-alpha' } });

    // Задача не ставится, операции по ключу у имитатора нет.
    expect(await requestState(db, universalId)).toMatchObject({ status: 'rejected', expires_on: '2027-05-20', job_state: null });
    expect(await simulatorOperation(universalKey)).toBeNull();
    expect(await simulatorStats('res-a-02')).toEqual({ resource_id: 'res-a-02', operation_count: 0 });
    expect(await simulatorStats('res-b-01')).toEqual({ resource_id: 'res-b-01', operation_count: 0 });

    const initiator = await loginAs(current(), 'initiator.alpha');
    const completed = await initiator.get(`/api/renewal-requests/${alphaId}`);
    expect(completed.status).toBe(200);
    expect(completed.body.request).toMatchObject({
      status: 'completed',
      lastErrorCode: null,
      providerOperationId: stored!.operation_id,
      idempotencyKey: alphaKey,
    });
    const history = completed.body.events as HistoryEvent[];
    expect(history.map((e) => e.kind)).toEqual(['created', 'approved', 'provider_error', 'completed']);
    expect(history[0]).toMatchObject({ actor: { id: 'usr-initiator-alpha' }, fromStatus: null, toStatus: 'pending' });
    expect(history[1]).toMatchObject({ actor: { id: 'usr-approver-alpha' }, fromStatus: 'pending', toStatus: 'processing' });
    expect(history[2]).toMatchObject({
      actor: null,
      fromStatus: 'processing',
      toStatus: 'processing',
      detail: 'http_503, попытка 1 из 3',
    });
    expect(history[3]).toMatchObject({
      actor: null,
      fromStatus: 'processing',
      toStatus: 'completed',
      detail: `operation_id ${stored!.operation_id}`,
    });

    const universal = await loginAs(current(), 'universal.alpha');
    const own = await universal.get(`/api/renewal-requests/${universalId}`);
    expect(own.status).toBe(200);
    expect(own.body.request).toMatchObject({ status: 'rejected', providerOperationId: null, lastErrorCode: null });
    const ownHistory = own.body.events as HistoryEvent[];
    expect(ownHistory.map((e) => e.kind)).toEqual(['created', 'rejected']);
    expect(ownHistory[0]).toMatchObject({ actor: { id: 'usr-universal-alpha' }, fromStatus: null, toStatus: 'pending' });
    expect(ownHistory[1]).toMatchObject({ actor: { id: 'usr-approver-alpha' }, fromStatus: 'pending', toStatus: 'rejected' });

    const resource = await universal.get('/api/resources/res-a-02');
    expect(resource.body.resource).toMatchObject({ expiresOn: '2027-05-20', activeRequest: null });
  });
});
