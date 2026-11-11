// Строки базы в ответы API (camelCase) и вычисляемые флаги для интерфейса.

export const ACTIVE_STATUSES = ['pending', 'processing', 'needs_attention'] as const;

export type RequestStatus = 'pending' | 'rejected' | 'processing' | 'completed' | 'needs_attention';

export interface UserRef {
  id: string;
  displayName: string;
}

export interface RenewalRequestDto {
  id: string;
  workspaceId: string;
  resourceId: string;
  resourceName: string;
  status: RequestStatus;
  createdBy: UserRef;
  decidedBy: UserRef | null;
  oldExpiresOn: string;
  newExpiresOn: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  providerOperationId: string | null;
  lastErrorCode: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  completedAt: Date | null;
  canApprove: boolean;
  canReject: boolean;
  canRetry: boolean;
}

export interface ResourceDto {
  id: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  expiresOn: string;
  priceMinor: number;
  currency: string;
  activeRequest: { id: string; status: RequestStatus } | null;
  canCreateRequest: boolean;
}

export interface RequestEventDto {
  id: number;
  actor: UserRef | null;
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus | null;
  kind: string;
  detail: string | null;
  createdAt: Date;
}

// Колонки заявки для REQUEST_FROM. Права берутся из m (членство текущего пользователя, $1).
export const REQUEST_COLUMNS = `
  rr.id, rr.workspace_id, rr.resource_id, r.name as resource_name, rr.status,
  rr.created_by, cu.display_name as created_by_name,
  rr.decided_by, du.display_name as decided_by_name,
  rr.old_expires_on, rr.new_expires_on, rr.amount_minor, rr.currency,
  rr.idempotency_key, rr.provider_operation_id, rr.last_error_code,
  rr.created_at, rr.decided_at, rr.completed_at,
  m.user_id as member_user_id, coalesce(m.can_approve, false) as member_can_approve`;

export const REQUEST_FROM = `
  renewal_requests rr
  join resources r on r.id = rr.resource_id
  join users cu on cu.id = rr.created_by
  left join users du on du.id = rr.decided_by
  left join memberships m on m.workspace_id = rr.workspace_id and m.user_id = $1`;

// Строка результата pg: типы колонок задаёт SQL выше.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export function toRequestDto(row: Row, currentUserId: string): RenewalRequestDto {
  // Решать может согласующий пространства, и только чужую заявку.
  const canDecide = row.member_can_approve === true && row.created_by !== currentUserId;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    resourceId: row.resource_id,
    resourceName: row.resource_name,
    status: row.status,
    createdBy: { id: row.created_by, displayName: row.created_by_name },
    decidedBy: row.decided_by ? { id: row.decided_by, displayName: row.decided_by_name } : null,
    oldExpiresOn: row.old_expires_on,
    newExpiresOn: row.new_expires_on,
    amountMinor: row.amount_minor,
    currency: row.currency,
    idempotencyKey: row.idempotency_key,
    providerOperationId: row.provider_operation_id,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    completedAt: row.completed_at,
    canApprove: canDecide && row.status === 'pending',
    canReject: canDecide && row.status === 'pending',
    canRetry: canDecide && row.status === 'needs_attention',
  };
}

// Колонки ресурса. m: членство текущего пользователя ($1), a: активная заявка.
export const RESOURCE_SELECT = `
  select r.id, r.workspace_id, w.name as workspace_name, r.name, r.expires_on, r.price_minor, r.currency,
         a.id as active_id, a.status as active_status,
         m.user_id as member_user_id, coalesce(m.can_initiate, false) as member_can_initiate
    from resources r
    join workspaces w on w.id = r.workspace_id
    left join memberships m on m.workspace_id = r.workspace_id and m.user_id = $1
    left join renewal_requests a
      on a.resource_id = r.id and a.status in ('pending', 'processing', 'needs_attention')`;

export function toResourceDto(row: Row): ResourceDto {
  const activeRequest = row.active_id ? { id: row.active_id, status: row.active_status } : null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    name: row.name,
    expiresOn: row.expires_on,
    priceMinor: row.price_minor,
    currency: row.currency,
    activeRequest,
    canCreateRequest: row.member_can_initiate === true && activeRequest === null,
  };
}

export function toEventDto(row: Row): RequestEventDto {
  return {
    id: Number(row.id),
    actor: row.actor_user_id ? { id: row.actor_user_id, displayName: row.actor_name } : null,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    kind: row.kind,
    detail: row.detail,
    createdAt: row.created_at,
  };
}
