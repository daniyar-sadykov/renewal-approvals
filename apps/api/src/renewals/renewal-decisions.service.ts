import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { conflict, forbidden, notFound } from '../common/api-error';
import { AccessService } from '../auth/access.service';
import { AuthUser } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { RenewalRequestDto, RequestStatus } from './renewals.mappers';
import { RenewalsService, UUID_PATTERN } from './renewals.service';

export const PROVIDER_JOBS_REQUEST_UNIQUE = 'provider_jobs_request_id_key';

// Строка заявки, заблокированная for update в транзакции решения.
export interface LockedRequest {
  id: string;
  workspaceId: string;
  resourceId: string;
  status: RequestStatus;
  createdBy: string;
  oldExpiresOn: string;
  amountMinor: number;
  currency: string;
}

export const invalidTransition = (message = 'Заявка уже не в том состоянии, чтобы выполнить это действие') =>
  conflict('invalid_transition', message);

export const resourceChanged = () =>
  conflict(
    'resource_changed',
    'Срок или стоимость ресурса изменились после создания заявки. Отклоните её и создайте новую',
  );

// Вторая задача отправки на ту же заявку: тот же смысл, что и повторное одобрение.
export function isProviderJobDuplicate(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && e.constraint === PROVIDER_JOBS_REQUEST_UNIQUE;
}

// Решения согласующего: одобрение, отклонение и повтор отправки после needs_attention.
// Ответ (итоговая заявка) читается тем же client до commit, а не отдельным запросом после него.
// Порядок блокировок везде: сначала строка заявки, потом строка ресурса.
// Создание заявки берёт только строку ресурса и чужие заявки не блокирует, поэтому взаимной блокировки нет.
@Injectable()
export class RenewalDecisionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly renewals: RenewalsService,
  ) {}

  // Общая часть любого решения: заявка под блокировкой, членство, право согласующего, не своя заявка.
  // Проверки по порядку: 404, 403 (пространство, право, своя заявка). Состояние (409) проверяет вызывающий.
  async lockForDecision(client: PoolClient, user: AuthUser, requestId: string): Promise<LockedRequest> {
    if (!UUID_PATTERN.test(requestId)) throw notFound('Заявка не найдена');
    const { rows } = await client.query(
      `select id, workspace_id, resource_id, status, created_by, old_expires_on, amount_minor, currency
         from renewal_requests where id = $1 for update`,
      [requestId],
    );
    if (rows.length === 0) throw notFound('Заявка не найдена');
    const row = rows[0];

    const membership = await this.access.findMembership(user.id, row.workspace_id, client);
    if (!membership) throw forbidden('Нет доступа к этой заявке');
    if (!membership.canApprove) throw forbidden('Нет права согласовывать заявки в этом пространстве');
    if (row.created_by === user.id) throw forbidden('Свою заявку согласовать или отклонить нельзя');

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      resourceId: row.resource_id,
      status: row.status,
      createdBy: row.created_by,
      oldExpiresOn: row.old_expires_on,
      amountMinor: row.amount_minor,
      currency: row.currency,
    };
  }

  // Условная смена статуса: второй рубеж помимо блокировки строки.
  async transition(
    client: PoolClient,
    request: LockedRequest,
    from: RequestStatus,
    to: RequestStatus,
    actorUserId: string | null,
    kind: string,
    setDecision: boolean,
  ): Promise<void> {
    const updated = await client.query(
      setDecision
        ? `update renewal_requests set status = $3, decided_by = $4, decided_at = now() where id = $1 and status = $2`
        : `update renewal_requests set status = $3 where id = $1 and status = $2`,
      setDecision ? [request.id, from, to, actorUserId] : [request.id, from, to],
    );
    if (updated.rowCount !== 1) throw invalidTransition();
    await client.query(
      `insert into request_events (request_id, actor_user_id, from_status, to_status, kind)
       values ($1, $2, $3, $4, $5)`,
      [request.id, actorUserId, from, to, kind],
    );
  }

  async approve(user: AuthUser, requestId: string): Promise<RenewalRequestDto> {
    try {
      return await this.db.withTransaction(async (client) => {
        const request = await this.lockForDecision(client, user, requestId);
        if (request.status !== 'pending') throw invalidTransition('Одобрить можно только заявку на согласовании');

        // Сверка ресурса со снимком под блокировкой его строки.
        const resource = await client.query(
          'select expires_on, price_minor, currency from resources where id = $1 for update',
          [request.resourceId],
        );
        const current = resource.rows[0];
        if (
          !current ||
          current.expires_on !== request.oldExpiresOn ||
          current.price_minor !== request.amountMinor ||
          current.currency !== request.currency
        ) {
          throw resourceChanged();
        }

        await this.transition(client, request, 'pending', 'processing', user.id, 'approved', true);
        await client.query(
          `insert into provider_jobs (request_id, post_attempts, state, next_run_at)
           values ($1, 0, 'queued', now())`,
          [request.id],
        );
        return this.renewals.findRequest(user, requestId, client);
      });
    } catch (error) {
      if (isProviderJobDuplicate(error)) throw invalidTransition('Задача отправки для этой заявки уже есть');
      throw error;
    }
  }

  async reject(user: AuthUser, requestId: string): Promise<RenewalRequestDto> {
    return this.db.withTransaction(async (client) => {
      const request = await this.lockForDecision(client, user, requestId);
      if (request.status !== 'pending') throw invalidTransition('Отклонить можно только заявку на согласовании');
      await this.transition(client, request, 'pending', 'rejected', user.id, 'rejected', true);
      return this.renewals.findRequest(user, requestId, client);
    });
  }

  // Повтор после needs_attention: needs_attention -> processing, задача снова в очереди.
  // Ключ и тело прежние (они из снимка заявки), поэтому у провайдера не появится вторая операция.
  // Счётчик POST обнуляется, но первым шагом обработчик спросит GET по ключу (verify_before_post):
  // операция могла выполниться у провайдера, тогда заявка завершится без нового POST.
  async retry(user: AuthUser, requestId: string): Promise<RenewalRequestDto> {
    return this.db.withTransaction(async (client) => {
      const request = await this.lockForDecision(client, user, requestId);
      if (request.status !== 'needs_attention') {
        throw invalidTransition('Повторить можно только заявку в состоянии «Требует внимания»');
      }
      // decided_by не трогаем: решение об одобрении принято раньше, повтор это не новое решение.
      await this.transition(client, request, 'needs_attention', 'processing', user.id, 'retry_requested', false);
      await client.query('update renewal_requests set last_error_code = null where id = $1', [request.id]);
      // Задача после needs_attention в состоянии failed. Upsert на случай, если её нет вовсе.
      await client.query(
        `insert into provider_jobs (request_id, post_attempts, state, next_run_at, lease_until, verify_before_post)
         values ($1, 0, 'queued', now(), null, true)
         on conflict (request_id) do update
           set post_attempts = 0, state = 'queued', next_run_at = now(), lease_until = null,
               verify_before_post = true, updated_at = now()`,
        [request.id],
      );
      return this.renewals.findRequest(user, requestId, client);
    });
  }
}
