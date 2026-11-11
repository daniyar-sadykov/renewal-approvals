-- Пространства, учётные записи, членство с правами, ресурсы.

create table workspaces (
  id   text primary key,
  name text not null unique
);

create table users (
  id            text primary key,
  login         text not null unique,
  password_hash text not null,
  display_name  text not null
);

-- Права пользователя в пространстве. Источник истины для авторизации.
create table memberships (
  user_id      text    not null references users (id) on delete cascade,
  workspace_id text    not null references workspaces (id) on delete cascade,
  can_initiate boolean not null default false,
  can_approve  boolean not null default false,
  primary key (user_id, workspace_id)
);

create index memberships_workspace_idx on memberships (workspace_id);

-- Срок: календарная дата без времени. Стоимость: целое число копеек.
create table resources (
  id           text    primary key,
  workspace_id text    not null references workspaces (id),
  name         text    not null,
  expires_on   date    not null,
  price_minor  integer not null check (price_minor >= 0),
  currency     text    not null default 'RUB' check (currency = 'RUB')
);

create index resources_workspace_idx on resources (workspace_id);
