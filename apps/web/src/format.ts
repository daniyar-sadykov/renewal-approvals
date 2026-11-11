import type { Membership, RequestStatus } from './api';

export const statusLabel: Record<RequestStatus, string> = {
  pending: 'На согласовании',
  rejected: 'Отклонена',
  processing: 'Выполняется',
  completed: 'Завершена',
  needs_attention: 'Требует внимания',
};

export function statusText(status: string | null): string {
  if (!status) return 'Нет';
  return statusLabel[status as RequestStatus] ?? status;
}

// Подписи видов событий. Имена событий обработчика ещё не зафиксированы, поэтому здесь
// несколько вероятных вариантов; неизвестный вид показывается как есть.
const eventKindLabel: Record<string, string> = {
  created: 'Заявка создана',
  approved: 'Одобрена',
  rejected: 'Отклонена',
  retry: 'Повтор отправки',
  retried: 'Повтор отправки',
  retry_requested: 'Повтор отправки',
  completed: 'Провайдер подтвердил продление',
  needs_attention: 'Нет подтверждения провайдера',
  provider_attempt: 'Попытка отправки провайдеру',
  provider_post: 'Попытка отправки провайдеру',
  provider_request: 'Попытка отправки провайдеру',
  provider_sent: 'Отправлено провайдеру',
  sent: 'Отправлено провайдеру',
  provider_error: 'Ошибка провайдера',
  provider_unavailable: 'Провайдер недоступен',
  provider_check: 'Проверка результата у провайдера',
  provider_confirmed: 'Провайдер подтвердил продление',
};

export function eventKindText(kind: string): string {
  return eventKindLabel[kind] ?? kind;
}

// Дата YYYY-MM-DD в виде ДД.ММ.ГГГГ. Без new Date(), чтобы часовой пояс не сдвинул день.
export function formatDate(value: string | null | undefined): string {
  if (!value) return 'Нет';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

// Момент времени ISO 8601 в местном времени пользователя.
export function formatMoment(value: string | null | undefined): string {
  if (!value) return 'Нет';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const NBSP = ' ';

// Копейки в рубли: 128000 даёт «1 280,00 ₽». Целочисленная арифметика, без плавающей точки.
export function formatMoney(minor: number, currency = 'RUB'): string {
  const negative = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const rubles = Math.floor(abs / 100).toString();
  const kopecks = (abs % 100).toString().padStart(2, '0');
  const grouped = rubles.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const sign = currency === 'RUB' ? '₽' : currency;
  return `${negative ? '-' : ''}${grouped},${kopecks}${NBSP}${sign}`;
}

export function rolesText(membership: Membership): string {
  const roles: string[] = [];
  if (membership.canInitiate) roles.push('инициатор');
  if (membership.canApprove) roles.push('согласующий');
  return roles.length ? roles.join(', ') : 'просмотр';
}
