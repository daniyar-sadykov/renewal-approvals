import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG } from '../config.module';
import { AppConfig } from '../config';
import { ClaimedJob, JobRequest, ProviderJobsService } from './provider-jobs.service';
import { ProviderClient, ProviderOperation, RENEWAL_PERIOD_MONTHS, renewalPayload } from './provider.client';

// Фоновый обработчик задач отправки провайдеру в том же процессе, что и API.
// Всё состояние задачи в базе (post_attempts, next_run_at, lease_until), ключ в заявке,
// поэтому после перезапуска обработчик продолжает с того же места.
// Сетевые вызовы идут только вне транзакций базы.
// В лог идут id заявки, код, номер попытки и operation_id. Ключ идемпотентности не пишется:
// по нему операцию можно запросить у провайдера.
@Injectable()
export class RenewalWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('RenewalWorker');
  private running = false;
  private loopDone: Promise<void> | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jobs: ProviderJobsService,
    private readonly provider: ProviderClient,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.workerEnabled) return;
    this.running = true;
    this.loopDone = this.loop();
    this.logger.log(`Обработчик запущен, опрос раз в ${this.config.workerPollMs} мс`);
  }

  // Остановка: новых задач не берём, текущий шаг дорабатывает до конца (он ограничен таймаутами
  // провайдера). Пул базы закрывается позже, в onApplicationShutdown, так что шагу база доступна.
  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loopDone;
    this.loopDone = null;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let processed = false;
      try {
        processed = await this.runOnce();
      } catch (error) {
        // Сбой одной задачи или базы не роняет цикл: следующий круг через интервал опроса.
        this.logger.error(`Сбой цикла обработчика: ${(error as Error).message}`);
      }
      // Была задача: сразу смотрим следующую. Не было: ждём интервал.
      if (this.running && !processed) await this.pause(this.config.workerPollMs);
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        if (this.pauseTimer) clearTimeout(this.pauseTimer);
        this.pauseTimer = null;
        this.wake = null;
        resolve();
      };
      this.pauseTimer = setTimeout(() => this.wake?.(), ms);
    });
  }

  // Один шаг: взять готовую задачу и обработать. false, если готовых задач нет.
  async runOnce(): Promise<boolean> {
    const job = await this.jobs.claimNext(this.config.workerLeaseMs);
    if (!job) return false;
    try {
      await this.processJob(job);
    } catch (error) {
      this.logger.error(`Сбой обработки задачи ${job.id}: ${(error as Error).message}`);
      // Отложить и снять аренду. Не вышло (база недоступна): задачу вернёт истечение аренды.
      await this.jobs.scheduleRetry(job, null).catch(() => undefined);
    }
    return true;
  }

  private async processJob(job: ClaimedJob): Promise<void> {
    const request = await this.jobs.loadRequest(job.requestId);
    if (!request || request.status !== 'processing') {
      await this.jobs.closeStale(job, request?.status ?? null);
      return;
    }
    const key = request.idempotencyKey;
    const max = this.config.providerMaxPostAttempts;

    // POST уже уходил (или повтор после needs_attention): сначала спросить провайдера по ключу.
    // Операция могла выполниться, а ответ потеряться. GET попыткой не считается.
    if (job.postAttempts > 0 || job.verifyBeforePost) {
      const found = await this.provider.getRenewal(key);
      if (found.kind === 'confirmed') return this.confirm(job, request, found.operation);
      if (found.kind === 'rejected') return this.needsAttention(job, request, found.code);
      if (job.postAttempts >= max) {
        // Попытки исчерпаны, последний GET подтверждения не дал.
        return this.needsAttention(job, request, 'attempts_exhausted');
      }
      // not_found: операции у провайдера нет, отправляем.
      // unknown (GET без ответа): тоже отправляем. POST с тем же ключом и телом безопасен (провайдер
      // вернёт уже сохранённую операцию), а попытка учитывается. Если бы GET без ответа только откладывал
      // задачу, при полном отказе провайдера заявка висела бы в processing вечно и не дошла бы до needs_attention.
      if (found.kind === 'unknown') {
        this.logger.log(`Заявка ${request.id}: GET без ответа (${found.code}), повтор POST`);
      }
    }

    // Сначала запись попытки, потом отправка.
    const attempt = await this.jobs.countPostAttempt(job);
    if (attempt === null) return;

    const result = await this.provider.createRenewal(key, renewalPayload(request));
    if (result.kind === 'confirmed') return this.confirm(job, request, result.operation);
    if (result.kind === 'unknown') {
      // Результат неизвестен (503, таймаут, обрыв). Повтор с тем же ключом через паузу:
      // в эту паузу приложение можно остановить, после старта оно начнёт с GET.
      this.logger.log(`Заявка ${request.id}: ${result.code}, попытка ${attempt} из ${max}`);
      await this.jobs.scheduleRetry(job, { code: result.code, detail: `${result.code}, попытка ${attempt} из ${max}` });
      return;
    }
    // Отказ провайдера (4xx): повтор с тем же телом ничего не даст.
    return this.needsAttention(job, request, result.kind === 'rejected' ? result.code : 'provider_error');
  }

  private async confirm(job: ClaimedJob, request: JobRequest, operation: ProviderOperation): Promise<void> {
    // Подтверждение должно относиться именно к этой заявке.
    const matches =
      operation.status === 'completed' &&
      operation.resourceId === request.resourceId &&
      operation.amountMinor === request.amountMinor &&
      operation.currency === request.currency &&
      operation.periodMonths === RENEWAL_PERIOD_MONTHS;
    if (!matches) return this.needsAttention(job, request, 'provider_mismatch');

    const outcome = await this.jobs.finalize(request.id, operation.operationId);
    if (outcome === 'resource_changed') {
      this.logger.warn(`Заявка ${request.id}: срок ресурса разошёлся со снимком, needs_attention (resource_changed)`);
    } else {
      this.logger.log(`Заявка ${request.id}: ${outcome}, operation_id ${operation.operationId}`);
    }
  }

  private async needsAttention(job: ClaimedJob, request: JobRequest, code: string): Promise<void> {
    const done = await this.jobs.markNeedsAttention(request.id, code, job.leaseToken);
    if (done) this.logger.warn(`Заявка ${request.id}: needs_attention (${code})`);
  }
}
