import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { DemoLogin, loginAs } from './app';
import { waitFor } from './wait';

// Общие шаги тестов обработчика: заявка, одобрение, чтение состояния из базы.

export interface CreatedRequest {
  id: string;
  idempotencyKey: string;
}

export async function createRequest(
  app: INestApplication,
  resourceId = 'res-a-01',
  login: DemoLogin = 'initiator.alpha',
): Promise<CreatedRequest> {
  const agent = await loginAs(app, login);
  const response = await agent.post(`/api/resources/${resourceId}/renewal-requests`);
  if (response.status !== 201) throw new Error(`Создание заявки: ${response.status} ${JSON.stringify(response.body)}`);
  return { id: response.body.id, idempotencyKey: response.body.idempotencyKey };
}

export async function approve(app: INestApplication, id: string): Promise<void> {
  const approver = await loginAs(app, 'approver.alpha');
  const response = await approver.post(`/api/renewal-requests/${id}/approve`);
  if (response.status !== 200) throw new Error(`Одобрение: ${response.status} ${JSON.stringify(response.body)}`);
}

export interface RequestState {
  status: string;
  idempotency_key: string;
  provider_operation_id: string | null;
  last_error_code: string | null;
  expires_on: string;
  post_attempts: number | null;
  job_state: string | null;
  next_run_in_future: boolean | null;
  lease_until: string | null;
}

// Заявка, срок её ресурса и задача одним запросом.
export async function requestState(db: Client, id: string): Promise<RequestState> {
  const { rows } = await db.query(
    `select rr.status, rr.idempotency_key, rr.provider_operation_id, rr.last_error_code, r.expires_on,
            j.post_attempts, j.state as job_state, j.next_run_at > now() as next_run_in_future,
            j.lease_until::text as lease_until
       from renewal_requests rr
       join resources r on r.id = rr.resource_id
       left join provider_jobs j on j.request_id = rr.id
      where rr.id = $1`,
    [id],
  );
  if (rows.length === 0) throw new Error(`Заявки ${id} нет`);
  return rows[0];
}

export function waitForStatus(db: Client, id: string, status: string, timeoutMs = 15000): Promise<RequestState> {
  return waitFor(() => requestState(db, id), (s) => s.status === status, { timeoutMs, what: `статус ${status}` });
}

export interface EventRow {
  kind: string;
  actor_user_id: string | null;
  from_status: string | null;
  to_status: string | null;
  detail: string | null;
}

export async function events(db: Client, id: string): Promise<EventRow[]> {
  const { rows } = await db.query(
    'select kind, actor_user_id, from_status, to_status, detail from request_events where request_id = $1 order by id',
    [id],
  );
  return rows;
}
