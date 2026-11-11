import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { createTestApp, httpServer, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';
import { approve, createRequest, events, requestState, waitForStatus } from './helpers/flow';
import { ProviderStub } from './helpers/provider-stub';
import { waitFor } from './helpers/wait';

// Фича 13: три POST без результата дают needs_attention, ресурс занят до разрешения,
// согласующий повторяет с тем же ключом и телом. Провайдер здесь заглушка: настоящий имитатор
// подтверждает уже на втором запросе и до needs_attention не доводит.
describe('13: «Требует внимания» и повтор', () => {
  let app: INestApplication;
  let db: Client;
  const stub = new ProviderStub();
  let stubUrl: string;

  const env = (extra: Record<string, string> = {}) => ({
    PROVIDER_BASE_URL: stubUrl,
    PROVIDER_RETRY_DELAY_MS: '300',
    PROVIDER_TIMEOUT_MS: '1000',
    WORKER_POLL_MS: '50',
    PROVIDER_MAX_POST_ATTEMPTS: '3',
    ...extra,
  });

  beforeAll(async () => {
    db = await connectTestDb();
    stubUrl = await stub.start();
  });

  beforeEach(async () => {
    await app?.close();
    resetTestDatabase();
    stub.reset('down');
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await stub.stop();
  });

  const retry = async (login: Parameters<typeof loginAs>[1], id: string) =>
    (await loginAs(app, login)).post(`/api/renewal-requests/${id}/retry`);

  it('три POST без результата: needs_attention, ресурс занят, повтор согласующим доводит до completed', async () => {
    app = await createTestApp({ worker: true, env: env() });
    // Заявку создаёт универсальный: так проверяется и запрет повтора автором заявки.
    const created = await createRequest(app, 'res-a-01', 'universal.alpha');
    await approve(app, created.id);

    const stuck = await waitForStatus(db, created.id, 'needs_attention');
    expect(stuck).toMatchObject({ expires_on: '2027-03-01', post_attempts: 3, job_state: 'failed', last_error_code: 'attempts_exhausted' });

    // Ровно три POST, все с ключом заявки и одинаковым телом из снимка.
    expect(stub.posts).toHaveLength(3);
    expect(new Set(stub.posts.map((p) => p.key))).toEqual(new Set([created.idempotencyKey]));
    expect(new Set(stub.posts.map((p) => p.body)).size).toBe(1);
    expect(JSON.parse(stub.posts[0].body)).toEqual({ resource_id: 'res-a-01', period_months: 1, amount_minor: 128000, currency: 'RUB' });
    // GET после каждой неудачной попытки, в том числе последний перед needs_attention.
    expect(stub.gets).toEqual([created.idempotencyKey, created.idempotencyKey, created.idempotencyKey]);

    const kinds = (await events(db, created.id)).map((e) => e.kind);
    expect(kinds).toEqual(['created', 'approved', 'provider_error', 'provider_error', 'provider_error', 'needs_attention']);
    const last = (await events(db, created.id)).at(-1);
    expect(last).toMatchObject({ actor_user_id: null, from_status: 'processing', to_status: 'needs_attention', detail: 'attempts_exhausted' });

    // Через API: lastErrorCode заполнен, повтор доступен согласующему.
    const approver = await loginAs(app, 'approver.alpha');
    const view = await approver.get(`/api/renewal-requests/${created.id}`);
    expect(view.body.request).toMatchObject({ status: 'needs_attention', lastErrorCode: 'attempts_exhausted', canRetry: true });

    // Пока заявка требует внимания, новая заявка на ресурс недоступна.
    const initiator = await loginAs(app, 'initiator.alpha');
    const blocked = await initiator.post('/api/resources/res-a-01/renewal-requests');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('active_request_exists');

    // Повтор: без входа 401, автор заявки 403, инициатор без права 403, чужое пространство 403.
    expect((await request(httpServer(app)).post(`/api/renewal-requests/${created.id}/retry`)).status).toBe(401);
    expect((await retry('universal.alpha', created.id)).status).toBe(403);
    expect((await retry('initiator.alpha', created.id)).status).toBe(403);
    expect((await retry('initiator.beta', created.id)).status).toBe(403);
    expect(await requestState(db, created.id)).toMatchObject({ status: 'needs_attention', job_state: 'failed' });

    // Провайдер снова работает (ведёт себя как имитатор). Повтор согласующим.
    stub.mode = 'working';
    const retried = await approver.post(`/api/renewal-requests/${created.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      status: 'processing',
      idempotencyKey: created.idempotencyKey,
      lastErrorCode: null,
      decidedBy: { id: 'usr-approver-alpha' },
      canRetry: false,
    });

    const final = await waitForStatus(db, created.id, 'completed');
    expect(final).toMatchObject({ expires_on: '2027-03-31', job_state: 'done', idempotency_key: created.idempotencyKey });
    // После повтора: GET (404), POST (сохранение, 503), GET (200). Ключ и тело прежние, операция одна.
    expect(stub.posts).toHaveLength(4);
    expect(new Set(stub.posts.map((p) => p.key)).size).toBe(1);
    expect(new Set(stub.posts.map((p) => p.body)).size).toBe(1);
    expect(stub.operations.size).toBe(1);
    expect(final.provider_operation_id).toBe(stub.operations.get(created.idempotencyKey)!.operation.operation_id);

    const retryEvent = (await events(db, created.id)).find((e) => e.kind === 'retry_requested');
    expect(retryEvent).toMatchObject({ actor_user_id: 'usr-approver-alpha', from_status: 'needs_attention', to_status: 'processing' });
    expect((await events(db, created.id)).filter((e) => e.kind === 'completed')).toHaveLength(1);

    // Повтор для заявки не в needs_attention: 409.
    const again = await approver.post(`/api/renewal-requests/${created.id}/retry`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('invalid_transition');
  });

  it('повтор, когда провайдер уже выполнил операцию: первым шагом GET, нового POST нет', async () => {
    app = await createTestApp({ worker: true, env: env() });
    // Операция сохраняется с первого POST, но ответы теряются, а GET её не видит.
    stub.reset('lost');
    const created = await createRequest(app);
    await approve(app, created.id);
    await waitForStatus(db, created.id, 'needs_attention');
    expect(stub.posts).toHaveLength(3);

    // Чтение у провайдера починилось: GET отдаёт сохранённую операцию.
    stub.mode = 'working';
    const approver = await loginAs(app, 'approver.alpha');
    expect((await approver.post(`/api/renewal-requests/${created.id}/retry`)).status).toBe(200);

    const final = await waitForStatus(db, created.id, 'completed');
    expect(final).toMatchObject({ expires_on: '2027-03-31', post_attempts: 0, job_state: 'done' });
    expect(stub.posts).toHaveLength(3);
    expect(stub.operations.size).toBe(1);
  });

  it('повтор недоступен для заявки на согласовании и для несуществующей', async () => {
    app = await createTestApp({ worker: false, env: env() });
    const created = await createRequest(app);
    const approver = await loginAs(app, 'approver.alpha');
    const pending = await approver.post(`/api/renewal-requests/${created.id}/retry`);
    expect(pending.status).toBe(409);
    expect(pending.body.error).toBe('invalid_transition');
    expect((await approver.post('/api/renewal-requests/not-a-uuid/retry')).status).toBe(404);
    expect((await approver.post('/api/renewal-requests/00000000-0000-4000-8000-000000000000/retry')).status).toBe(404);
  });

  it.each([
    ['409', 'reject409', 'http_409'],
    ['400', 'reject400', 'http_400'],
  ] as const)('провайдер отвечает %s на POST: сразу needs_attention после одной попытки', async (_status, mode, code) => {
    app = await createTestApp({ worker: true, env: env() });
    stub.reset(mode);
    const created = await createRequest(app);
    await approve(app, created.id);

    const final = await waitForStatus(db, created.id, 'needs_attention');
    expect(final).toMatchObject({ expires_on: '2027-03-01', post_attempts: 1, last_error_code: code, job_state: 'failed' });
    expect(stub.posts).toHaveLength(1);
    const last = (await events(db, created.id)).at(-1);
    expect(last).toMatchObject({ kind: 'needs_attention', detail: code });
  });

  it.each([['resource'], ['amount']] as const)(
    'ответ провайдера с чужим полем (%s): needs_attention provider_mismatch, срок не сдвинут',
    async (field) => {
      app = await createTestApp({ worker: true, env: env() });
      stub.reset('mismatch');
      stub.mismatch = field;
      const created = await createRequest(app);
      await approve(app, created.id);

      const final = await waitForStatus(db, created.id, 'needs_attention');
      expect(final).toMatchObject({
        expires_on: '2027-03-01',
        last_error_code: 'provider_mismatch',
        provider_operation_id: null,
        job_state: 'failed',
      });
      expect((await events(db, created.id)).filter((e) => e.kind === 'completed')).toHaveLength(0);
    },
  );

  it('таймаут провайдера: результат неизвестен, попытка учтена, повтор с тем же ключом доводит до конца', async () => {
    app = await createTestApp({ worker: true, env: env({ PROVIDER_TIMEOUT_MS: '300' }) });
    stub.reset('hang');
    const created = await createRequest(app);
    await approve(app, created.id);

    const afterTimeout = await waitFor(
      () => requestState(db, created.id),
      (s) => s.last_error_code === 'timeout',
      { what: 'таймаут первой попытки' },
    );
    expect(afterTimeout).toMatchObject({ status: 'processing', post_attempts: 1, expires_on: '2027-03-01' });
    const errors = (await events(db, created.id)).filter((e) => e.kind === 'provider_error');
    expect(errors[0]).toMatchObject({ detail: 'timeout, попытка 1 из 3', from_status: 'processing', to_status: 'processing' });

    // Провайдер ожил: заявка завершается, операция одна.
    stub.mode = 'working';
    const final = await waitForStatus(db, created.id, 'completed');
    expect(final.expires_on).toBe('2027-03-31');
    expect(stub.operations.size).toBe(1);
    expect(new Set(stub.posts.map((p) => p.key)).size).toBe(1);
  });

  it('провайдер недоступен совсем (обрыв соединения): попытки считаются, затем needs_attention', async () => {
    // Порт без сервера: соединение отвергается сразу.
    const closed = new ProviderStub();
    const deadUrl = await closed.start();
    await closed.stop();
    app = await createTestApp({ worker: true, env: { ...env(), PROVIDER_BASE_URL: deadUrl } });
    const created = await createRequest(app);
    await approve(app, created.id);

    // GET без ответа не стопорит задачу: следующий POST с тем же ключом идёт и учитывается,
    // поэтому при полном отказе заявка доходит до needs_attention, а не висит в processing.
    const final = await waitForStatus(db, created.id, 'needs_attention', 20000);
    expect(final).toMatchObject({ post_attempts: 3, last_error_code: 'attempts_exhausted', expires_on: '2027-03-01' });
    const details = (await events(db, created.id)).filter((e) => e.kind === 'provider_error').map((e) => e.detail);
    expect(details).toEqual(['network_error, попытка 1 из 3', 'network_error, попытка 2 из 3', 'network_error, попытка 3 из 3']);
  });
});
