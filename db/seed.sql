-- Начальные данные: пространства, ресурсы и учётные записи из задания.
-- Файл идемпотентный: повторный запуск возвращает эти строки к исходным значениям.
-- Пароль у всех учёток тестовый и открытый: renewals-demo.
-- Хэши посчитаны командой `node scripts/hash-password.mjs renewals-demo 4`.

insert into workspaces (id, name) values
  ('ws-alpha', 'Alpha'),
  ('ws-beta',  'Beta')
on conflict (id) do update set name = excluded.name;

insert into resources (id, workspace_id, name, expires_on, price_minor, currency) values
  ('res-a-01', 'ws-alpha', 'Хранилище A', date '2027-03-01', 128000, 'RUB'),
  ('res-a-02', 'ws-alpha', 'Сервис B',    date '2027-05-20', 250000, 'RUB'),
  ('res-b-01', 'ws-beta',  'Сервис C',    date '2027-06-01', 150000, 'RUB')
on conflict (id) do update set
  workspace_id = excluded.workspace_id,
  name         = excluded.name,
  expires_on   = excluded.expires_on,
  price_minor  = excluded.price_minor,
  currency     = excluded.currency;

insert into users (id, login, password_hash, display_name) values
  ('usr-initiator-alpha', 'initiator.alpha',
   'scrypt$f5f6eb428906f5dc608af48445d39cf5$c3e85355188386d9c0efe63c15a65e92677618aa6f33ee737cfbbbe95dc18b4645794045a5c13ef4ff220da0a1ac3feb47112612aa69b510836b5d074c90e6f7',
   'Инициатор Alpha'),
  ('usr-approver-alpha', 'approver.alpha',
   'scrypt$2ba59f6a63a7f6218f299b71ab8a0b56$0ca9c5658b9eb5b0c743710c37401a407f866295996e33dc3ed25aac293e42fdbaae251f8af55560ffcceeb208bd9a231a6f576c4eef13b4aa54642d3e277ef3',
   'Согласующий Alpha'),
  ('usr-initiator-beta', 'initiator.beta',
   'scrypt$a730a550ba9fdfd750a48c629f1278b5$d141733edcf07a1b71f5aeb4c2bedc1b7677b82186aaaf6abefc7a4d45e4c433963f89a679542e7743d3382ec53cb6d1325f3cfdda6947e50208c1000de1605c',
   'Инициатор Beta'),
  ('usr-universal-alpha', 'universal.alpha',
   'scrypt$6494db3dcacd5fc31a69aa5dc32b37b6$7be03483d5d28c6252e968b0f47aeb8ea4afa222f9504a9e0286fd1ac7877b2e563a20b3fe4d223bbb058a2c30b46a17b66c4e7f31e9f023fb9fa3ae5921f48c',
   'Универсальный Alpha')
on conflict (id) do update set
  login         = excluded.login,
  password_hash = excluded.password_hash,
  display_name  = excluded.display_name;

insert into memberships (user_id, workspace_id, can_initiate, can_approve) values
  ('usr-initiator-alpha', 'ws-alpha', true,  false),
  ('usr-approver-alpha',  'ws-alpha', false, true),
  ('usr-initiator-beta',  'ws-beta',  true,  false),
  ('usr-universal-alpha', 'ws-alpha', true,  true)
on conflict (user_id, workspace_id) do update set
  can_initiate = excluded.can_initiate,
  can_approve  = excluded.can_approve;
