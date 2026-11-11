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

// Подписи видов событий по контракту (docs/api.md). Неизвестный вид показывается как есть.
const eventKindLabel: Record<string, string> = {
  created: 'Заявка создана',
  approved: 'Одобрена, отправка провайдеру поставлена в очередь',
  rejected: 'Отклонена',
  provider_error: 'Провайдер не подтвердил попытку',
  completed: 'Провайдер подтвердил, срок продлён',
  needs_attention: 'Остановлено: требует внимания',
  retry_requested: 'Повтор отправки запрошен',
};

export function eventKindText(kind: string): string {
  return eventKindLabel[kind] ?? kind;
}

// Короткие коды проблем с провайдером (lastErrorCode заявки и detail событий) человеческим текстом.
const problemCodeLabel: Record<string, string> = {
  timeout: 'Провайдер не ответил вовремя, результат неизвестен',
  network_error: 'Соединение с провайдером не установилось или оборвалось, результат неизвестен',
  bad_response: 'Провайдер ответил, но ответ не читается, результат неизвестен',
  attempts_exhausted: 'Попытки отправки исчерпаны, подтверждения от провайдера нет',
  provider_mismatch: 'Подтверждение провайдера не совпало с заявкой, срок не сдвинут',
  resource_changed: 'Провайдер подтвердил, но срок ресурса уже не равен прежнему, срок не сдвинут',
};

export function problemText(code: string): string {
  const known = problemCodeLabel[code];
  if (known) return known;
  const http = /^http_(\d{3})$/.exec(code);
  if (http) {
    const status = Number(http[1]);
    if (status >= 500) return 'Провайдер ответил ошибкой сервера, результат неизвестен';
    if (status >= 400) return 'Провайдер отказал в операции';
    return 'Провайдер ответил неожиданным кодом, результат неизвестен';
  }
  return 'Проблема с провайдером';
}

// Текст кода вместе с самим кодом: «Провайдер отказал в операции (http_409)».
export function problemWithCode(code: string): string {
  return `${problemText(code)} (${code})`;
}

// Пояснение события для истории. Код из detail не теряется, он остаётся в скобках.
export function eventDetailText(kind: string, detail: string | null): string | null {
  if (!detail) return null;
  if (kind === 'provider_error') {
    // detail вида «http_503, попытка 1 из 3».
    const match = /^([a-z0-9_]+), (попытка \d+ из \d+)$/.exec(detail);
    if (match) return `${problemWithCode(match[1])}, ${match[2]}`;
    return detail;
  }
  if (kind === 'needs_attention' && /^[a-z0-9_]+$/.test(detail)) return problemWithCode(detail);
  if (kind === 'completed') {
    const match = /^operation_id (.+)$/.exec(detail);
    if (match) return `Операция провайдера: ${match[1]}`;
  }
  return detail;
}

// Отказ провайдера (http_4xx), на который повтор не поможет. 408 и 429 временные, их можно повторить.
function isPermanentRejection(code: string): boolean {
  const http = /^http_(4\d\d)$/.exec(code);
  return http !== null && http[1] !== '408' && http[1] !== '429';
}

// Что делать с заявкой в «Требует внимания», по коду причины и праву на повтор.
export function needsAttentionAdvice(code: string | null, canRetry: boolean): string {
  if (code === 'resource_changed') {
    return 'Операция у провайдера уже выполнена, но срок ресурса изменился после одобрения. Повтор снова остановится на этой проверке: расхождение нужно разобрать вручную.';
  }
  let cause: string | null = null;
  if (code === 'provider_mismatch') {
    cause = 'Повтор не поможет: подтверждение провайдера не совпадает с заявкой, и заявка снова остановится здесь. Нужно вручную сверить операцию у провайдера с заявкой.';
  } else if (code && isPermanentRejection(code)) {
    cause = 'Повтор не поможет: провайдер отказал в этой операции, и заявка снова остановится здесь. Причина в данных операции или на стороне провайдера, её нужно разобрать вручную.';
  }
  if (cause) {
    if (canRetry) return `${cause} Повторяйте отправку, только когда причина устранена.`;
    return `${cause} Разобрать и повторить отправку может согласующий этого пространства, кроме автора заявки. Пока заявка не разрешена, новую заявку на этот ресурс создать нельзя.`;
  }
  const retryNote =
    'Повтор идёт с тем же ключом операции: сначала обработчик спрашивает провайдера, выполнена ли операция, поэтому вторая операция не появится.';
  if (canRetry) return `Нажмите «Повторить отправку». ${retryNote}`;
  return `Повторить отправку может согласующий этого пространства, кроме автора заявки. ${retryNote} Пока заявка не разрешена, новую заявку на этот ресурс создать нельзя.`;
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
