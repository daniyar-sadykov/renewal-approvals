import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config.module';
import { AppConfig } from '../config';

// Продление всегда на 30 дней, у провайдера это один месяц. Одно значение на все заявки.
export const RENEWAL_PERIOD_MONTHS = 1;

// Предел тела ответа провайдера. Операция занимает сотни байт; больше значит ответ не тот,
// а читать его целиком в память нельзя.
export const MAX_RESPONSE_BYTES = 64 * 1024;

// Тело POST /renewals. Строится только из снимка заявки, поэтому для одной заявки всегда одинаковое.
export interface RenewalPayload {
  resource_id: string;
  period_months: number;
  amount_minor: number;
  currency: string;
}

// Операция провайдера, как он её вернул.
export interface ProviderOperation {
  operationId: string;
  status: string;
  resourceId: unknown;
  periodMonths: unknown;
  amountMinor: unknown;
  currency: unknown;
}

// Результат вызова. code это короткий код для истории и лога (http_503, timeout, network_error, ...),
// тело ответа провайдера дальше клиента не уходит.
export type ProviderResult =
  // 200 с читаемой операцией.
  | { kind: 'confirmed'; operation: ProviderOperation }
  // 404 на GET: провайдер операцию по ключу не знает.
  | { kind: 'not_found' }
  // Результат неизвестен: 5xx, таймаут, обрыв сети, нечитаемый ответ. Можно повторить с тем же ключом.
  | { kind: 'unknown'; code: string }
  // Провайдер отказал (4xx): повтор с тем же телом бессмыслен.
  | { kind: 'rejected'; code: string };

export function renewalPayload(snapshot: { resourceId: string; amountMinor: number; currency: string }): RenewalPayload {
  return {
    resource_id: snapshot.resourceId,
    period_months: RENEWAL_PERIOD_MONTHS,
    amount_minor: snapshot.amountMinor,
    currency: snapshot.currency,
  };
}

// Клиент провайдера продления. Встроенный fetch, таймаут на весь запрос вместе с чтением тела.
@Injectable()
export class ProviderClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  createRenewal(idempotencyKey: string, payload: RenewalPayload): Promise<ProviderResult> {
    return this.call('POST', '/renewals', {
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload),
    });
  }

  getRenewal(idempotencyKey: string): Promise<ProviderResult> {
    return this.call('GET', `/renewals/${encodeURIComponent(idempotencyKey)}`, {});
  }

  private async call(method: 'GET' | 'POST', path: string, init: RequestInit): Promise<ProviderResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.providerTimeoutMs);
    try {
      const response = await fetch(`${this.config.providerBaseUrl.replace(/\/+$/, '')}${path}`, {
        ...init,
        method,
        signal: controller.signal,
        redirect: 'error',
      });
      // Тело читается всегда, чтобы соединение освободилось, и под тем же таймаутом.
      const text = await readLimited(response, MAX_RESPONSE_BYTES);
      // Слишком большой ответ не разбираем: что сделал провайдер, неизвестно.
      if (text === null) return { kind: 'unknown', code: 'bad_response' };
      const status = response.status;

      if (status === 200) {
        const operation = parseOperation(text);
        return operation ? { kind: 'confirmed', operation } : { kind: 'unknown', code: 'bad_response' };
      }
      if (status === 404 && method === 'GET') return { kind: 'not_found' };
      if (status >= 400 && status < 500) return { kind: 'rejected', code: `http_${status}` };
      // 5xx и всё прочее (1xx, 2xx кроме 200, 3xx): что сделал провайдер, неизвестно.
      return { kind: 'unknown', code: `http_${status}` };
    } catch {
      // Подробности ошибки не нужны: в историю и лог идёт только код.
      return { kind: 'unknown', code: controller.signal.aborted ? 'timeout' : 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }
}

// Тело ответа целиком в памяти, но не больше limit байт: и по заявленному Content-Length, и по факту
// (chunked или ложный заголовок). null: тело больше предела, чтение прервано.
async function readLimited(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseOperation(text: string): ProviderOperation | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const body = data as Record<string, unknown>;
  if (typeof body.operation_id !== 'string' || body.operation_id.length === 0 || body.operation_id.length > 255) {
    return null;
  }
  if (typeof body.status !== 'string') return null;
  return {
    operationId: body.operation_id,
    status: body.status,
    resourceId: body.resource_id,
    periodMonths: body.period_months,
    amountMinor: body.amount_minor,
    currency: body.currency,
  };
}
