-- Состояния задачи отправки и флаг проверки перед POST после повтора.

-- queued: ждёт или идёт обработка; done: провайдер подтвердил, заявка завершена;
-- failed: заявка ушла в needs_attention, задачу снова ставит в очередь только повтор согласующим.
alter table provider_jobs
  add constraint provider_jobs_state_check check (state in ('queued', 'done', 'failed'));

-- После повтора счётчик POST обнуляется, но операция у провайдера могла уже выполниться.
-- Флаг заставляет обработчик сначала спросить GET по ключу и только потом слать POST.
alter table provider_jobs
  add column verify_before_post boolean not null default false;
