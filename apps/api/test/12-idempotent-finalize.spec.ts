import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { ProviderJobsService } from '../src/provider/provider-jobs.service';
import { createTestApp } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';
import { approve, createRequest, events, requestState, waitForStatus } from './helpers/flow';
import { SIMULATOR_URL, simulatorOperation, simulatorStats, startSimulator, stopSimulator } from './helpers/simulator';
import { waitFor } from './helpers/wait';

const WORKER_ENV = {
  PROVIDER_BASE_URL: SIMULATOR_URL,
  PROVIDER_RETRY_DELAY_MS: '300',
  PROVIDER_TIMEOUT_MS: '2000',
  WORKER_POLL_MS: '50',
};

// Фича 12: финализация идемпотентна (условные update), повторная обработка срок второй раз не сдвигает.
describe('12: повторная обработка не сдвигает срок', () => {
  let app: INestApplication;
  let db: Client;

  beforeAll(async () => {
    db = await connectTestDb();
    await startSimulator();
  });

  beforeEach(async () => {
    await app?.close();
    resetTestDatabase();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await stopSimulator();
  });

  const completedEvents = async (id: string) => (await events(db, id)).filter((e) => e.kind === 'completed').length;

  it('повторная финализация и повторная обработка той же задачи: срок 2027-03-31, одно событие, одна операция', async () => {
    app = await createTestApp({ worker: true, env: WORKER_ENV });
    const created = await createRequest(app);
    await approve(app, created.id);
    const first = await waitForStatus(db, created.id, 'completed');
    expect(first.expires_on).toBe('2027-03-31');
    const operationsBefore = (await simulatorStats('res-a-01')).operation_count;

    // Финализация ещё дважды, в том числе с другим operation_id: заявка уже не processing, ничего не меняется.
    const jobs = app.get(ProviderJobsService);
    expect(await jobs.finalize(created.id, first.provider_operation_id!)).toBe('already_final');
    expect(await jobs.finalize(created.id, 'other-operation')).toBe('already_final');
    expect(await requestState(db, created.id)).toMatchObject({
      status: 'completed',
      expires_on: '2027-03-31',
      provider_operation_id: first.provider_operation_id,
    });

    // Задача снова в очереди прямым SQL: обработчик берёт её, видит завершённую заявку и только закрывает.
    await db.query(
      `update provider_jobs set state = 'queued', next_run_at = now(), lease_until = null where request_id = $1`,
      [created.id],
    );
    await waitFor(() => requestState(db, created.id), (s) => s.job_state === 'done', { what: 'задача снова закрыта' });

    expect(await requestState(db, created.id)).toMatchObject({ status: 'completed', expires_on: '2027-03-31', post_attempts: 1 });
    expect(await completedEvents(created.id)).toBe(1);
    expect((await simulatorStats('res-a-01')).operation_count).toBe(operationsBefore);
    expect(await simulatorOperation(created.idempotencyKey)).toMatchObject({ started_count: 1 });
  });

  it('заявку силой вернули в processing после завершения: срок не сдвигается второй раз, needs_attention resource_changed', async () => {
    app = await createTestApp({ worker: true, env: WORKER_ENV });
    const created = await createRequest(app);
    await approve(app, created.id);
    await waitForStatus(db, created.id, 'completed');

    // Худший случай повторной обработки: и заявка, и задача снова как до подтверждения.
    await db.query(`update renewal_requests set status = 'processing' where id = $1`, [created.id]);
    await db.query(
      `update provider_jobs set state = 'queued', next_run_at = now(), lease_until = null where request_id = $1`,
      [created.id],
    );

    // Обработчик получает ту же операцию по GET, но срок ресурса уже не равен снимку: второго сдвига нет.
    const final = await waitForStatus(db, created.id, 'needs_attention');
    expect(final).toMatchObject({ expires_on: '2027-03-31', last_error_code: 'resource_changed', job_state: 'failed' });
    expect(await completedEvents(created.id)).toBe(1);
    const last = (await events(db, created.id)).at(-1);
    expect(last).toMatchObject({ kind: 'needs_attention', actor_user_id: null, detail: 'resource_changed' });
  });

  it('параллельные финализации одной заявки: ровно одна сдвигает срок', async () => {
    app = await createTestApp({ worker: false });
    const created = await createRequest(app);
    await approve(app, created.id);

    const jobs = app.get(ProviderJobsService);
    const results = await Promise.all(Array.from({ length: 6 }, () => jobs.finalize(created.id, 'op-parallel')));
    expect(results.filter((r) => r === 'completed')).toHaveLength(1);
    expect(results.filter((r) => r === 'already_final')).toHaveLength(5);
    expect(await requestState(db, created.id)).toMatchObject({
      status: 'completed',
      expires_on: '2027-03-31',
      provider_operation_id: 'op-parallel',
      job_state: 'done',
    });
    expect(await completedEvents(created.id)).toBe(1);
  });

  it('срок ресурса изменили после одобрения: подтверждение не сдвигает его, заявка требует внимания', async () => {
    app = await createTestApp({ worker: false });
    const created = await createRequest(app);
    await approve(app, created.id);
    await db.query(`update resources set expires_on = date '2027-04-15' where id = 'res-a-01'`);

    const jobs = app.get(ProviderJobsService);
    expect(await jobs.finalize(created.id, 'op-drift')).toBe('resource_changed');
    // Операция провайдера сохранена (она выполнена), срок не тронут, задача закрыта как failed.
    expect(await requestState(db, created.id)).toMatchObject({
      status: 'needs_attention',
      expires_on: '2027-04-15',
      last_error_code: 'resource_changed',
      provider_operation_id: 'op-drift',
      job_state: 'failed',
    });
    expect(await completedEvents(created.id)).toBe(0);
  });
});
