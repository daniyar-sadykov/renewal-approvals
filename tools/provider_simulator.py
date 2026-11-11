#!/usr/bin/env python3
"""Локальный симулятор провайдера продления; данные хранятся только в памяти процесса.

Запуск: python3 provider_simulator.py. Сервер слушает 127.0.0.1:8091.
После остановки или перезапуска сервера все операции и ключи удаляются.
"""

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

HOST = '127.0.0.1'
PORT = 8091
MAX_BODY_BYTES = 1024 * 1024
OPERATIONS = {}
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = 'RenewalSimulator/1.0'

    def log_message(self, format, *args):
        # Не выводим ключи идемпотентности или содержимое запросов.
        return

    def respond(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/health':
            self.respond(200, {'status': 'ok'})
            return
        if path == '/stats':
            params = parse_qs(urlsplit(self.path).query)
            resources = params.get('resource_id', [])
            if len(resources) != 1 or not resources[0].strip():
                self.respond(400, {'error': 'invalid_resource_id'})
                return
            resource_id = resources[0]
            with LOCK:
                count = sum(1 for entry in OPERATIONS.values()
                            if entry['operation']['resource_id'] == resource_id)
            self.respond(200, {'resource_id': resource_id, 'operation_count': count})
            return
        if path.startswith('/renewals/'):
            key = unquote(path[len('/renewals/'):])
            if not key:
                self.respond(400, {'error': 'invalid_idempotency_key'})
                return
            with LOCK:
                entry = OPERATIONS.get(key)
                operation = dict(entry['operation']) if entry else None
            if operation is None:
                self.respond(404, {'error': 'not_found'})
            else:
                self.respond(200, operation)
            return
        self.respond(404, {'error': 'not_found'})

    def do_POST(self):
        if urlsplit(self.path).path != '/renewals':
            self.respond(404, {'error': 'not_found'})
            return
        key = self.headers.get('Idempotency-Key', '').strip()
        if not key or len(key) > 255:
            self.respond(400, {'error': 'invalid_idempotency_key'})
            return
        try:
            length = int(self.headers.get('Content-Length', ''))
            if length <= 0 or length > MAX_BODY_BYTES:
                raise ValueError
            data = json.loads(self.rfile.read(length).decode('utf-8'))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            self.respond(400, {'error': 'invalid_json'})
            return
        if not isinstance(data, dict) or set(data) != {'resource_id', 'period_months', 'amount_minor', 'currency'}:
            self.respond(400, {'error': 'invalid_payload'})
            return
        resource_id = data['resource_id']
        period = data['period_months']
        amount = data['amount_minor']
        currency = data['currency']
        if (not isinstance(resource_id, str) or not resource_id.strip()
                or len(resource_id) > 255 or type(period) is not int or period <= 0
                or type(amount) is not int or amount < 0 or currency != 'RUB'):
            self.respond(400, {'error': 'invalid_payload'})
            return
        with LOCK:
            entry = OPERATIONS.get(key)
            if entry is None:
                operation = {
                    'operation_id': str(uuid.uuid4()),
                    'status': 'completed',
                    'started_count': 1,
                    **data,
                }
                OPERATIONS[key] = {'payload': data, 'operation': operation}
                status, response = 503, {'error': 'response_lost'}
            elif entry['payload'] != data:
                status, response = 409, {'error': 'idempotency_key_conflict'}
            else:
                status, response = 200, dict(entry['operation'])
        self.respond(status, response)


if __name__ == '__main__':
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f'Симулятор запущен на http://{HOST}:{PORT}; данные хранятся только в памяти.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
