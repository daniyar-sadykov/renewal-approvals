import { Injectable } from '@nestjs/common';

export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 60_000;
// Предел записей: перебор множества разных логинов не должен раздувать память процесса.
export const LOGIN_MAX_TRACKED = 10_000;

interface Entry {
  failures: number;
  windowStart: number;
}

// Счётчик неудачных входов по логину в памяти процесса. Окно фиксированное: от первой неудачи
// LOGIN_WINDOW_MS. После LOGIN_MAX_FAILURES неудач вход по этому логину закрыт до конца окна,
// даже с верным паролем. Успешный вход счётчик сбрасывает. При перезапуске счётчики теряются,
// для одного процесса тестового задания этого достаточно.
@Injectable()
export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  // Часы подменяются в тестах.
  now: () => number = () => Date.now();

  // Сколько мс осталось до конца блокировки, 0 если вход разрешён.
  blockedForMs(login: string): number {
    const entry = this.current(login);
    if (!entry || entry.failures < LOGIN_MAX_FAILURES) return 0;
    return entry.windowStart + LOGIN_WINDOW_MS - this.now();
  }

  recordFailure(login: string): void {
    const entry = this.current(login);
    if (entry) {
      entry.failures += 1;
      return;
    }
    if (this.entries.size >= LOGIN_MAX_TRACKED) this.evict();
    this.entries.set(login, { failures: 1, windowStart: this.now() });
  }

  recordSuccess(login: string): void {
    this.entries.delete(login);
  }

  get size(): number {
    return this.entries.size;
  }

  // Запись с истёкшим окном удаляется при обращении.
  private current(login: string): Entry | undefined {
    const entry = this.entries.get(login);
    if (entry && this.now() - entry.windowStart >= LOGIN_WINDOW_MS) {
      this.entries.delete(login);
      return undefined;
    }
    return entry;
  }

  // Сначала выбросить истёкшие окна; если места всё равно нет, самую старую запись (Map хранит порядок вставки).
  private evict(): void {
    const now = this.now();
    for (const [login, entry] of this.entries) {
      if (now - entry.windowStart >= LOGIN_WINDOW_MS) this.entries.delete(login);
    }
    if (this.entries.size >= LOGIN_MAX_TRACKED) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
