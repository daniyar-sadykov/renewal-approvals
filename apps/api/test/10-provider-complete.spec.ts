import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { createTestApp, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';
import { approve, createRequest, events, waitForStatus } from './helpers/flow';
import { SIMULATOR_URL, simulatorOperation, simulatorStats, startSimulator, stopSimulator } from './helpers/simulator';

const WORKER_ENV = {
  PROVIDER_BASE_URL: SIMULATOR_URL,
  PROVIDER_RETRY_DELAY_MS: '300',
  PROVIDER_TIMEOUT_MS: '2000',
  WORKER_POLL_MS: '50',
};

// Фича 10: отправка провайдеру и завершение. Настоящий имитатор: первый POST даёт 503 и сохраняет
// операцию, обработчик после паузы спрашивает GET по тому же ключу, получает операцию и завершает заявку.
describe('10: отправка провайдеру и завершение', () => {
  let app: INestApplication;
  let db: Client;

  beforeAll(async () => {
    db = await connectTestDb();
    await startSimulator();
    resetTestDatabase();
    app = await createTestApp({ worker: true, env: WORKER_ENV });
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await stopSimulator();
  });

  it('503, затем подтверждение: completed, срок 2027-03-31, одна операция у имитатора', async () => {
    const created = await createRequest(app);
    expect(created.idempotencyKey).toBe(`renewal-${created.id}`);
    await approve(app, created.id);

    const final = await waitForStatus(db, created.id, 'completed');
    expect(final).toMatchObject({
      expires_on: '2027-03-31',
      post_attempts: 1,
      job_state: 'done',
      last_error_code: null,
      lease_until: null,
      idempotency_key: created.idempotencyKey,
    });

    const operation = await simulatorOperation(created.idempotencyKey);
    expect(operation).toMatchObject({
      status: 'completed',
      started_count: 1,
      resource_id: 'res-a-01',
      period_months: 1,
      amount_minor: 128000,
      currency: 'RUB',
    });
    expect(final.provider_operation_id).toBe(operation!.operation_id);
    expect(await simulatorStats('res-a-01')).toEqual({ resource_id: 'res-a-01', operation_count: 1 });
    expect(await simulatorStats('res-a-02')).toEqual({ resource_id: 'res-a-02', operation_count: 0 });

    // Через API: заявка и история по порядку, последние два шага от системы.
    const initiator = await loginAs(app, 'initiator.alpha');
    const response = await initiator.get(`/api/renewal-requests/${created.id}`);
    expect(response.status).toBe(200);
    expect(response.body.request).toMatchObject({
      status: 'completed',
      providerOperationId: operation!.operation_id,
      lastErrorCode: null,
      canRetry: false,
    });
    expect(Number.isNaN(Date.parse(response.body.request.completedAt))).toBe(false);
    const history = response.body.events as { kind: string; actor: unknown; fromStatus: string; toStatus: string; detail: string }[];
    expect(history.map((e) => e.kind)).toEqual(['created', 'approved', 'provider_error', 'completed']);
    expect(history[2]).toMatchObject({ actor: null, fromStatus: 'processing', toStatus: 'processing', detail: 'http_503, попытка 1 из 3' });
    expect(history[3]).toMatchObject({
      actor: null,
      fromStatus: 'processing',
      toStatus: 'completed',
      detail: `operation_id ${operation!.operation_id}`,
    });

    // В истории только короткие коды: ни тела ответа провайдера, ни его полей.
    const raw = await events(db, created.id);
    for (const e of raw) expect(e.detail ?? '').not.toMatch(/response_lost|started_count|\{/);

    // Ресурс свободен, новая заявка берёт снимок от нового срока.
    const next = await initiator.post('/api/resources/res-a-01/renewal-requests');
    expect(next.status).toBe(201);
    expect(next.body).toMatchObject({ oldExpiresOn: '2027-03-31', newExpiresOn: '2027-04-30', amountMinor: 128000 });
  });
});
