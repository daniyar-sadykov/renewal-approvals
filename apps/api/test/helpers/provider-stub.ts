import http, { IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

// Заглушка провайдера для тестов, где настоящий имитатор не подходит: он подтверждает уже на втором запросе.
// Слушает свободный порт, считает запросы, запоминает ключи и тела.
//
// Режимы:
// - down: POST всегда 503 и ничего не сохраняет, GET всегда 404;
// - lost: POST сохраняет операцию, но всегда отвечает 503; GET всегда 404 (ответы теряются);
// - working: как имитатор: новый ключ сохраняется и даёт 503, повтор с тем же телом 200, другое тело 409;
//   GET отдаёт сохранённую операцию или 404;
// - reject409, reject400: POST отвечает 409 или 400, GET 404;
// - mismatch: POST сразу 200, но операция с чужим resource_id или суммой (поле mismatch);
// - hang: на POST и GET не отвечает вовсе (проверка таймаута).
export type StubMode = 'down' | 'lost' | 'working' | 'reject409' | 'reject400' | 'mismatch' | 'hang';

export interface StubPost {
  key: string | undefined;
  body: string;
}

interface StoredOperation {
  payload: string;
  operation: Record<string, unknown>;
}

export class ProviderStub {
  mode: StubMode = 'down';
  mismatch: 'resource' | 'amount' = 'resource';
  readonly posts: StubPost[] = [];
  readonly gets: string[] = [];
  readonly operations = new Map<string, StoredOperation>();
  private server: http.Server | null = null;
  private readonly hanging = new Set<ServerResponse>();

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const res of this.hanging) res.destroy();
    this.hanging.clear();
    // Keep-alive соединения fetch иначе держат close и сам jest.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  reset(mode: StubMode): void {
    this.mode = mode;
    this.posts.length = 0;
    this.gets.length = 0;
    this.operations.clear();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      if (req.method === 'POST' && url.pathname === '/renewals') {
        const key = req.headers['idempotency-key'] as string | undefined;
        this.posts.push({ key, body });
        this.onPost(key ?? '', body, res);
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/renewals/')) {
        const key = decodeURIComponent(url.pathname.slice('/renewals/'.length));
        this.gets.push(key);
        this.onGet(key, res);
        return;
      }
      send(res, 404, { error: 'not_found' });
    });
  }

  private onPost(key: string, body: string, res: ServerResponse): void {
    switch (this.mode) {
      case 'hang':
        this.hanging.add(res);
        return;
      case 'down':
        return send(res, 503, { error: 'unavailable' });
      case 'reject409':
        return send(res, 409, { error: 'idempotency_key_conflict' });
      case 'reject400':
        return send(res, 400, { error: 'invalid_payload' });
      case 'mismatch': {
        const operation = this.operationFor(body);
        if (this.mismatch === 'resource') operation.resource_id = 'res-foreign';
        else operation.amount_minor = Number(operation.amount_minor) + 1;
        return send(res, 200, operation);
      }
      case 'lost':
        if (!this.operations.has(key)) this.operations.set(key, { payload: body, operation: this.operationFor(body) });
        return send(res, 503, { error: 'response_lost' });
      case 'working': {
        const stored = this.operations.get(key);
        if (!stored) {
          this.operations.set(key, { payload: body, operation: this.operationFor(body) });
          return send(res, 503, { error: 'response_lost' });
        }
        if (stored.payload !== body) return send(res, 409, { error: 'idempotency_key_conflict' });
        return send(res, 200, stored.operation);
      }
    }
  }

  private onGet(key: string, res: ServerResponse): void {
    if (this.mode === 'hang') {
      this.hanging.add(res);
      return;
    }
    const stored = this.mode === 'working' ? this.operations.get(key) : undefined;
    if (stored) return send(res, 200, stored.operation);
    send(res, 404, { error: 'not_found' });
  }

  private operationFor(body: string): Record<string, unknown> {
    return { operation_id: randomUUID(), status: 'completed', started_count: 1, ...JSON.parse(body) };
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
