import { Client } from 'pg';
import request from 'supertest';
import { DEMO_PASSWORD, DemoLogin } from './helpers/app';
import {
  apiPid,
  apiUrl,
  buildApi,
  freePort,
  killApiProcess,
  portListening,
  startApiProcess,
  withApiOutput,
} from './helpers/api-process';
import { connectTestDb, resetTestDatabase, testDatabaseUrl } from './helpers/db';
import { events, requestState, waitForStatus } from './helpers/flow';
import { SIMULATOR_URL, simulatorOperation, simulatorStats, startSimulator, stopSimulator } from './helpers/simulator';
import { waitFor } from './helpers/wait';

// Фича 21: восстановление после гибели процесса API. В отличие от 11 и 18 (app.close() внутри Jest)
// здесь собранный API работает отдельным процессом node и убивается SIGKILL (на Windows TerminateProcess):
// штатное завершение, хуки Nest и дорабатывание шага обработчика не выполняются.

// Сборка и два запуска процесса: секунды каждое, плюс пауза после 503 и аренда.
const HOOK_TIMEOUT_MS = 120000;
const TEST_TIMEOUT_MS = 120000;
const COMPLETE_TIMEOUT_MS = 30000;

type Agent = ReturnType<typeof request.agent>;

describe('21: восстановление после убийства процесса API', () => {
  let db: Client;
  let env: Record<string, string>;

  beforeAll(async () => {
    db = await connectTestDb();
    resetTestDatabase();
    await startSimulator();
    buildApi();
    env = {
      DATABASE_URL: testDatabaseUrl(),
      PORT: String(await freePort()),
      HOST: '127.0.0.1',
      PROVIDER_BASE_URL: SIMULATOR_URL,
      // Окно между 503 и следующим шагом, в которое процесс убивается.
      PROVIDER_RETRY_DELAY_MS: '4000',
      PROVIDER_TIMEOUT_MS: '2000',
      // Аренда короткая (минимум 2 * таймаут + 1000): во втором случае процесс может умереть посреди шага.
      WORKER_LEASE_MS: '5000',
      WORKER_POLL_MS: '100',
      WORKER_ENABLED: 'true',
    };
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await killApiProcess().catch(() => undefined);
    await stopSimulator();
    await db?.end();
  }, HOOK_TIMEOUT_MS);

  const login = async (who: DemoLogin): Promise<Agent> => {
    const agent = request.agent(apiUrl());
    const response = await agent.post('/api/auth/login').send({ login: who, password: DEMO_PASSWORD });
    if (response.status !== 200) throw new Error(`Вход под ${who}: ${response.status} ${JSON.stringify(response.body)}`);
    return agent;
  };

  const createAndApprove = async (resourceId: string) => {
    const initiator = await login('initiator.alpha');
    const created = await initiator.post(`/api/resources/${resourceId}/renewal-requests`);
    expect(created.status).toBe(201);
    const approver = await login('approver.alpha');
    const approved = await approver.post(`/api/renewal-requests/${created.body.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('processing');
    return { id: created.body.id as string, key: created.body.idempotencyKey as string };
  };

  // Убийство с проверкой, что это гибель от сигнала, а не выход самого процесса, и что порт освободился.
  const hardKill = async () => {
    const pid = apiPid();
    const port = Number(new URL(apiUrl()).port);
    const exit = await killApiProcess();
    expect(pid).toBeDefined();
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await portListening(port)).toBe(false);
  };

  it('убит после первой 503: новый процесс завершает заявку тем же ключом через GET, без второго POST', async () => {
    await startApiProcess(env);
    const created = await createAndApprove('res-a-01');

    const afterFirst = await withApiOutput(
      waitFor(
        () => requestState(db, created.id),
        (s) => s.post_attempts === 1 && s.last_error_code === 'http_503',
        { what: 'первая 503', timeoutMs: COMPLETE_TIMEOUT_MS },
      ),
    );
    expect(afterFirst).toMatchObject({
      status: 'processing',
      expires_on: '2027-03-01',
      idempotency_key: created.key,
      next_run_in_future: true,
      lease_until: null,
    });
    expect((await events(db, created.id)).map((e) => e.kind)).toEqual(['created', 'approved', 'provider_error']);
    const stored = await simulatorOperation(created.key);
    expect(stored).toMatchObject({ started_count: 1, resource_id: 'res-a-01' });

    await hardKill();

    // Процесс мёртв: заявка ждёт в processing, срок и ключ прежние, попытка одна.
    expect(await requestState(db, created.id)).toMatchObject({
      status: 'processing',
      expires_on: '2027-03-01',
      idempotency_key: created.key,
      post_attempts: 1,
    });

    await startApiProcess(env);
    const final = await withApiOutput(waitForStatus(db, created.id, 'completed', COMPLETE_TIMEOUT_MS));
    expect(final).toMatchObject({
      status: 'completed',
      idempotency_key: created.key,
      provider_operation_id: stored!.operation_id,
      expires_on: '2027-03-31',
      // После перезапуска был только GET: счётчик POST не вырос.
      post_attempts: 1,
      job_state: 'done',
    });
    expect((await events(db, created.id)).filter((e) => e.kind === 'completed')).toHaveLength(1);
    expect(await simulatorOperation(created.key)).toMatchObject({ started_count: 1, operation_id: stored!.operation_id });
    expect(await simulatorStats('res-a-01')).toEqual({ resource_id: 'res-a-01', operation_count: 1 });
    expect(await simulatorStats('res-a-02')).toEqual({ resource_id: 'res-a-02', operation_count: 0 });

    // История через API нового процесса.
    const approver = await login('approver.alpha');
    const card = await approver.get(`/api/renewal-requests/${created.id}`);
    expect(card.status).toBe(200);
    expect((card.body.events as { kind: string }[]).map((e) => e.kind)).toEqual([
      'created',
      'approved',
      'provider_error',
      'completed',
    ]);

    await killApiProcess();
  }, TEST_TIMEOUT_MS);

  it('убит сразу после одобрения: новый процесс доводит заявку до completed, операция одна', async () => {
    // Имитатор не перезапускается: операция по res-a-01 из прошлого случая остаётся, проверяется res-a-02.
    resetTestDatabase();
    await startApiProcess(env);
    const created = await createAndApprove('res-a-02');

    // Шаг обработчика мог не начаться, начаться или дойти до 503: проверки ниже верны в любом случае.
    await hardKill();
    // Первый POST по новому ключу имитатор всегда отвечает 503, поэтому до убийства завершиться заявка не могла.
    const dead = await requestState(db, created.id);
    expect(dead).toMatchObject({ status: 'processing', expires_on: '2027-05-20', idempotency_key: created.key });

    await startApiProcess(env);
    const final = await withApiOutput(waitForStatus(db, created.id, 'completed', COMPLETE_TIMEOUT_MS));
    expect(final).toMatchObject({
      status: 'completed',
      idempotency_key: created.key,
      expires_on: '2027-06-19',
      job_state: 'done',
    });
    const operation = await simulatorOperation(created.key);
    expect(operation).toMatchObject({ started_count: 1, resource_id: 'res-a-02' });
    expect(final.provider_operation_id).toBe(operation!.operation_id);
    expect(await simulatorStats('res-a-02')).toEqual({ resource_id: 'res-a-02', operation_count: 1 });
    expect((await events(db, created.id)).filter((e) => e.kind === 'completed')).toHaveLength(1);

    await killApiProcess();
  }, TEST_TIMEOUT_MS);
});
