-- Заявки на продление, их история и задачи отправки провайдеру.

create table renewal_requests (
  id                    uuid        primary key default gen_random_uuid(),
  workspace_id          text        not null references workspaces (id),
  resource_id           text        not null references resources (id),
  status                text        not null default 'pending'
    check (status in ('pending', 'rejected', 'processing', 'completed', 'needs_attention')),
  created_by            text        not null references users (id),
  decided_by            text        references users (id),
  -- Снимок ресурса на момент создания заявки.
  old_expires_on        date        not null,
  new_expires_on        date        not null,
  amount_minor          integer     not null check (amount_minor >= 0),
  currency              text        not null default 'RUB' check (currency = 'RUB'),
  -- Ключ операции у провайдера: создаётся вместе с заявкой и не меняется.
  idempotency_key       text        not null unique,
  provider_operation_id text,
  last_error_code       text,
  created_at            timestamptz not null default now(),
  decided_at            timestamptz,
  completed_at          timestamptz,
  -- Второй рубеж запрета на согласование своей заявки.
  constraint renewal_requests_not_self_decided
    check (decided_by is null or decided_by <> created_by)
);

-- У ресурса не больше одной активной заявки.
create unique index renewal_requests_one_active_per_resource
  on renewal_requests (resource_id)
  where status in ('pending', 'processing', 'needs_attention');

create index renewal_requests_workspace_idx on renewal_requests (workspace_id, created_at desc);
create index renewal_requests_resource_idx on renewal_requests (resource_id, created_at desc);

-- История заявки. actor_user_id пустой, если переход сделала система (обработчик).
create table request_events (
  id            bigint      generated always as identity primary key,
  request_id    uuid        not null references renewal_requests (id) on delete cascade,
  actor_user_id text        references users (id),
  from_status   text,
  to_status     text,
  kind          text        not null,
  detail        text,
  created_at    timestamptz not null default now()
);

create index request_events_request_idx on request_events (request_id, id);

-- Задача отправки провайдеру. request_id unique: вторая задача на ту же заявку невозможна.
create table provider_jobs (
  id            bigint      generated always as identity primary key,
  request_id    uuid        not null unique references renewal_requests (id) on delete cascade,
  post_attempts integer     not null default 0 check (post_attempts >= 0),
  state         text        not null default 'queued',
  next_run_at   timestamptz not null default now(),
  lease_until   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index provider_jobs_due_idx on provider_jobs (state, next_run_at);
