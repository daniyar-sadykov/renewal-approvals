import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { createTestApp, httpServer, loginAs } from './helpers/app';
import { connectTestDb, resetTestDatabase } from './helpers/db';

type Agent = Awaited<ReturnType<typeof loginAs>>;

// Фича 03: чтение ресурсов и заявок только своих пространств. Чужое по ID: 403, нет такого: 404.
describe('03: просмотр с изоляцией пространств', () => {
  let app: INestApplication;
  let db: Client;
  let alpha: Agent;
  let beta: Agent;
  let approver: Agent;
  let universal: Agent;
  let alphaRequestId: string;
  let alphaOldRequestId: string;
  let betaRequestId: string;

  async function insertRequest(opts: {
    workspace: string;
    resource: string;
    createdBy: string;
    status: string;
    createdAt: string;
    decidedBy?: string;
  }): Promise<string> {
    const id = randomUUID();
    await db.query(
      `insert into renewal_requests
         (id, workspace_id, resource_id, status, created_by, decided_by,
          old_expires_on, new_expires_on, amount_minor, currency, idempotency_key, created_at)
       select $1, r.workspace_id, r.id, $3, $4, $5, r.expires_on, r.expires_on + 30, r.price_minor, r.currency,
              $8, $6::timestamptz
         from resources r where r.id = $2 and r.workspace_id = $7`,
      [id, opts.resource, opts.status, opts.createdBy, opts.decidedBy ?? null, opts.createdAt, opts.workspace, `renewal-${id}`],
    );
    await db.query(
      `insert into request_events (request_id, actor_user_id, from_status, to_status, kind, created_at)
       values ($1, $2, null, 'pending', 'created', $3::timestamptz)`,
      [id, opts.createdBy, opts.createdAt],
    );
    return id;
  }

  beforeAll(async () => {
    resetTestDatabase();
    db = await connectTestDb();
    alphaOldRequestId = await insertRequest({
      workspace: 'ws-alpha',
      resource: 'res-a-01',
      createdBy: 'usr-initiator-alpha',
      decidedBy: 'usr-approver-alpha',
      status: 'rejected',
      createdAt: '2026-11-01T10:00:00Z',
    });
    await db.query(
      `insert into request_events (request_id, actor_user_id, from_status, to_status, kind, detail, created_at)
       values ($1, 'usr-approver-alpha', 'pending', 'rejected', 'rejected', null, '2026-11-01T11:00:00Z'),
              ($1, null, null, null, 'note', 'системное событие', '2026-11-01T12:00:00Z')`,
      [alphaOldRequestId],
    );
    alphaRequestId = await insertRequest({
      workspace: 'ws-alpha',
      resource: 'res-a-01',
      createdBy: 'usr-initiator-alpha',
      status: 'pending',
      createdAt: '2026-11-02T10:00:00Z',
    });
    betaRequestId = await insertRequest({
      workspace: 'ws-beta',
      resource: 'res-b-01',
      createdBy: 'usr-initiator-beta',
      status: 'pending',
      createdAt: '2026-11-03T10:00:00Z',
    });

    app = await createTestApp();
    alpha = await loginAs(app, 'initiator.alpha');
    beta = await loginAs(app, 'initiator.beta');
    approver = await loginAs(app, 'approver.alpha');
    universal = await loginAs(app, 'universal.alpha');
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  describe('списки', () => {
    it('Alpha видит только ресурсы Alpha с активной заявкой и флагом создания', async () => {
      const response = await alpha.get('/api/resources');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        {
          id: 'res-a-01',
          workspaceId: 'ws-alpha',
          workspaceName: 'Alpha',
          name: 'Хранилище A',
          expiresOn: '2027-03-01',
          priceMinor: 128000,
          currency: 'RUB',
          activeRequest: { id: alphaRequestId, status: 'pending' },
          canCreateRequest: false,
        },
        {
          id: 'res-a-02',
          workspaceId: 'ws-alpha',
          workspaceName: 'Alpha',
          name: 'Сервис B',
          expiresOn: '2027-05-20',
          priceMinor: 250000,
          currency: 'RUB',
          activeRequest: null,
          canCreateRequest: true,
        },
      ]);
    });

    it('согласующий без права инициатора не может создавать заявки', async () => {
      const response = await approver.get('/api/resources');
      expect(response.body.map((r: { canCreateRequest: boolean }) => r.canCreateRequest)).toEqual([false, false]);
    });

    it('Beta видит только свой ресурс', async () => {
      const response = await beta.get('/api/resources');
      expect(response.status).toBe(200);
      expect(response.body.map((r: { id: string }) => r.id)).toEqual(['res-b-01']);
    });

    it('списки заявок не содержат чужого, новые сверху', async () => {
      const alphaList = await alpha.get('/api/renewal-requests');
      expect(alphaList.status).toBe(200);
      expect(alphaList.body.map((r: { id: string }) => r.id)).toEqual([alphaRequestId, alphaOldRequestId]);

      const betaList = await beta.get('/api/renewal-requests');
      expect(betaList.body.map((r: { id: string }) => r.id)).toEqual([betaRequestId]);
    });

    it('подставленные workspaceId и userId в query и теле ничего не меняют', async () => {
      const resources = await beta
        .get('/api/resources?workspaceId=ws-alpha&userId=usr-initiator-alpha&workspace_id=ws-alpha')
        .send({ workspaceId: 'ws-alpha', userId: 'usr-initiator-alpha' });
      expect(resources.body.map((r: { id: string }) => r.id)).toEqual(['res-b-01']);

      const requests = await beta
        .get('/api/renewal-requests?workspaceId=ws-alpha&userId=usr-initiator-alpha')
        .send({ workspaceId: 'ws-alpha' });
      expect(requests.body.map((r: { id: string }) => r.id)).toEqual([betaRequestId]);

      const resource = await beta.get('/api/resources/res-a-01?workspaceId=ws-alpha&userId=usr-initiator-alpha');
      expect(resource.status).toBe(403);
      const req = await beta.get(`/api/renewal-requests/${alphaRequestId}?workspaceId=ws-alpha`);
      expect(req.status).toBe(403);
    });
  });

  describe('по ID', () => {
    it('ресурс с историей заявок, новые сверху', async () => {
      const response = await alpha.get('/api/resources/res-a-01');
      expect(response.status).toBe(200);
      expect(response.body.resource).toMatchObject({ id: 'res-a-01', activeRequest: { id: alphaRequestId, status: 'pending' } });
      expect(response.body.requests.map((r: { id: string }) => r.id)).toEqual([alphaRequestId, alphaOldRequestId]);
    });

    it('заявка в полном формате и события по порядку', async () => {
      const response = await approver.get(`/api/renewal-requests/${alphaOldRequestId}`);
      expect(response.status).toBe(200);
      expect(response.body.request).toEqual({
        id: alphaOldRequestId,
        workspaceId: 'ws-alpha',
        resourceId: 'res-a-01',
        resourceName: 'Хранилище A',
        status: 'rejected',
        createdBy: { id: 'usr-initiator-alpha', displayName: 'Инициатор Alpha' },
        decidedBy: { id: 'usr-approver-alpha', displayName: 'Согласующий Alpha' },
        oldExpiresOn: '2027-03-01',
        newExpiresOn: '2027-03-31',
        amountMinor: 128000,
        currency: 'RUB',
        idempotencyKey: `renewal-${alphaOldRequestId}`,
        providerOperationId: null,
        lastErrorCode: null,
        createdAt: '2026-11-01T10:00:00.000Z',
        decidedAt: null,
        completedAt: null,
        canApprove: false,
        canReject: false,
        canRetry: false,
      });
      expect(response.body.events).toEqual([
        {
          id: expect.any(Number),
          actor: { id: 'usr-initiator-alpha', displayName: 'Инициатор Alpha' },
          fromStatus: null,
          toStatus: 'pending',
          kind: 'created',
          detail: null,
          createdAt: '2026-11-01T10:00:00.000Z',
        },
        {
          id: expect.any(Number),
          actor: { id: 'usr-approver-alpha', displayName: 'Согласующий Alpha' },
          fromStatus: 'pending',
          toStatus: 'rejected',
          kind: 'rejected',
          detail: null,
          createdAt: '2026-11-01T11:00:00.000Z',
        },
        {
          id: expect.any(Number),
          actor: null,
          fromStatus: null,
          toStatus: null,
          kind: 'note',
          detail: 'системное событие',
          createdAt: '2026-11-01T12:00:00.000Z',
        },
      ]);
    });

    it('флаги действий зависят от прав и авторства', async () => {
      const flags = async (agent: Agent) => {
        const { body } = await agent.get(`/api/renewal-requests/${alphaRequestId}`);
        return { canApprove: body.request.canApprove, canReject: body.request.canReject, canRetry: body.request.canRetry };
      };
      expect(await flags(approver)).toEqual({ canApprove: true, canReject: true, canRetry: false });
      expect(await flags(universal)).toEqual({ canApprove: true, canReject: true, canRetry: false });
      expect(await flags(alpha)).toEqual({ canApprove: false, canReject: false, canRetry: false });

      // Своя заявка: универсальный не может её решать.
      await db.query(`update renewal_requests set created_by = 'usr-universal-alpha' where id = $1`, [alphaRequestId]);
      expect(await flags(universal)).toEqual({ canApprove: false, canReject: false, canRetry: false });

      await db.query(`update renewal_requests set status = 'needs_attention' where id = $1`, [alphaRequestId]);
      expect(await flags(approver)).toEqual({ canApprove: false, canReject: false, canRetry: true });
      expect(await flags(universal)).toEqual({ canApprove: false, canReject: false, canRetry: false });

      await db.query(`update renewal_requests set status = 'pending', created_by = 'usr-initiator-alpha' where id = $1`, [
        alphaRequestId,
      ]);
    });

    it('Beta получает 403 на ресурс и заявку Alpha', async () => {
      for (const path of ['/api/resources/res-a-01', `/api/renewal-requests/${alphaRequestId}`]) {
        const response = await beta.get(path);
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: 'forbidden', message: expect.any(String) });
      }
    });

    it('Alpha получает 403 на ресурс и заявку Beta', async () => {
      for (const agent of [alpha, approver, universal]) {
        expect((await agent.get('/api/resources/res-b-01')).status).toBe(403);
        expect((await agent.get(`/api/renewal-requests/${betaRequestId}`)).status).toBe(403);
      }
    });

    it('несуществующие ID и невалидный uuid: 404', async () => {
      const cases = ['/api/resources/res-x-99', `/api/renewal-requests/${randomUUID()}`, '/api/renewal-requests/not-a-uuid'];
      for (const path of cases) {
        const response = await alpha.get(path);
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'not_found', message: expect.any(String) });
      }
    });

    it('без сессии: 401 даже на существующий ID', async () => {
      const anonymous = request(httpServer(app));
      expect((await anonymous.get('/api/resources/res-a-01')).status).toBe(401);
      expect((await anonymous.get(`/api/renewal-requests/${alphaRequestId}`)).status).toBe(401);
    });
  });
});
