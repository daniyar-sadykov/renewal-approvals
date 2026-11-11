import { Module } from '@nestjs/common';
import { ProviderJobsService } from './provider-jobs.service';
import { ProviderClient } from './provider.client';
import { RenewalWorker } from './renewal-worker.service';

// Клиент провайдера и фоновый обработчик задач отправки.
@Module({
  providers: [ProviderClient, ProviderJobsService, RenewalWorker],
  exports: [ProviderClient, ProviderJobsService, RenewalWorker],
})
export class ProviderModule {}
