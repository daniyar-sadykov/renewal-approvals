// Клиент API. Сессия живёт в HttpOnly cookie, браузер отправляет её сам: на клиенте токена нет.

export type RequestStatus = 'pending' | 'rejected' | 'processing' | 'completed' | 'needs_attention';

export interface Person {
  id: string;
  displayName: string;
}

export interface Membership {
  workspaceId: string;
  workspaceName: string;
  canInitiate: boolean;
  canApprove: boolean;
}

export interface Me {
  user: { id: string; login: string; displayName: string };
  memberships: Membership[];
}

export interface Resource {
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

export interface RenewalRequest {
  id: string;
  workspaceId: string;
  resourceId: string;
  resourceName: string;
  status: RequestStatus;
  createdBy: Person;
  decidedBy: Person | null;
  oldExpiresOn: string;
  newExpiresOn: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  providerOperationId: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  canApprove: boolean;
  canReject: boolean;
  canRetry: boolean;
}

export interface RequestEvent {
  id: number;
  actor: Person | null;
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus | null;
  kind: string;
  detail: string | null;
  createdAt: string;
}

export interface RequestDetails {
  request: RenewalRequest;
  events: RequestEvent[];
}

export type RequestAction = 'approve' | 'reject' | 'retry';

// kind: 'network' это сервер недоступен, 'http' это ответ с кодом ошибки.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'http',
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const NETWORK_MESSAGE = 'Сервер недоступен. Проверьте, что API запущен, и повторите.';

let onUnauthorized: () => void = () => {};

// App подписывается сюда: 401 на любом запросе (кроме входа) возвращает на экран входа.
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

interface CallOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  // Для входа 401 значит «неверный пароль», а не «сессия кончилась».
  skipUnauthorizedHandler?: boolean;
}

async function call<T>(path: string, options: CallOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(NETWORK_MESSAGE, 'network', 0, 'network');
  }

  if (response.status === 204) return undefined as T;

  let data: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (response.ok) return data as T;

  const payload = (data ?? {}) as { error?: unknown; message?: unknown };
  const code = typeof payload.error === 'string' ? payload.error : 'unknown';
  const message = typeof payload.message === 'string' ? payload.message : '';

  if (response.status === 401 && !options.skipUnauthorizedHandler) onUnauthorized();

  // Прокси Vite отвечает 5xx без JSON, когда API не запущен.
  if (!message && (response.status >= 500 || response.status === 0)) {
    throw new ApiError(NETWORK_MESSAGE, 'network', response.status, 'network');
  }

  throw new ApiError(message || `Ошибка запроса (код ${response.status}).`, 'http', response.status, code);
}

export const api = {
  login: (login: string, password: string) =>
    call<Me>('/auth/login', { method: 'POST', body: { login, password }, skipUnauthorizedHandler: true }),
  logout: () => call<void>('/auth/logout', { method: 'POST', skipUnauthorizedHandler: true }),
  me: () => call<Me>('/auth/me', { skipUnauthorizedHandler: true }),
  resources: () => call<Resource[]>('/resources'),
  requests: () => call<RenewalRequest[]>('/renewal-requests'),
  request: (id: string) => call<RequestDetails>(`/renewal-requests/${encodeURIComponent(id)}`),
  createRequest: (resourceId: string) =>
    call<RenewalRequest>(`/resources/${encodeURIComponent(resourceId)}/renewal-requests`, { method: 'POST' }),
  act: (id: string, action: RequestAction) =>
    call<RenewalRequest>(`/renewal-requests/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
};

// Текст ошибки для человека. 409 дополняется пояснением, что экран обновлён.
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      const base = /[.!?]$/.test(error.message) ? error.message : `${error.message}.`;
      return `${base} Данные на экране обновлены.`;
    }
    return error.message;
  }
  return 'Что-то пошло не так. Повторите попытку.';
}
