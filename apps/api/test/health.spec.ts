import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, httpServer } from './helpers/app';

// Приложение тестов: тестовая база, обработчик выключен, к провайдеру не ходит.
describe('GET /api/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('отдаёт 200, когда база отвечает', async () => {
    const response = await request(httpServer(app)).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', database: 'up' });
  });
});
