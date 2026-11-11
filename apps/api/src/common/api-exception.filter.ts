import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { ApiErrorBody } from './api-error';

const DEFAULTS: Record<number, ApiErrorBody> = {
  400: { error: 'validation_error', message: 'Некорректный запрос' },
  401: { error: 'unauthorized', message: 'Требуется вход в систему' },
  403: { error: 'forbidden', message: 'Нет доступа' },
  404: { error: 'not_found', message: 'Не найдено' },
  409: { error: 'conflict', message: 'Конфликт состояния' },
  413: { error: 'payload_too_large', message: 'Слишком большой запрос' },
};

const CODE_PATTERN = /^[a-z][a-z_]*$/;

function bodyFor(status: number, response: unknown): ApiErrorBody {
  // Своё тело ({ error: 'код', message }) отдаём как есть, стандартные тела Nest заменяем.
  if (response && typeof response === 'object') {
    const { error, message } = response as Record<string, unknown>;
    if (typeof error === 'string' && CODE_PATTERN.test(error) && typeof message === 'string') {
      return { error, message };
    }
  }
  if (DEFAULTS[status]) return DEFAULTS[status];
  if (status >= 500) return { error: 'internal_error', message: 'Внутренняя ошибка сервера' };
  return { error: 'bad_request', message: 'Некорректный запрос' };
}

function isClientHttpError(value: unknown): value is { status: number; type: string } {
  if (!value || typeof value !== 'object') return false;
  const { status, type } = value as Record<string, unknown>;
  return typeof status === 'number' && status >= 400 && status < 500 && typeof type === 'string';
}

// Единый формат ошибок. Детали 500 уходят только в лог, наружу общий текст.
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<ServerResponse>();
    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ApiErrorBody = { error: 'internal_error', message: 'Внутренняя ошибка сервера' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = bodyFor(status, exception.getResponse());
    } else if (isClientHttpError(exception)) {
      // Ошибки разбора тела (битый JSON, слишком большой запрос) приходят от body-parser.
      status = exception.status;
      body = bodyFor(status, undefined);
    } else {
      const error = exception as Error;
      this.logger.error(`Необработанная ошибка: ${error?.message}`, error?.stack);
    }

    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }
}
