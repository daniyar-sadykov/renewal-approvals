import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { renewalPayload } from '../src/provider/provider.client';
import { createTestApp } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';
import { approve, createRequest, events, requestState, waitForStatus } from './helpers/flow';
import { SIMULATOR_URL, simulatorOperation, simulatorStats, startSimulator, stopSimulator } from './helpers/simulator';
import { waitFor } from './helpers/wait';

const BASE_ENV = {
  PROVIDER_BASE_URL: SIMULATOR_URL,
  PROVIDER_TIMEOUT_MS: '2000',
  WORKER_POLL_MS: '50',
};

// Фича 11: всё состояние задачи в базе, ключ в заявке. Перезапуск между 503 и следующим запросом
// не теряет операцию и не создаёт вторую. Имитатор внутри теста не перезапускается.
describe('11: восстановление после перезапуска', () => {
  let app: INestApplication | undefined;
  let db: Client;

  beforeAll(async () => {
    db = await connectTestDb();
  });

  // Свежий имитатор на каждый случай: статистика по ресурсу начинается с нуля.
  beforeEach(async () => {
    await app?.close();
    app = undefined;
    await stopSimulator();
    await startSimulator();
    resetTestDatabase();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await stopSimulator();
  });

  // POST от имени «упавшего» процесса: имитатор сохраняет операцию и отвечает 503.
  const postAsDeadProcess = async (key: string) => {
    const response = await fetch(`${SIMULATOR_URL}/renewals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(renewalPayload({ resourceId: 'res-a-01', amountMinor: 128000, currency: 'RUB' })),
    });
    expect(response.status).toBe(503);
    await response.text();
  };

  it('остановка после 503 и новый запуск: тот же ключ, сохранённый результат, срок сдвинут один раз', async () => {
    // Длинная пауза после 503: окно, в которое приложение останавливается.
    app = await createTestApp({ worker: true, env: { ...BASE_ENV, PROVIDER_RETRY_DELAY_MS: '1500' } });
    const created = await createRequest(app);
    await approve(app, created.id);

    // Первая отправка: 503, попытка учтена, следующий запуск в будущем.
    const afterFirst = await waitFor(
      () => requestState(db, created.id),
      (s) => s.post_attempts === 1 && s.last_error_code === 'http_503',
      { what: 'первая 503' },
    );
    expect(afterFirst).toMatchObject({ status: 'processing', next_run_in_future: true, lease_until: null, expires_on: '2027-03-01' });

    await app.close();
    app = undefined;

    // Приложение остановлено: заявка ждёт, срок прежний, у имитатора уже есть операция с этим ключом.
    expect(await requestState(db, created.id)).toMatchObject({ status: 'processing', expires_on: '2027-03-01', post_attempts: 1 });
    const stored = await simulatorOperation(created.idempotencyKey);
    expect(stored).toMatchObject({ started_count: 1 });

    app = await createTestApp({ worker: true, env: { ...BASE_ENV, PROVIDER_RETRY_DELAY_MS: '1500' } });
    const final = await waitForStatus(db, created.id, 'completed');
    expect(final).toMatchObject({
      expires_on: '2027-03-31',
      post_attempts: 1,
      job_state: 'done',
      idempotency_key: created.idempotencyKey,
      provider_operation_id: stored!.operation_id,
    });
    expect(await simulatorOperation(created.idempotencyKey)).toMatchObject({ started_count: 1, operation_id: stored!.operation_id });
    expect(await simulatorStats('res-a-01')).toMatchObject({ operation_count: 1 });
    expect((await events(db, created.id)).filter((e) => e.kind === 'completed')).toHaveLength(1);
  });

  it('процесс умер, держа аренду: просроченная аренда не мешает взять задачу снова', async () => {
    app = await createTestApp({ worker: false });
    const created = await createRequest(app);
    await approve(app, created.id);
    await app.close();
    app = undefined;

    // Состояние «упавшего» процесса: попытка учтена, POST ушёл, аренда осталась и уже истекла.
    await postAsDeadProcess(created.idempotencyKey);
    await db.query(
      `update provider_jobs set post_attempts = 1, next_run_at = now(), lease_until = now() - interval '1 second'
        where request_id = $1`,
      [created.id],
    );

    app = await createTestApp({ worker: true, env: { ...BASE_ENV, PROVIDER_RETRY_DELAY_MS: '300' } });
    const final = await waitForStatus(db, created.id, 'completed');
    // GET по ключу дал сохранённую операцию: нового POST не было, счётчик не вырос.
    expect(final).toMatchObject({ expires_on: '2027-03-31', post_attempts: 1, job_state: 'done' });
    expect(await simulatorOperation(created.idempotencyKey)).toMatchObject({ started_count: 1 });
    expect(await simulatorStats('res-a-01')).toMatchObject({ operation_count: 1 });
  });

  it('непросроченная аренда мешает взять задачу до истечения', async () => {
    app = await createTestApp({ worker: false });
    const created = await createRequest(app);
    await approve(app, created.id);
    await app.close();
    app = undefined;

    await postAsDeadProcess(created.idempotencyKey);
    const { rows } = await db.query(
      `update provider_jobs set post_attempts = 1, next_run_at = now(), lease_until = now() + interval '2 seconds'
        where request_id = $1 returning lease_until::text as lease_until`,
      [created.id],
    );
    const lease = rows[0].lease_until as string;

    app = await createTestApp({ worker: true, env: { ...BASE_ENV, PROVIDER_RETRY_DELAY_MS: '300' } });
    const final = await waitForStatus(db, created.id, 'completed', 20000);
    expect(final).toMatchObject({ expires_on: '2027-03-31', post_attempts: 1, job_state: 'done' });

    // Завершение случилось только после истечения чужой аренды, хотя обработчик опрашивал каждые 50 мс.
    const timing = await db.query(`select completed_at >= $2::timestamptz as after_lease from renewal_requests where id = $1`, [
      created.id,
      lease,
    ]);
    expect(timing.rows[0].after_lease).toBe(true);
    expect(await simulatorStats('res-a-01')).toMatchObject({ operation_count: 1 });
  });

  it('попытка учтена, но отправки не было: GET даёт 404, POST с тем же ключом, попытка не теряется', async () => {
    app = await createTestApp({ worker: false });
    const created = await createRequest(app);
    await approve(app, created.id);
    await app.close();
    app = undefined;

    // Процесс упал между post_attempts += 1 и отправкой: у имитатора операции нет.
    await db.query(`update provider_jobs set post_attempts = 1, next_run_at = now() where request_id = $1`, [created.id]);
    expect(await simulatorOperation(created.idempotencyKey)).toBeNull();

    app = await createTestApp({ worker: true, env: { ...BASE_ENV, PROVIDER_RETRY_DELAY_MS: '300' } });
    const final = await waitForStatus(db, created.id, 'completed');
    // Вторая попытка: 503 и сохранение, затем GET. Первая попытка осталась в счётчике.
    expect(final).toMatchObject({ expires_on: '2027-03-31', post_attempts: 2, job_state: 'done' });
    expect(await simulatorOperation(created.idempotencyKey)).toMatchObject({ started_count: 1 });
    expect(await simulatorStats('res-a-01')).toMatchObject({ operation_count: 1 });
    const errors = (await events(db, created.id)).filter((e) => e.kind === 'provider_error');
    expect(errors.map((e) => e.detail)).toEqual(['http_503, попытка 2 из 3']);
  });
});
