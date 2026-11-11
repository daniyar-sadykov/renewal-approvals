import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { useTestDatabase } from './db';

export const DEMO_PASSWORD = 'renewals-demo';

export type DemoLogin = 'initiator.alpha' | 'approver.alpha' | 'initiator.beta' | 'universal.alpha';

// Приложение на тестовой базе с той же настройкой, что в main.ts. Базу готовит сам тест.
export async function createTestApp(): Promise<INestApplication> {
  useTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
