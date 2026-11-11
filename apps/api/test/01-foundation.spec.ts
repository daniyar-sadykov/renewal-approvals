import { Client } from 'pg';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { connectTestDb, resetTestDatabase, runDbScript } from './helpers/db';

// Фича 01: миграции и начальные данные на чистой базе.
describe('01: миграции и начальные данные', () => {
  let db: Client;

  beforeAll(async () => {
    resetTestDatabase();
    db = await connectTestDb();
  });

  afterAll(async () => {
    await db.end();
  });

  it('создаёт два пространства', async () => {
    const { rows } = await db.query('select id, name from workspaces order by name');
    expect(rows).toEqual([
      { id: 'ws-alpha', name: 'Alpha' },
      { id: 'ws-beta', name: 'Beta' },
    ]);
  });

  it('создаёт три ресурса с точными сроками и стоимостью', async () => {
    const { rows } = await db.query(
      `select r.id, w.name as workspace, r.name, r.expires_on, r.price_minor, r.currency
         from resources r join workspaces w on w.id = r.workspace_id
        order by r.id`,
    );
    expect(rows).toEqual([
      { id: 'res-a-01', workspace: 'Alpha', name: 'Хранилище A', expires_on: '2027-03-01', price_minor: 128000, currency: 'RUB' },
      { id: 'res-a-02', workspace: 'Alpha', name: 'Сервис B', expires_on: '2027-05-20', price_minor: 250000, currency: 'RUB' },
      { id: 'res-b-01', workspace: 'Beta', name: 'Сервис C', expires_on: '2027-06-01', price_minor: 150000, currency: 'RUB' },
    ]);
  });

  it('хранит срок как date, стоимость как integer', async () => {
    const { rows } = await db.query(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'resources'
          and column_name in ('expires_on', 'price_minor')
        order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'expires_on', data_type: 'date' },
      { column_name: 'price_minor', data_type: 'integer' },
    ]);
  });

  it('создаёт четыре учётки с членством и правами', async () => {
    const { rows } = await db.query(
      `select u.login, u.display_name, w.name as workspace, m.can_initiate, m.can_approve
         from users u
         join memberships m on m.user_id = u.id
         join workspaces w on w.id = m.workspace_id
        order by u.login`,
    );
    expect(rows).toEqual([
      { login: 'approver.alpha', display_name: 'Согласующий Alpha', workspace: 'Alpha', can_initiate: false, can_approve: true },
      { login: 'initiator.alpha', display_name: 'Инициатор Alpha', workspace: 'Alpha', can_initiate: true, can_approve: false },
      { login: 'initiator.beta', display_name: 'Инициатор Beta', workspace: 'Beta', can_initiate: true, can_approve: false },
      { login: 'universal.alpha', display_name: 'Универсальный Alpha', workspace: 'Alpha', can_initiate: true, can_approve: true },
    ]);
    const users = await db.query('select count(*)::int as n from users');
    const memberships = await db.query('select count(*)::int as n from memberships');
    expect(users.rows[0].n).toBe(4);
    expect(memberships.rows[0].n).toBe(4);
  });

  it('пароль renewals-demo подходит каждой учётке, другой пароль нет', async () => {
    const { rows } = await db.query('select login, password_hash from users order by login');
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.password_hash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
      await expect(verifyPassword('renewals-demo', row.password_hash)).resolves.toBe(true);
      await expect(verifyPassword('renewals-demo ', row.password_hash)).resolves.toBe(false);
      await expect(verifyPassword('wrong-password', row.password_hash)).resolves.toBe(false);
    }
    // Соль у каждой учётки своя.
    expect(new Set(rows.map((row) => row.password_hash)).size).toBe(4);
  });

  it('hashPassword и verifyPassword согласованы, битый хэш не проходит', async () => {
    const hash = await hashPassword('другой пароль');
    expect(hash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    await expect(verifyPassword('другой пароль', hash)).resolves.toBe(true);
    await expect(verifyPassword('renewals-demo', hash)).resolves.toBe(false);
    await expect(verifyPassword('renewals-demo', '')).resolves.toBe(false);
    await expect(verifyPassword('renewals-demo', 'scrypt$zz$zz')).resolves.toBe(false);
    await expect(verifyPassword('renewals-demo', 'bcrypt$00$00')).resolves.toBe(false);
  });

  describe('ограничения заявок в базе', () => {
    const insertRequest = (overrides: Record<string, unknown> = {}) => {
      const row = {
        resource_id: 'res-a-01',
        status: 'pending',
        created_by: 'usr-initiator-alpha',
        decided_by: null,
        currency: 'RUB',
        ...overrides,
      };
      return db.query(
        `insert into renewal_requests
           (id, workspace_id, resource_id, status, created_by, decided_by,
            old_expires_on, new_expires_on, amount_minor, currency, idempotency_key)
         select g.id, 'ws-alpha', $1, $2, $3, $4, date '2027-03-01', date '2027-03-31', 128000, $5, 'renewal-' || g.id
           from (select gen_random_uuid() as id) g
         returning id`,
        [row.resource_id, row.status, row.created_by, row.decided_by, row.currency],
      );
    };

    afterEach(async () => {
      await db.query('delete from renewal_requests');
    });

    it('вторая активная заявка на тот же ресурс отбивается индексом', async () => {
      await insertRequest();
      for (const status of ['pending', 'processing', 'needs_attention']) {
        await expect(insertRequest({ status, created_by: 'usr-universal-alpha' })).rejects.toMatchObject({
          code: '23505',
          constraint: 'renewal_requests_one_active_per_resource',
        });
      }
      // Другой ресурс и завершённые заявки индекс не задевает.
      await expect(insertRequest({ resource_id: 'res-a-02' })).resolves.toBeDefined();
      await expect(insertRequest({ status: 'rejected' })).resolves.toBeDefined();
      await expect(insertRequest({ status: 'completed' })).resolves.toBeDefined();
    });

    it('после закрытия активной заявки можно завести новую', async () => {
      const first = await insertRequest();
      await db.query(`update renewal_requests set status = 'rejected', decided_by = 'usr-approver-alpha' where id = $1`, [
        first.rows[0].id,
      ]);
      await expect(insertRequest()).resolves.toBeDefined();
    });

    it('свою заявку нельзя решить: check на decided_by', async () => {
      await expect(insertRequest({ decided_by: 'usr-initiator-alpha' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'renewal_requests_not_self_decided',
      });
    });

    it('неизвестный статус и чужая валюта отбиваются check', async () => {
      await expect(insertRequest({ status: 'cancelled' })).rejects.toMatchObject({ code: '23514' });
      await expect(insertRequest({ currency: 'USD' })).rejects.toMatchObject({ code: '23514' });
    });

    it('ключ идемпотентности уникален, задача на заявку одна', async () => {
      const { rows } = await insertRequest();
      const id = rows[0].id;
      await expect(
        db.query(
          `insert into renewal_requests
             (workspace_id, resource_id, status, created_by, old_expires_on, new_expires_on, amount_minor, idempotency_key)
           values ('ws-alpha', 'res-a-02', 'pending', 'usr-initiator-alpha', date '2027-05-20', date '2027-06-19', 250000, $1)`,
          [`renewal-${id}`],
        ),
      ).rejects.toMatchObject({ code: '23505' });

      await db.query('insert into provider_jobs (request_id) values ($1)', [id]);
      await expect(db.query('insert into provider_jobs (request_id) values ($1)', [id])).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  it('есть все таблицы схемы', async () => {
    const { rows } = await db.query(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'memberships',
      'provider_jobs',
      'renewal_requests',
      'request_events',
      'resources',
      'schema_migrations',
      'sessions',
      'users',
      'workspaces',
    ]);
  });

  it('повторный прогон миграций и начальных данных ничего не ломает', async () => {
    const snapshot = async () => ({
      migrations: (await db.query('select version, applied_at from schema_migrations order by version')).rows,
      workspaces: (await db.query('select * from workspaces order by id')).rows,
      resources: (await db.query('select * from resources order by id')).rows,
      users: (await db.query('select * from users order by id')).rows,
      memberships: (await db.query('select * from memberships order by user_id')).rows,
    });
    const before = await snapshot();
    expect(before.migrations.map((row) => row.version)).toEqual([
      '0001_workspaces_users_resources',
      '0002_renewal_requests',
      '0003_sessions',
    ]);

    expect(runDbScript('db-migrate')).toContain('новых миграций нет');
    runDbScript('db-seed');
    runDbScript('db-migrate');

    expect(await snapshot()).toEqual(before);
  });
});
