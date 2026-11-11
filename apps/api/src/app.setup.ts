import { INestApplication, NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { forbidden, validationError } from './common/api-error';
import { ApiExceptionFilter } from './common/api-exception.filter';

// Опции создания приложения (main.ts и тесты). Встроенные парсеры Nest выключены, configureApp
// включает только JSON: разбора application/x-www-form-urlencoded в приложении нет вовсе.
export const APP_OPTIONS: NestApplicationOptions = { bodyParser: false };

type Next = (error?: unknown) => void;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Защитные заголовки на любой ответ API, включая ошибки и 404.
function securityHeaders(_req: IncomingMessage, res: ServerResponse, next: Next): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    // Origin: null (песочница, file://) и мусор считаем чужими.
    return null;
  }
}

// Защита от CSRF для изменяющих запросов. Cookie сессии SameSite=Lax, но вход открыт, а Lax
// пропускает запросы с соседних поддоменов. Браузер на POST всегда шлёт Origin, поэтому сверяем его
// с Host. Запросы без Origin (curl, supertest, серверные клиенты) пропускаем: это не браузер.
// Прокси Vite идёт с changeOrigin: false, Host остаётся адресом Vite и совпадает с Origin страницы.
function csrfGuard(req: IncomingMessage, _res: ServerResponse, next: Next): void {
  if (SAFE_METHODS.has(req.method ?? 'GET')) return next();
  if (req.headers['sec-fetch-site'] === 'cross-site') return next(forbidden('Запрос с чужого сайта отклонён'));
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const host = req.headers.host?.toLowerCase();
    if (!host || originHost(origin) !== host) return next(forbidden('Запрос с чужого сайта отклонён'));
  }
  next();
}

// Тело изменяющего запроса только JSON. Форму (urlencoded, multipart, text/plain) браузер может
// отправить с чужого сайта без предварительного запроса, поэтому такие тела не принимаются вовсе.
function jsonBodyOnly(req: IncomingMessage, _res: ServerResponse, next: Next): void {
  if (SAFE_METHODS.has(req.method ?? 'GET')) return next();
  const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
  if (!hasBody) return next();
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return next(validationError('Тело запроса принимается только в формате JSON'));
  next();
}

// Общая настройка приложения. Вызывается и в main.ts, и в тестах, чтобы они не расходились.
// Middleware ниже не зависят от опций создания: защита действует, даже если приложение создано без APP_OPTIONS.
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  express.disable('x-powered-by');
  // Порядок важен: заголовки, Origin и тип тела проверяются до разбора тела.
  express.use(securityHeaders);
  express.use(csrfGuard);
  express.use(jsonBodyOnly);
  express.useBodyParser('json');
  app.setGlobalPrefix('api');
  // Единый формат ошибок: { error, message }. Ловит и ошибки из middleware выше (next(error)).
  app.useGlobalFilters(new ApiExceptionFilter());
  // Закрывает пул базы при остановке процесса (SIGINT, SIGTERM).
  app.enableShutdownHooks();
}
