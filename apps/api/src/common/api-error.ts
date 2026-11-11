import { HttpException, HttpStatus } from '@nestjs/common';

// Тело любой ошибки API: { error: '<код>', message: '<текст для человека>' }.
export interface ApiErrorBody {
  error: string;
  message: string;
}

export class ApiError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string) {
    super({ error: code, message } satisfies ApiErrorBody, status);
  }
}

export const unauthorized = (message = 'Требуется вход в систему'): ApiError =>
  new ApiError(HttpStatus.UNAUTHORIZED, 'unauthorized', message);

export const forbidden = (message = 'Нет доступа'): ApiError =>
  new ApiError(HttpStatus.FORBIDDEN, 'forbidden', message);

export const notFound = (message = 'Не найдено'): ApiError => new ApiError(HttpStatus.NOT_FOUND, 'not_found', message);

export const conflict = (code: string, message: string): ApiError => new ApiError(HttpStatus.CONFLICT, code, message);

export const validationError = (message: string): ApiError =>
  new ApiError(HttpStatus.BAD_REQUEST, 'validation_error', message);
