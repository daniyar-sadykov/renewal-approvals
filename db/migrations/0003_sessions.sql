-- Сессии входа. В базе лежит только хэш токена, сам токен живёт в cookie.

create table sessions (
  token_hash text        primary key,
  user_id    text        not null references users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);
