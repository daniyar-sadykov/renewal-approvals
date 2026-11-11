import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { createTestApp, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';
import { approve, createRequest, requestState, waitForStatus } from './helpers/flow';
import { SIMULATOR_URL, simulatorOperation, simulatorStats, startSimulator, stopSimulator } from './helpers/simulator';

// Фича 14: отклонённая заявка провайдеру не уходит, срок не меняет, ресурс после неё свободен.
// Настоящий имитатор, обработчик включён.
describe('14: отклонённая заявка', () => {
  let app: INestApplication;
  let db: Client;

  beforeAll(async () => {
    db = await connectTestDb();
    await startSimulator();
    resetTestDatabase();
    app = await createTestApp({
      worker: true,
      env: { PROVIDER_BASE_URL: SIMULATOR_URL, PROVIDER_RETRY_DELAY_MS: '300', PROVIDER_TIMEOUT_MS: '2000', WORKER_POLL_MS: '50' },
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await stopSimulator();
  });

  it('отклонение: нет задачи, нет операции у имитатора, срок прежний, новая заявка создаётся', async () => {
    const rejected = await createRequest(app, 'res-a-01');
    const approver = await loginAs(app, 'approver.alpha');
    const response = await approver.post(`/api/renewal-requests/${rejected.id}/reject`);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('rejected');

    // Контрольная заявка на другом ресурсе проходит весь путь через обработчик: значит, он сделал
    // много циклов, пока отклонённая заявка лежала рядом.
    const canary = await createRequest(app, 'res-a-02');
    await approve(app, canary.id);
    expect(await waitForStatus(db, canary.id, 'completed')).toMatchObject({ expires_on: '2027-06-19' });

    expect(await simulatorStats('res-a-01')).toEqual({ resource_id: 'res-a-01', operation_count: 0 });
    expect(await simulatorOperation(rejected.idempotencyKey)).toBeNull();
    expect(await requestState(db, rejected.id)).toMatchObject({ status: 'rejected', expires_on: '2027-03-01', post_attempts: null, job_state: null });
    expect((await db.query('select count(*)::int as n from provider_jobs where request_id = $1', [rejected.id])).rows[0].n).toBe(0);

    const initiator = await loginAs(app, 'initiator.alpha');
    const next = await initiator.post('/api/resources/res-a-01/renewal-requests');
    expect(next.status).toBe(201);
    expect(next.body).toMatchObject({ status: 'pending', oldExpiresOn: '2027-03-01', newExpiresOn: '2027-03-31' });

    // Повтор отклонённой заявки недоступен.
    const retry = await approver.post(`/api/renewal-requests/${rejected.id}/retry`);
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe('invalid_transition');
  });
});
