/**
 * Who can see what, who can write what.
 *   - RLS: members read only their own company's data, gated by role permissions
 *   - privileges: signed-in users are read-only; only the trusted server writes the books
 *   - a privilege audit that fails the build if a future migration forgets to lock a new table/function
 *   - the permission matrix (owner / accountant / clerk / viewer / outsider) through the posting service
 */
import { PostgresBackend } from '@minimalerp/adapter-postgres';
import { IssueCode } from '@minimalerp/domain';
import { journal, payment, receipt, contra, mustOk, codesOf } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgWorld, addMember, pgWorldFactory } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let a: PgWorld; // company A
let b: PgWorld; // company B (must never leak into A)
const users = {
  accountant: randomUUID(),
  clerk: randomUUID(),
  viewer: randomUUID(),
  outsider: randomUUID(), // signed up, member of nothing
};

const TABLES = [
  'companies', 'app_roles', 'role_permissions', 'company_members', 'financial_years', 'account_groups',
  'ledgers', 'voucher_types', 'numbering_series', 'vouchers', 'journal_lines', 'voucher_revisions', 'audit_log',
] as const;
const COMPANY_TABLES = TABLES.filter((t) => !['companies', 'app_roles', 'role_permissions'].includes(t));

const backendFor = (world: PgWorld, actorId: string) => new PostgresBackend(db.pool, { actorId });

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  const make = pgWorldFactory(db);
  a = await make();
  b = await make();
  await addMember(db.pool, a.companyId, users.accountant, 'accountant');
  await addMember(db.pool, a.companyId, users.clerk, 'clerk');
  await addMember(db.pool, a.companyId, users.viewer, 'viewer');
  await db.pool.query(`insert into auth.users (id, email) values ($1, 'outsider@example.test')`, [users.outsider]);

  // give every table some rows in both companies
  for (const world of [a, b]) {
    mustOk(await world.backend.post({ companyId: world.companyId, draft: payment(world, { id: 'seed-p', date: '2024-05-10', account: world.ledgers.bank, lines: [[world.ledgers.rent, '100']] }).voucher }));
    const j = mustOk(await world.backend.post({ companyId: world.companyId, draft: journal(world, { id: 'seed-j', date: '2024-05-11', entries: [[world.ledgers.rent, 'debit', '5'], [world.ledgers.creditor, 'credit', '5']] }).voucher }));
    mustOk(await world.backend.alter({ companyId: world.companyId, voucherId: j.voucher.id, expectedVersion: 1, draft: journal(world, { id: 'seed-j', date: '2024-05-11', entries: [[world.ledgers.rent, 'debit', '6'], [world.ledgers.creditor, 'credit', '6']] }).voucher }));
  }
});
afterAll(async () => {
  await db?.close();
});

const asUser = <T>(userId: string, fn: (q: (sql: string, v?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>) =>
  db.asRole('authenticated', userId, (c) => fn(async (sql, v) => (await c.query(sql, v)).rows));

const visibleRows = (userId: string, table: string, where = 'true') =>
  asUser(userId, async (q) => Number((await q(`select count(*)::int as n from public.${table} where ${where}`))[0]?.['n']));

describe('RLS: what a signed-in user can read', () => {
  it('the service (superuser) really did write rows to every table — so the checks below mean something', async () => {
    for (const t of TABLES) {
      const n = Number((await db.pool.query(`select count(*)::int as n from public.${t}`)).rows[0].n);
      expect(n, `table ${t} should have rows`).toBeGreaterThan(0);
    }
  });

  it('an owner sees their own company in every table', async () => {
    for (const t of COMPANY_TABLES) {
      expect(await visibleRows(a.ownerId, t, `company_id = '${a.companyId}'`), t).toBeGreaterThan(0);
    }
  });

  it.each(COMPANY_TABLES)('nobody sees another company’s rows in %s', async (t) => {
    for (const userId of [a.ownerId, users.accountant, users.clerk, users.viewer]) {
      expect(await visibleRows(userId, t, `company_id = '${b.companyId}'`), `${t} as ${userId}`).toBe(0);
    }
  });

  it('a signed-in user who belongs to no company sees nothing at all', async () => {
    for (const t of COMPANY_TABLES.filter((x) => x !== 'company_members')) {
      expect(await visibleRows(users.outsider, t), t).toBe(0);
    }
    expect(await visibleRows(users.outsider, 'companies')).toBe(0);
    expect(await visibleRows(users.outsider, 'company_members')).toBe(0);
  });

  it('every role can read ledgers, vouchers and the journal', async () => {
    for (const userId of [a.ownerId, users.accountant, users.clerk, users.viewer]) {
      for (const t of ['ledgers', 'vouchers', 'journal_lines', 'voucher_revisions']) {
        expect(await visibleRows(userId, t), `${t} as ${userId}`).toBeGreaterThan(0);
      }
    }
  });

  it('the audit log is visible only to roles holding audit.view (owner, accountant)', async () => {
    expect(await visibleRows(a.ownerId, 'audit_log')).toBeGreaterThan(0);
    expect(await visibleRows(users.accountant, 'audit_log')).toBeGreaterThan(0);
    expect(await visibleRows(users.clerk, 'audit_log')).toBe(0);
    expect(await visibleRows(users.viewer, 'audit_log')).toBe(0);
  });

  it('members see their own membership; only owners see the whole team', async () => {
    expect(await visibleRows(users.clerk, 'company_members')).toBe(1);
    expect(await visibleRows(users.viewer, 'company_members')).toBe(1);
    expect(await visibleRows(a.ownerId, 'company_members')).toBe(4); // owner + accountant + clerk + viewer
  });

  it('role and permission definitions are readable reference data', async () => {
    expect(await visibleRows(users.viewer, 'app_roles')).toBe(5); // owner, accountant, clerk, viewer and the add-on's automation (ADR-0023)
    expect(await visibleRows(users.viewer, 'role_permissions')).toBeGreaterThan(20);
  });

  it('with no user at all (anon) nothing is readable — permission is denied outright', async () => {
    for (const t of TABLES) {
      const err = await db.asRole('anon', null, async (c) => c.query(`select 1 from public.${t}`)).catch((e) => e);
      expect(err, t).toMatchObject({ code: '42501' });
    }
  });
});

describe('privileges: nobody but the server can write', () => {
  const denied = (role: 'anon' | 'authenticated', userId: string | null, sql: string) =>
    db.asRole(role, userId, async (c) => c.query(sql)).then(() => undefined, (e: { code?: string }) => e.code);

  it.each(TABLES)('a signed-in user cannot INSERT into %s', async (t) => {
    expect(await denied('authenticated', a.ownerId, `insert into public.${t} default values`)).toBe('42501');
  });

  it.each(TABLES)('a signed-in user cannot UPDATE %s', async (t) => {
    const col = t === 'app_roles' ? 'role' : t === 'role_permissions' ? 'role' : 'company_id';
    const set = t === 'companies' ? 'id = id' : `${col} = ${col}`;
    expect(await denied('authenticated', a.ownerId, `update public.${t} set ${set}`)).toBe('42501');
  });

  it.each(TABLES)('a signed-in user cannot DELETE from or TRUNCATE %s', async (t) => {
    expect(await denied('authenticated', a.ownerId, `delete from public.${t}`)).toBe('42501');
    expect(await denied('authenticated', a.ownerId, `truncate public.${t} cascade`)).toBe('42501');
  });

  it.each(TABLES)('anon cannot write %s either', async (t) => {
    expect(await denied('anon', null, `insert into public.${t} default values`)).toBe('42501');
  });

  it('even an owner cannot grant themselves access by editing membership', async () => {
    const sql = `insert into public.company_members (company_id, user_id, role) values ('${a.companyId}', '${users.outsider}', 'owner')`;
    expect(await denied('authenticated', a.ownerId, sql)).toBe('42501');
  });

  // SQL is built lazily: the worlds exist only after beforeAll.
  const rpcs: readonly (readonly [string, () => string])[] = [
    ['post_voucher_atomic', () => `select public.post_voucher_atomic('${randomUUID()}', '${a.companyId}', null, '{}', '[]')`],
    ['alter_voucher_atomic', () => `select public.alter_voucher_atomic('${randomUUID()}', '${a.companyId}', null, '${randomUUID()}', 1, '{}', '[]')`],
    ['cancel_voucher_atomic', () => `select public.cancel_voucher_atomic('${randomUUID()}', '${a.companyId}', null, '${randomUUID()}', 1)`],
    ['load_masters_json', () => `select public.load_masters_json('${a.companyId}')`],
    ['load_ledgers_json', () => `select public.load_ledgers_json('${a.companyId}', null)`],
    ['master_apply', () => `select public.master_apply('${randomUUID()}', '${a.companyId}', null, 0, '{}')`],
    ['company_seed', () => `select public.company_seed('${randomUUID()}', null, '{}')`],
    ['master_usage_json', () => `select public.master_usage_json('${a.companyId}', '${randomUUID()}')`],
    ['actor_can', () => `select public.actor_can('${a.ownerId}', '${a.companyId}', 'voucher.payment.post')`],
    ['private.actor_has_permission', () => `select private.actor_has_permission('${a.ownerId}', '${a.companyId}', 'voucher.payment.post')`],
    ['private.assert_voucher_consistent', () => `select private.assert_voucher_consistent('${randomUUID()}')`],
  ];
  it.each(rpcs)('a signed-in user cannot execute %s', async (_name, sql) => {
    expect(await denied('authenticated', a.ownerId, sql())).toBe('42501');
  });
  it.each(rpcs)('anon cannot execute %s', async (_name, sql) => {
    expect(await denied('anon', null, sql())).toBe('42501');
  });
});

describe('privilege audit — fails if a future migration adds a table or function and forgets to lock it', () => {
  it('every table in public has row-level security enabled', async () => {
    const r = await db.pool.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual([]);
  });

  it('signed-in users hold SELECT and nothing else on any public table; anon holds nothing', async () => {
    const r = await db.pool.query(
      `select grantee, table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')
          and not (grantee = 'authenticated' and privilege_type = 'SELECT')`,
    );
    expect(r.rows).toEqual([]);
  });

  it('every table has an RLS SELECT policy for signed-in users (otherwise the grant would expose nothing or everything)', async () => {
    const r = await db.pool.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.cmd = 'SELECT')
        order by 1`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual([]);
  });

  it('no policy permits writes', async () => {
    const r = await db.pool.query(`select tablename, policyname, cmd from pg_policies where schemaname = 'public' and cmd <> 'SELECT'`);
    expect(r.rows).toEqual([]);
  });

  it('no function in public or private is executable by anon or signed-in users, except the two RLS helpers and search', async () => {
    const r = await db.pool.query(
      `select n.nspname || '.' || p.proname as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.prokind = 'f'
          and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
        order by 1`,
    );
    // search_entities is deliberately callable by members: row-level security on search_index decides what it returns.
    expect(r.rows.map((x) => x.fn)).toEqual(['private.has_permission', 'private.is_member', 'public.search_entities']);
  });

  it('the posting functions are executable by service_role, so the server can do its job', async () => {
    const r = await db.pool.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('post_voucher_atomic', 'alter_voucher_atomic', 'cancel_voucher_atomic')
          and not has_function_privilege('service_role', p.oid, 'execute')`,
    );
    expect(r.rows).toEqual([]);
  });
});

describe('permissions: the role matrix, through the posting service', () => {
  let n = 0;
  const id = () => `perm-${++n}`;
  const world = () => a;

  const draftOf = (kind: 'payment' | 'receipt' | 'contra' | 'journal', vid = id()) => {
    const w = world();
    const L = w.ledgers;
    switch (kind) {
      case 'payment': return payment(w, { id: vid, date: '2024-05-10', account: L.bank, lines: [[L.rent, '10']] });
      case 'receipt': return receipt(w, { id: vid, date: '2024-05-10', account: L.bank, lines: [[L.debtor, '10']] });
      case 'contra': return contra(w, { id: vid, date: '2024-05-10', account: L.bank, lines: [[L.cash, '10']] });
      case 'journal': return journal(w, { id: vid, date: '2024-05-10', entries: [[L.rent, 'debit', '10'], [L.creditor, 'credit', '10']] });
    }
  };
  const tryPost = async (actor: string, kind: Parameters<typeof draftOf>[0]) =>
    backendFor(a, actor).post({ companyId: a.companyId, draft: draftOf(kind).voucher });

  it.each([
    ['owner', () => a.ownerId, ['payment', 'receipt', 'contra', 'journal']],
    ['accountant', () => users.accountant, ['payment', 'receipt', 'contra', 'journal']],
    ['clerk', () => users.clerk, ['payment', 'receipt', 'contra']],
    ['viewer', () => users.viewer, []],
    ['outsider', () => users.outsider, []],
  ] as const)('%s may post exactly: %j', async (_role, actor, allowed) => {
    for (const kind of ['payment', 'receipt', 'contra', 'journal'] as const) {
      const r = await tryPost(actor(), kind);
      if ((allowed as readonly string[]).includes(kind)) mustOk(r);
      else expect(codesOf(r), `${_role} posting ${kind}`).toEqual([IssueCode.PermissionDenied]);
    }
  });

  it('a clerk can post but can neither alter nor cancel — even their own voucher', async () => {
    const draft = draftOf('payment', 'clerk-own');
    const posted = mustOk(await backendFor(a, users.clerk).post({ companyId: a.companyId, draft: draft.voucher }));

    const alter = await backendFor(a, users.clerk).alter({ companyId: a.companyId, voucherId: posted.voucher.id, expectedVersion: 1, draft: draft.voucher });
    expect(codesOf(alter)).toEqual([IssueCode.PermissionDenied]);
    const cancel = await backendFor(a, users.clerk).cancel({ companyId: a.companyId, voucherId: posted.voucher.id, expectedVersion: 1 });
    expect(codesOf(cancel)).toEqual([IssueCode.PermissionDenied]);

    // the accountant can
    mustOk(await backendFor(a, users.accountant).cancel({ companyId: a.companyId, voucherId: posted.voucher.id, expectedVersion: 1 }));
  });

  it('membership of company A grants nothing in company B', async () => {
    const draft = payment(b, { id: 'cross', date: '2024-05-10', account: b.ledgers.bank, lines: [[b.ledgers.rent, '10']] });
    for (const actor of [users.accountant, users.clerk]) {
      const r = await backendFor(b, actor).post({ companyId: b.companyId, draft: draft.voucher });
      expect(codesOf(r)).toEqual([IssueCode.PermissionDenied]);
    }
  });

  it('a refused post leaves no trace: no voucher, no journal, no audit row, no number consumed', async () => {
    const before = async () => ({
      vouchers: Number((await db.pool.query('select count(*)::int n from public.vouchers where company_id = $1', [a.companyId])).rows[0].n),
      lines: Number((await db.pool.query('select count(*)::int n from public.journal_lines where company_id = $1', [a.companyId])).rows[0].n),
      audit: Number((await db.pool.query('select count(*)::int n from public.audit_log where company_id = $1', [a.companyId])).rows[0].n),
      next: (await db.pool.query(`select string_agg(next_value::text, ',' order by id) s from public.numbering_series where company_id = $1`, [a.companyId])).rows[0].s,
    });
    const snapshot = await before();
    codesOf(await tryPost(users.viewer, 'payment'));
    codesOf(await tryPost(users.clerk, 'journal'));
    expect(await before()).toEqual(snapshot);
  });

  describe('defence in depth: the SQL functions check permission themselves', () => {
    const payload = (kind: 'journal' | 'payment') => {
      const w = a;
      return {
        voucher: JSON.stringify({
          id: randomUUID(), voucher_type_id: w.types[kind], financial_year_id: w.fy2425.id, date: '2024-05-10', content: {},
        }),
        journal: JSON.stringify([
          { ledger_id: w.ledgers.rent, side: 'debit', amount: '10.00', narration: null },
          { ledger_id: w.ledgers.creditor, side: 'credit', amount: '10.00', narration: null },
        ]),
      };
    };
    const call = (actor: string, kind: 'journal' | 'payment') =>
      db.pool
        .query(`select public.post_voucher_atomic($1, $2, null, $3::jsonb, $4::jsonb)`, [actor, a.companyId, payload(kind).voucher, payload(kind).journal])
        .then(() => undefined, (e: { message: string }) => e.message);

    it('a clerk cannot post a journal even by calling the function directly', async () => {
      expect(await call(users.clerk, 'journal')).toBe('PERMISSION_DENIED');
    });
    it('a non-member cannot post anything by calling the function directly', async () => {
      expect(await call(users.outsider, 'payment')).toBe('PERMISSION_DENIED');
    });
    it('a member with the permission can (the check is not simply always failing)', async () => {
      expect(await call(users.accountant, 'journal')).toBeUndefined();
    });
  });
});
