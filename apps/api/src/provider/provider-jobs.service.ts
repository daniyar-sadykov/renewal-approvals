import { Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { APP_CONFIG } from '../config.module';
import { AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';
import { RequestStatus } from '../renewals/renewals.mappers';

// Задача, взятая обработчиком в аренду.
export interface ClaimedJob {
  id: number;
  requestId: string;
  postAttempts: number;
  verifyBeforePost: boolean;
  // lease_until в текстовом виде с микросекундами: метка аренды. Обновления задачи идут
  // только при совпадении метки, поэтому обработчик, у которого аренду уже перехватили, ничего не испортит.
  leaseToken: string;
}

// Неизменяемый снимок заявки: из него строятся ключ и тело запроса к провайдеру.
export interface JobRequest {
  id: string;
  status: RequestStatus;
  resourceId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}

export type FinalizeResult = 'completed' | 'already_final' | 'resource_changed';

// Все изменения состояния задачи и заявки со стороны обработчика. Каждый метод это одна короткая
// транзакция, сетевых вызовов внутри нет. Порядок блокировок как везде: заявка, потом ресурс, потом задача.
@Injectable()
export class ProviderJobsService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // Берёт одну готовую задачу в аренду. Просроченная аренда (процесс умер посреди шага) не мешает.
  async claimNext(leaseMs: number): Promise<ClaimedJob | null> {
    const { rows } = await this.db.query(
      `update provider_jobs j
          set lease_until = now() + $1::int * interval '1 millisecond', updated_at = now()
         from (select id from provider_jobs
                where state = 'queued' and next_run_at <= now()
                  and (lease_until is null or lease_until < now())
                order by next_run_at, id
                for update skip locked
                limit 1) next
        where j.id = next.id
      returning j.id, j.request_id, j.post_attempts, j.verify_before_post, j.lease_until::text as lease_token`,
      [leaseMs],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: Number(row.id),
      requestId: row.request_id,
      postAttempts: row.post_attempts,
      verifyBeforePost: row.verify_before_post,
      leaseToken: row.lease_token,
    };
  }

  async loadRequest(requestId: string): Promise<JobRequest | null> {
    const { rows } = await this.db.query(
      `select id, status, resource_id, amount_minor, currency, idempotency_key from renewal_requests where id = $1`,
      [requestId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      status: row.status,
      resourceId: row.resource_id,
      amountMinor: row.amount_minor,
      currency: row.currency,
      idempotencyKey: row.idempotency_key,
    };
  }

  // Учитывает попытку POST до отправки: если процесс упадёт после отправки, факт попытки не потеряется.
  // null: аренду перехватили, отправлять нельзя.
  async countPostAttempt(job: ClaimedJob): Promise<number | null> {
    const { rows } = await this.db.query(
      `update provider_jobs
          set post_attempts = post_attempts + 1, verify_before_post = false, updated_at = now()
        where id = $1 and state = 'queued' and lease_until = $2::timestamptz
      returning post_attempts`,
      [job.id, job.leaseToken],
    );
    return rows.length === 0 ? null : rows[0].post_attempts;
  }

  // Откладывает задачу на PROVIDER_RETRY_DELAY_MS и снимает аренду. С ошибкой пишет событие
  // provider_error (статус не меняется) и код в last_error_code. false: аренду перехватили.
  async scheduleRetry(job: ClaimedJob, error: { code: string; detail: string } | null): Promise<boolean> {
    return this.db.withTransaction(async (client) => {
      const request = await lockRequest(client, job.requestId);
      const released = await client.query(
        `update provider_jobs
            set next_run_at = now() + $3::int * interval '1 millisecond', lease_until = null, updated_at = now()
          where id = $1 and state = 'queued' and lease_until = $2::timestamptz`,
        [job.id, job.leaseToken, this.config.providerRetryDelayMs],
      );
      if (released.rowCount !== 1) return false;
      if (error && request?.status === 'processing') {
        await client.query(`update renewal_requests set last_error_code = $2 where id = $1 and status = 'processing'`, [
          job.requestId,
          error.code,
        ]);
        await insertSystemEvent(client, job.requestId, 'processing', 'processing', 'provider_error', error.detail);
      }
      return true;
    });
  }

  // Задача по заявке, которая уже не processing: закрыть, к провайдеру не ходить.
  async closeStale(job: ClaimedJob, status: RequestStatus | null): Promise<void> {
    await this.db.query(
      `update provider_jobs set state = $3, lease_until = null, updated_at = now()
        where id = $1 and state = 'queued' and lease_until = $2::timestamptz`,
      [job.id, job.leaseToken, status === 'completed' ? 'done' : 'failed'],
    );
  }

  // Подтверждение провайдера, статус заявки и новый срок одной транзакцией. Идемпотентна:
  // заявка не в processing (уже завершена) значит ничего не делать, только закрыть задачу.
  // Аренду не проверяет намеренно: подтверждённая провайдером операция верна, кто бы её ни принёс.
  async finalize(requestId: string, operationId: string): Promise<FinalizeResult> {
    return this.db.withTransaction(async (client) => {
      const request = await lockRequest(client, requestId);
      if (!request || request.status !== 'processing') {
        await client.query(
          `update provider_jobs
              set state = case when $2 = 'completed' then 'done' else state end, lease_until = null, updated_at = now()
            where request_id = $1 and state = 'queued'`,
          [requestId, request?.status ?? null],
        );
        return 'already_final';
      }

      const resource = await client.query('select expires_on from resources where id = $1 for update', [
        request.resourceId,
      ]);
      // Срок ресурса разошёлся со снимком уже после одобрения. Операция у провайдера выполнена,
      // но сдвинуть срок «ещё на 30 дней от чего-то другого» нельзя: заявка требует внимания человека.
      // operation_id сохраняется, чтобы было видно, что провайдер операцию выполнил.
      if (resource.rows[0]?.expires_on !== request.oldExpiresOn) {
        await markNeedsAttentionInTx(client, requestId, 'resource_changed', { operationId });
        return 'resource_changed';
      }

      await client.query(
        `update renewal_requests
            set status = 'completed', provider_operation_id = $2, completed_at = now(), last_error_code = null
          where id = $1 and status = 'processing'`,
        [requestId, operationId],
      );
      // Условие по старому сроку: второй рубеж против двойного сдвига помимо блокировки строк.
      const moved = await client.query(
        `update resources set expires_on = $3 where id = $1 and expires_on = $2`,
        [request.resourceId, request.oldExpiresOn, request.newExpiresOn],
      );
      if (moved.rowCount !== 1) throw new Error('Срок ресурса не сдвинут при финализации, транзакция откачена');
      await client.query(
        `update provider_jobs set state = 'done', lease_until = null, updated_at = now() where request_id = $1`,
        [requestId],
      );
      await insertSystemEvent(client, requestId, 'processing', 'completed', 'completed', `operation_id ${operationId}`);
      return 'completed';
    });
  }

  // processing -> needs_attention. С меткой аренды: только если аренда ещё наша.
  async markNeedsAttention(requestId: string, code: string, leaseToken: string | null): Promise<boolean> {
    return this.db.withTransaction(async (client) => markNeedsAttentionInTx(client, requestId, code, { leaseToken }));
  }
}

interface LockedJobRequest {
  status: RequestStatus;
  resourceId: string;
  oldExpiresOn: string;
  newExpiresOn: string;
}

async function lockRequest(client: PoolClient, requestId: string): Promise<LockedJobRequest | null> {
  const { rows } = await client.query(
    `select status, resource_id, old_expires_on, new_expires_on from renewal_requests where id = $1 for update`,
    [requestId],
  );
  if (rows.length === 0) return null;
  return {
    status: rows[0].status,
    resourceId: rows[0].resource_id,
    oldExpiresOn: rows[0].old_expires_on,
    newExpiresOn: rows[0].new_expires_on,
  };
}

async function markNeedsAttentionInTx(
  client: PoolClient,
  requestId: string,
  code: string,
  options: { leaseToken?: string | null; operationId?: string },
): Promise<boolean> {
  const request = await lockRequest(client, requestId);
  if (!request || request.status !== 'processing') return false;
  // С меткой аренды задача должна быть нашей; без метки (финализация) закрывается в любом состоянии.
  const fenced = options.leaseToken != null;
  const failed = await client.query(
    `update provider_jobs set state = 'failed', lease_until = null, updated_at = now()
      where request_id = $1 and ($2::timestamptz is null or (state = 'queued' and lease_until = $2::timestamptz))`,
    [requestId, options.leaseToken ?? null],
  );
  if (fenced && failed.rowCount !== 1) return false;
  await client.query(
    `update renewal_requests
        set status = 'needs_attention', last_error_code = $2, provider_operation_id = coalesce($3, provider_operation_id)
      where id = $1 and status = 'processing'`,
    [requestId, code, options.operationId ?? null],
  );
  await insertSystemEvent(client, requestId, 'processing', 'needs_attention', 'needs_attention', code);
  return true;
}

// Событие системы (обработчика): actor_user_id пустой. detail только короткий код и номер попытки.
async function insertSystemEvent(
  client: PoolClient,
  requestId: string,
  from: RequestStatus,
  to: RequestStatus,
  kind: string,
  detail: string,
): Promise<void> {
  await client.query(
    `insert into request_events (request_id, actor_user_id, from_status, to_status, kind, detail)
     values ($1, null, $2, $3, $4, $5)`,
    [requestId, from, to, kind, detail],
  );
}
