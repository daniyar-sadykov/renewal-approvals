import { INestApplication } from '@nestjs/common';
import net from 'node:net';
import { Client } from 'pg';
import { createTestApp, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';
import { waitForStatus } from './helpers/flow';
import {
  SIMULATOR_HOST,
  SIMULATOR_PORT,
  SIMULATOR_URL,
  simulatorOperation,
  simulatorStats,
  startSimulator,
  stopSimulator,
} from './helpers/simulator';
import { waitFor } from './helpers/wait';

// Обработчик включён и опрашивает часто: если бы задача появилась, он взял бы её за 50 мс и пошёл
// к имитатору. Поэтому пустой имитатор после 409 значит, что отправки не было, а не что обработчика нет.
const WORKER_ENV = {
  PROVIDER_BASE_URL: SIMULATOR_URL,
  PROVIDER_RETRY_DELAY_MS: '300',
  PROVIDER_TIMEOUT_MS: '2000',
  WORKER_POLL_MS: '50',
};

// Окно наблюдения после 409: двадцать с лишним циклов обработчика.
const QUIET_WINDOW_MS = 1500;

// Условие должно держаться всё окно, а не выполниться один раз.
async function holdsFor<T>(probe: () => Promise<T>, ok: (value: T) => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (!ok(value)) throw new Error(`Нарушено: ${what}. Значение: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Фича 07: при одобрении срок и стоимость ресурса сверяются со снимком в заявке.
// Расхождение: 409 resource_changed, заявка pending, задачи нет, провайдер не вызван.
describe('07: сверка со снимком при одобрении', () => {
  let app: INestApplication;
  let db: Client;

  beforeAll(async () => {
    db = await connectTestDb();
  });

  // Свежий имитатор на каждый случай: положительный контроль оставляет операцию по res-a-01.
  beforeEach(async () => {
    await app?.close();
    await stopSimulator();
    await startSimulator();
    resetTestDatabase();
    app = await createTestApp({ worker: true, env: WORKER_ENV });
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await stopSimulator();
  });

  const createRequest = async () => {
    const agent = await loginAs(app, 'initiator.alpha');
    const response = await agent.post('/api/resources/res-a-01/renewal-requests');
    expect(response.status).toBe(201);
    return response.body as { id: string; idempotencyKey: string };
  };

  const counts = async (id: string) => {
    const { rows } = await db.query(
      `select (select status from renewal_requests where id = $1) as status,
              (select count(*)::int from provider_jobs) as jobs,
              (select count(*)::int from request_events where request_id = $1 and kind = 'approved') as approved_events`,
      [id],
    );
    return rows[0];
  };

  it.each([
    ['срок', `update resources set expires_on = date '2027-04-15' where id = 'res-a-01'`, { oldExpiresOn: '2027-04-15', newExpiresOn: '2027-05-15', amountMinor: 128000 }],
    ['стоимость', `update resources set price_minor = 140000 where id = 'res-a-01'`, { oldExpiresOn: '2027-03-01', newExpiresOn: '2027-03-31', amountMinor: 140000 }],
  ])('изменился %s: 409 resource_changed, провайдер не вызван, потом отклонение и новая заявка', async (_what, change, snapshot) => {
    const created = await createRequest();
    await db.query(change);

    const approver = await loginAs(app, 'approver.alpha');
    const response = await approver.post(`/api/renewal-requests/${created.id}/approve`);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'resource_changed', message: expect.any(String) });
    expect(await counts(created.id)).toEqual({ status: 'pending', jobs: 0, approved_events: 0 });

    // Несколько циклов работающего обработчика: задача так и не появилась, заявка pending.
    await holdsFor(
      () => counts(created.id),
      (c) => c.status === 'pending' && c.jobs === 0 && c.approved_events === 0,
      QUIET_WINDOW_MS,
      'после 409 нет задачи и одобрения',
    );

    // Провайдер не вызван: у имитатора нет операций ни по ресурсу, ни по ключу.
    expect(await simulatorStats('res-a-01')).toEqual({ resource_id: 'res-a-01', operation_count: 0 });
    expect(await simulatorOperation(created.idempotencyKey)).toBeNull();

    // Повторная попытка даёт тот же ответ, а не одобрение.
    expect((await approver.post(`/api/renewal-requests/${created.id}/approve`)).body.error).toBe('resource_changed');

    // Устаревшую заявку можно отклонить и создать новую с новым снимком.
    const rejected = await approver.post(`/api/renewal-requests/${created.id}/reject`);
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');

    const initiator = await loginAs(app, 'initiator.alpha');
    const next = await initiator.post('/api/resources/res-a-01/renewal-requests');
    expect(next.status).toBe(201);
    expect(next.body).toMatchObject(snapshot);

    // Новая заявка совпадает с ресурсом и одобряется.
    const approved = await approver.post(`/api/renewal-requests/${next.body.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('processing');

    // Положительный контроль при тех же настройках: обычное одобрение доходит до имитатора.
    // Значит, обработчик в этом файле работает, и пустой имитатор после 409 что-то доказывает.
    await waitFor(() => simulatorStats('res-a-01'), (s) => s.operation_count === 1, { what: 'операция у имитатора' });
    expect(await simulatorOperation(next.body.idempotencyKey)).toMatchObject({ started_count: 1 });
    // Ключ устаревшей заявки так и не ушёл к провайдеру.
    expect(await simulatorOperation(created.idempotencyKey)).toBeNull();
  });

  it('ресурс без изменений: одобрение проходит и доходит до провайдера', async () => {
    const created = await createRequest();
    const approver = await loginAs(app, 'approver.alpha');
    expect((await approver.post(`/api/renewal-requests/${created.id}/approve`)).status).toBe(200);

    await waitForStatus(db, created.id, 'completed');
    expect(await simulatorStats('res-a-01')).toEqual({ resource_id: 'res-a-01', operation_count: 1 });
    expect(await simulatorOperation(created.idempotencyKey)).toMatchObject({ started_count: 1 });
  });
});

// Помощник имитатора: занятый чужим процессом порт даёт понятную ошибку, а не тихий сбой.
describe('07: помощник имитатора', () => {
  it('порт 8091 занят: startSimulator падает с понятным текстом', async () => {
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(SIMULATOR_PORT, SIMULATOR_HOST, resolve));
    try {
      await expect(startSimulator()).rejects.toThrow(/уже занят/);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});
