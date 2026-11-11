import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { loadConfig } from '../../src/config';
import { APP_CONFIG } from '../../src/config.module';
import { useTestDatabase } from './db';

export const DEMO_PASSWORD = 'renewals-demo';

export type DemoLogin = 'initiator.alpha' | 'approver.alpha' | 'initiator.beta' | 'universal.alpha';

export interface TestAppOptions {
  // Фоновый обработчик. По умолчанию выключен: тесты 01-09 проверяют заявку в processing
  // и не должны зависеть от того, успел ли обработчик сходить к провайдеру.
  worker?: boolean;
  // Переопределение переменных окружения только для этого приложения (PROVIDER_RETRY_DELAY_MS и т.п.).
  env?: Record<string, string>;
}

// Приложение на тестовой базе с той же настройкой, что в main.ts. Базу готовит сам тест.
export async function createTestApp(options: TestAppOptions = {}): Promise<INestApplication> {
  useTestDatabase();
  const config = loadConfig({ ...process.env, ...options.env, WORKER_ENABLED: options.worker ? 'true' : 'false' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  configureApp(app);
  await app.init();
  return app;
}

export function httpServer(app: INestApplication): Server {
  return app.getHttpServer() as Server;
}

// Агент supertest с cookie сессии пользователя.
export async function loginAs(app: INestApplication, login: DemoLogin): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(httpServer(app));
  const response = await agent.post('/api/auth/login').send({ login, password: DEMO_PASSWORD });
  if (response.status !== 200) {
    throw new Error(`Вход под ${login} не удался: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return agent;
}
