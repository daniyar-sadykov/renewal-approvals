import type { IncomingMessage } from 'node:http';

// Текущий пользователь. Берётся только из сессии.
export interface AuthUser {
  id: string;
  login: string;
  displayName: string;
}

// Запрос после guard: пользователь и хэш токена его сессии.
export interface AuthedRequest extends IncomingMessage {
  user?: AuthUser;
  sessionTokenHash?: string;
}
