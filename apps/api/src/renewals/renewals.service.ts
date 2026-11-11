import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { conflict, forbidden, notFound } from '../common/api-error';
import { AccessService } from '../auth/access.service';
import { AuthUser } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import {
  REQUEST_COLUMNS,
  REQUEST_FROM,
  RenewalRequestDto,
  RequestEventDto,
  RESOURCE_SELECT,
  ResourceDto,
  toEventDto,
  toRequestDto,
  toResourceDto,
} from './renewals.mappers';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ONE_ACTIVE_INDEX = 'renewal_requests_one_active_per_resource';

// Нарушение частичного уникального индекса «одна активная заявка на ресурс».
export function isActiveRequestViolation(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && e.constraint === ONE_ACTIVE_INDEX;
}

const activeRequestExists = () =>
  conflict('active_request_exists', 'У ресурса уже есть активная заявка на продление');

// Чтение ресурсов и заявок с изоляцией пространств и создание заявки.
// Пространство всегда берётся из самой сущности, доступ проверяется по memberships.
@Injectable()
export class RenewalsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
  ) {}

  async listResources(user: AuthUser): Promise<ResourceDto[]> {
    const { rows } = await this.db.query(`${RESOURCE_SELECT} where m.user_id is not null order by w.name, r.id`, [
      user.id,
    ]);
    return rows.map(toResourceDto);
  }

  async getResource(user: AuthUser, resourceId: string): Promise<{ resource: ResourceDto; requests: RenewalRequestDto[] }> {
    const { rows } = await this.db.query(`${RESOURCE_SELECT} where r.id = $2`, [user.id, resourceId]);
    if (rows.length === 0) throw notFound('Ресурс не найден');
    if (!rows[0].member_user_id) throw forbidden('Нет доступа к этому ресурсу');
    const requests = await this.db.query(
      `select ${REQUEST_COLUMNS} from ${REQUEST_FROM} where rr.resource_id = $2 order by rr.created_at desc, rr.id`,
      [user.id, resourceId],
    );
    return { resource: toResourceDto(rows[0]), requests: requests.rows.map((row) => toRequestDto(row, user.id)) };
  }

  async listRequests(user: AuthUser): Promise<RenewalRequestDto[]> {
    const { rows } = await this.db.query(
      `select ${REQUEST_COLUMNS} from ${REQUEST_FROM} where m.user_id is not null order by rr.created_at desc, rr.id`,
      [user.id],
    );
    return rows.map((row) => toRequestDto(row, user.id));
  }

  async getRequest(user: AuthUser, requestId: string): Promise<{ request: RenewalRequestDto; events: RequestEventDto[] }> {
    const request = await this.findRequest(user, requestId);
    const events = await this.db.query(
      `select e.id, e.actor_user_id, u.display_name as actor_name, e.from_status, e.to_status, e.kind, e.detail, e.created_at
         from request_events e left join users u on u.id = e.actor_user_id
        where e.request_id = $1
        order by e.id`,
      [request.id],
    );
    return { request, events: events.rows.map(toEventDto) };
  }

  // Заявка с проверкой доступа: нет такой (или id не uuid) 404, чужое пространство 403.
  async findRequest(user: AuthUser, requestId: string): Promise<RenewalRequestDto> {
    if (!UUID_PATTERN.test(requestId)) throw notFound('Заявка не найдена');
    const { rows } = await this.db.query(`select ${REQUEST_COLUMNS} from ${REQUEST_FROM} where rr.id = $2`, [
      user.id,
      requestId,
    ]);
    if (rows.length === 0) throw notFound('Заявка не найдена');
    if (!rows[0].member_user_id) throw forbidden('Нет доступа к этой заявке');
    return toRequestDto(rows[0], user.id);
  }

  // Создание заявки: снимок срока и стоимости под блокировкой строки ресурса.
  async createRequest(user: AuthUser, resourceId: string): Promise<RenewalRequestDto> {
    const id = randomUUID();
    try {
      await this.db.withTransaction(async (client) => {
        const resource = await client.query<{ workspace_id: string }>(
          'select workspace_id from resources where id = $1 for update',
          [resourceId],
        );
        if (resource.rows.length === 0) throw notFound('Ресурс не найден');

        const membership = await this.access.requireMembership(user.id, resource.rows[0].workspace_id, client);
        if (!membership.canInitiate) throw forbidden('Нет права создавать заявки в этом пространстве');

        const active = await client.query(
          `select 1 from renewal_requests
            where resource_id = $1 and status in ('pending', 'processing', 'needs_attention')`,
          [resourceId],
        );
        if (active.rows.length > 0) throw activeRequestExists();

        // Срок и сумма берутся из заблокированной строки ресурса, новый срок считает база.
        await client.query(
          `insert into renewal_requests
             (id, workspace_id, resource_id, status, created_by,
              old_expires_on, new_expires_on, amount_minor, currency, idempotency_key)
           select $1, r.workspace_id, r.id, 'pending', $3,
                  r.expires_on, r.expires_on + 30, r.price_minor, r.currency, $4
             from resources r where r.id = $2`,
          [id, resourceId, user.id, `renewal-${id}`],
        );
        await client.query(
          `insert into request_events (request_id, actor_user_id, from_status, to_status, kind)
           values ($1, $2, null, 'pending', 'created')`,
          [id, user.id],
        );
      });
    } catch (error) {
      if (isActiveRequestViolation(error)) throw activeRequestExists();
      throw error;
    }
    return this.findRequest(user, id);
  }
}
