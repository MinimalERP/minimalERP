/**
 * What only the database can promise about master data:
 *   - the search index is written in the SAME transaction as the change (never stale, never orphaned)
 *   - search finds things by name, identifier and typo, ranks sensibly, and respects row-level security
 *   - the new tables are locked down exactly like the old ones (members read, nobody else, nobody writes)
 *   - the backstop triggers refuse what the application already refuses, even for a direct write
 *   - master changes serialise: unrelated changes made at once all succeed, conflicting ones do not both
 *   - the Edge Function handler accepts master commands
 */
import { PostgresBackend, createPostingHandler } from '@minimalerp/adapter-postgres';
import { IssueCode } from '@minimalerp/domain';
import { codesOf, mustOk } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { addMember } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let a: PgMasterWorld;
let b: PgMasterWorld;
const users = { accountant: randomUUID(), clerk: randomUUID(), viewer: randomUUID(), outsider: randomUUID() };

const NEW_TABLES = ['parties', 'units', 'stock_groups', 'stock_items', 'warehouses', 'gst_rates', 'search_index'] as const;

const run = (w: PgMasterWorld, op: 'create' | 'alter' | 'setActive' | 'advanceSeries', kind: string, id: string, data?: unknown, active?: boolean, actor = w.ownerId) =>
  new PostgresBackend(db.pool, { actorId: actor }).execute({
    companyId: w.companyId,
    command: { op, kind, id, ...(data === undefined ? {} : { data }), ...(active === undefined ? {} : { active }) },
  });
const create = (w: PgMasterWorld, kind: string, name: string, data: unknown) => run(w, 'create', kind, w.uuid(`db:${name}`), data);
const group = (w: PgMasterWorld, key: string) => w.uuid(`group:${key}`);
const asUser = <T>(userId: string, fn: (q: (sql: string, v?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>) =>
  db.asRole('authenticated', userId, (c) => fn(async (sql, v) => (await c.query(sql, v)).rows));

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  const make = pgMasterWorldFactory(db);
  a = await make();
  b = await make();
  await addMember(db.pool, a.companyId, users.accountant, 'accountant');
  await addMember(db.pool, a.companyId, users.clerk, 'clerk');
  await addMember(db.pool, a.companyId, users.viewer, 'viewer');
  await db.pool.query(`insert into auth.users (id, email) values ($1, 'outsider@example.test')`, [users.outsider]);

  for (const w of [a, b]) {
    mustOk(await create(w, 'party', 'abc-party', { name: 'ABC Industries', gstin: '27AAPFU0939F1ZV', phone: '9820012345', address: 'Pune' }));
    mustOk(await create(w, 'ledger', 'abc-ledger', { name: 'ABC Industries', groupId: group(w, 'sundry-debtors'), code: 'D001', alias: 'ABC' }));
    mustOk(await create(w, 'stockGroup', 'raw', { name: 'Raw Material' }));
    mustOk(await create(w, 'stockItem', 'abc-bolt', { name: 'ABC Hex Bolt M8', code: 'FG-BL-M8', unitId: w.uuid('unit:Nos'), itemType: 'finished', hsn: '7318', gstRateId: w.uuid('gst:18') }));
    mustOk(await create(w, 'stockItem', 'sheet', { name: 'MS Sheet 2mm', code: 'RM-SH-2', groupId: w.uuid('db:raw'), unitId: w.uuid('unit:Kg'), itemType: 'raw', hsn: '7208' }));
    mustOk(await create(w, 'warehouse', 'scrap', { name: 'Scrap Yard' }));
  }
});
afterAll(async () => {
  await db?.close();
});

describe('a seeded company reads back exactly as the domain made it', () => {
  it('every master survives seed → database → load unchanged', async () => {
    const fresh = await pgMasterWorldFactory(db)();
    const loaded = await fresh.backend.load(fresh.companyId);
    const seed = fresh.seed;
    const names = <T extends { name: string }>(xs: readonly T[]) => xs.map((x) => x.name).sort();
    expect(loaded.company).toMatchObject({ name: seed.company.name });
    expect(names(loaded.groups.all)).toEqual(names(seed.groups.all));
    expect(names(loaded.ledgers)).toEqual(names(seed.ledgers));
    expect(names(loaded.voucherTypes)).toEqual(names(seed.voucherTypes));
    expect(loaded.gstRates.map((r) => r.ratePercent).sort()).toEqual(seed.gstRates.map((r) => r.ratePercent).sort()); // '18' stays '18'
    expect(loaded.units.map((u) => u.symbol).sort()).toEqual(seed.units.map((u) => u.symbol).sort());
    expect(loaded.series).toHaveLength(seed.series.length);
    expect(loaded.openingDifferenceLedger()?.reservedKey).toBe('opening-difference');
    expect(loaded.financialYears[0]).toMatchObject({ start: seed.financialYears[0]?.start, end: seed.financialYears[0]?.end });
  });

  it('a party round-trips with its GSTIN, credit terms and exact credit limit', async () => {
    mustOk(await create(a, 'party', 'terms', { name: 'Terms Co', creditDays: 45, creditLimit: '123456.70', stateCode: '27' }));
    const p = (await a.backend.load(a.companyId)).parties.find((x) => x.name === 'Terms Co');
    expect(p).toMatchObject({ creditDays: 45, creditLimit: 12345670n, stateCode: '27' });
  });

  it('a compound unit and a GST rate keep their exact decimal text', async () => {
    mustOk(await create(a, 'unit', 'qtl', { symbol: 'Qtl', name: 'Quintal', decimals: 2, baseUnitId: a.uuid('unit:Kg'), factor: '100' }));
    mustOk(await create(a, 'gstRate', 'r125', { name: 'GST 12.5%', ratePercent: '12.5', cessPercent: '1.25', effectiveFrom: '2024-04-01' }));
    const m = await a.backend.load(a.companyId);
    expect(m.units.find((u) => u.symbol === 'Qtl')).toMatchObject({ factor: '100', decimals: 2 });
    expect(m.gstRates.find((r) => r.name === 'GST 12.5%')).toMatchObject({ ratePercent: '12.5', cessPercent: '1.25' });
  });
});

describe('the search index is part of the same transaction', () => {
  const indexed = async (w: PgMasterWorld, type: string, id: string) =>
    (await db.pool.query('select title, subtitle, identifiers, is_active from public.search_index where company_id = $1 and entity_type = $2 and entity_id = $3', [w.companyId, type, id])).rows[0];

  it('a created master is indexed the moment it exists, with its identifiers', async () => {
    const row = await indexed(a, 'party', a.uuid('db:abc-party'));
    expect(row).toMatchObject({ title: 'ABC Industries', is_active: true });
    expect(row.identifiers).toContain('27AAPFU0939F1ZV');
    expect(row.identifiers).toContain('9820012345');
    expect((await indexed(a, 'item', a.uuid('db:abc-bolt'))).identifiers).toContain('FG-BL-M8');
  });

  it('an alter and a deactivate are reflected immediately', async () => {
    mustOk(await create(a, 'ledger', 'rename-me', { name: 'Old Name', groupId: group(a, 'indirect-expenses') }));
    mustOk(await run(a, 'alter', 'ledger', a.uuid('db:rename-me'), { name: 'New Name', groupId: group(a, 'indirect-expenses') }));
    expect((await indexed(a, 'ledger', a.uuid('db:rename-me'))).title).toBe('New Name');
    mustOk(await run(a, 'setActive', 'ledger', a.uuid('db:rename-me'), undefined, false));
    expect((await indexed(a, 'ledger', a.uuid('db:rename-me'))).is_active).toBe(false);
  });

  it('a change that is rolled back leaves no index row behind', async () => {
    const id = randomUUID();
    const c = await db.connect();
    try {
      await c.query('begin');
      await c.query(`insert into public.parties (id, company_id, name) values ($1, $2, 'Phantom Ltd')`, [id, a.companyId]);
      expect((await c.query('select 1 from public.search_index where entity_id = $1', [id])).rowCount).toBe(1); // visible inside
      await c.query('rollback');
    } finally {
      c.release();
    }
    expect(await indexed(a, 'party', id)).toBeUndefined();
  });

  it('a refused master command leaves no index row either', async () => {
    const before = Number((await db.pool.query('select count(*)::int n from public.search_index where company_id = $1', [a.companyId])).rows[0].n);
    codesOf(await create(a, 'party', 'dup', { name: 'abc industries' })); // name taken
    const after = Number((await db.pool.query('select count(*)::int n from public.search_index where company_id = $1', [a.companyId])).rows[0].n);
    expect(after).toBe(before);
  });

  it('every master in the database has an index row (nothing is missing)', async () => {
    const missing = await db.pool.query(
      `select 'ledger' t, l.id from public.ledgers l where not exists (select 1 from public.search_index s where s.entity_id = l.id)
       union all select 'party', p.id from public.parties p where not exists (select 1 from public.search_index s where s.entity_id = p.id)
       union all select 'item', i.id from public.stock_items i where not exists (select 1 from public.search_index s where s.entity_id = i.id)
       union all select 'group', g.id from public.account_groups g where not exists (select 1 from public.search_index s where s.entity_id = g.id)`,
    );
    expect(missing.rows).toEqual([]);
  });
});

describe('search_entities', () => {
  const search = (userId: string, company: string, q: string, types: string[] | null = null) =>
    asUser(userId, (query) => query('select entity_type, title, score from public.search_entities($1::uuid, $2, $3::text[], 30)', [company, q, types]));

  it('finds a ledger, a party and an item for the same word', async () => {
    const hits = await search(a.ownerId, a.companyId, 'abc');
    expect(new Set(hits.map((h) => h.entity_type))).toEqual(new Set(['ledger', 'party', 'item']));
  });

  it('narrows by type', async () => {
    expect((await search(a.ownerId, a.companyId, 'abc', ['party'])).map((h) => h.entity_type)).toEqual(['party']);
  });

  it.each([
    ['27AAPFU0939F1ZV', 'party'],
    ['9820012345', 'party'],
    ['FG-BL-M8', 'item'],
    ['7318', 'item'],
    ['D001', 'ledger'],
  ])('finds by identifier %s, and puts it first', async (q, type) => {
    const hits = await search(a.ownerId, a.companyId, q);
    expect(hits[0]?.entity_type).toBe(type);
  });

  it('finds a prefix of a name, a word inside it, and a typo', async () => {
    expect((await search(a.ownerId, a.companyId, 'hex')).map((h) => h.title)).toContain('ABC Hex Bolt M8');
    expect((await search(a.ownerId, a.companyId, 'sheet')).map((h) => h.title)).toContain('MS Sheet 2mm');
    expect((await search(a.ownerId, a.companyId, 'industrys')).map((h) => h.title)).toContain('ABC Industries');
  });

  it('ranks an exact name above a longer one', async () => {
    const hits = await search(a.ownerId, a.companyId, 'abc industries', ['party', 'ledger']);
    expect(hits.map((h) => h.title).slice(0, 2)).toEqual(['ABC Industries', 'ABC Industries']);
  });

  it('inactive records are still found, ranked below active ones', async () => {
    mustOk(await create(a, 'ledger', 'old-abc', { name: 'Old ABC Traders', groupId: group(a, 'sundry-debtors') }));
    mustOk(await run(a, 'setActive', 'ledger', a.uuid('db:old-abc'), undefined, false));
    const hits = await search(a.ownerId, a.companyId, 'abc', ['ledger']);
    expect(hits.map((h) => h.title)).toEqual(expect.arrayContaining(['ABC Industries', 'Old ABC Traders']));
    expect(hits.findIndex((h) => h.title === 'Old ABC Traders')).toBeGreaterThan(hits.findIndex((h) => h.title === 'ABC Industries'));
  });

  it('every member role can search; an outsider and another company’s members find nothing', async () => {
    for (const user of [a.ownerId, users.accountant, users.clerk, users.viewer]) {
      expect((await search(user, a.companyId, 'abc')).length, user).toBeGreaterThan(0);
    }
    expect(await search(users.outsider, a.companyId, 'abc')).toEqual([]);
    expect(await search(b.ownerId, a.companyId, 'abc')).toEqual([]); // b's owner has no access to a
    expect((await search(b.ownerId, b.companyId, 'abc')).length).toBeGreaterThan(0);
  });

  it('a punctuation-only or empty query matches nothing (not everything)', async () => {
    expect(await search(a.ownerId, a.companyId, '   ')).toEqual([]);
    expect(await search(a.ownerId, a.companyId, '&&&')).toEqual([]);
  });

  it('is safe against wildcard and injection characters', async () => {
    for (const q of ["%", "_", "'; drop table public.ledgers; --", '\\']) {
      await expect(search(a.ownerId, a.companyId, q)).resolves.toBeInstanceOf(Array);
    }
    expect(Number((await db.pool.query('select count(*)::int n from public.ledgers')).rows[0].n)).toBeGreaterThan(0);
  });

  it('answers quickly on a large company (benchmark: 5,000 records)', async () => {
    const w = await pgMasterWorldFactory(db)();
    await db.pool.query(
      `insert into public.parties (id, company_id, name, gstin, phone)
       select gen_random_uuid(), $1, 'Customer ' || g || ' Trading Company', null, '98' || lpad(g::text, 8, '0') from generate_series(1, 5000) g`,
      [w.companyId],
    );
    const t0 = performance.now();
    const hits = await search(w.ownerId, w.companyId, 'customer 4999 trad');
    const ms = performance.now() - t0;
    expect(hits[0]?.title).toBe('Customer 4999 Trading Company');
    expect(ms).toBeLessThan(1500);
  });
});

describe('the new tables are locked down like the old ones', () => {
  const visible = (userId: string, table: string, where = 'true') =>
    asUser(userId, async (q) => Number((await q(`select count(*)::int as n from public.${table} where ${where}`))[0]?.['n']));

  it.each(NEW_TABLES)('members of the company read %s', async (t) => {
    for (const user of [a.ownerId, users.accountant, users.clerk, users.viewer]) {
      expect(await visible(user, t, `company_id = '${a.companyId}'`), `${t} as ${user}`).toBeGreaterThan(0);
    }
  });

  it.each(NEW_TABLES)('nobody sees another company’s rows in %s, and an outsider sees none', async (t) => {
    expect(await visible(a.ownerId, t, `company_id = '${b.companyId}'`)).toBe(0);
    expect(await visible(users.outsider, t)).toBe(0);
  });

  const denied = (role: 'anon' | 'authenticated', userId: string | null, sql: string) =>
    db.asRole(role, userId, async (c) => c.query(sql)).then(() => undefined, (e: { code?: string }) => e.code);

  it.each(NEW_TABLES)('a signed-in user cannot write %s (insert, update, delete)', async (t) => {
    expect(await denied('authenticated', a.ownerId, `insert into public.${t} default values`)).toBe('42501');
    expect(await denied('authenticated', a.ownerId, `update public.${t} set company_id = company_id`)).toBe('42501');
    expect(await denied('authenticated', a.ownerId, `delete from public.${t}`)).toBe('42501');
  });

  it.each(NEW_TABLES)('anon can read nothing from %s', async (t) => {
    expect(await denied('anon', null, `select 1 from public.${t}`)).toBe('42501');
  });

  it('a signed-in user cannot change masters through the SQL functions either', async () => {
    for (const sql of [
      `select public.master_apply('${a.ownerId}', '${a.companyId}', null, 0, '{}')`,
      `select public.company_seed('${a.ownerId}', null, '{}')`,
    ]) {
      expect(await denied('authenticated', a.ownerId, sql)).toBe('42501');
    }
  });
});

describe('permissions: who may change masters', () => {
  const as = (w: PgMasterWorld, actor: string, name: string) =>
    run(w, 'create', 'unit', w.uuid(`perm:${name}`), { symbol: name.toUpperCase().slice(0, 6), name }, undefined, actor);

  it('owners and accountants may; clerks, viewers and outsiders may not', async () => {
    mustOk(await as(a, a.ownerId, 'ownerunit'));
    mustOk(await as(a, users.accountant, 'acctunit'));
    for (const [who, actor] of [['clerk', users.clerk], ['viewer', users.viewer], ['outsider', users.outsider]] as const) {
      expect(codesOf(await as(a, actor, `${who}unit`)), who).toEqual([IssueCode.PermissionDenied]);
    }
  });

  it('membership of company A gives no power over company B', async () => {
    expect(codesOf(await as(b, users.accountant, 'crossunit'))).toEqual([IssueCode.PermissionDenied]);
  });

  it('a refused change leaves no trace: no row, no audit entry, no version bump', async () => {
    const state = async () => ({
      units: Number((await db.pool.query('select count(*)::int n from public.units where company_id = $1', [a.companyId])).rows[0].n),
      audit: Number((await db.pool.query('select count(*)::int n from public.audit_log where company_id = $1', [a.companyId])).rows[0].n),
      version: (await db.pool.query('select masters_version::text v from public.companies where id = $1', [a.companyId])).rows[0].v,
    });
    const before = await state();
    codesOf(await as(a, users.viewer, 'nope'));
    expect(await state()).toEqual(before);
  });

  it('every successful change is audited with before and after', async () => {
    mustOk(await create(a, 'warehouse', 'audited', { name: 'Audited Store' }));
    mustOk(await run(a, 'alter', 'warehouse', a.uuid('db:audited'), { name: 'Audited Store 2' }));
    const rows = (await db.pool.query(
      `select action, before, after from public.audit_log where company_id = $1 and entity_id = $2 order by id`,
      [a.companyId, a.uuid('db:audited')],
    )).rows;
    expect(rows.map((r) => r.action)).toEqual(['master.create', 'master.alter']);
    expect(rows[0].before).toBeNull();
    expect(rows[1].before.name).toBe('Audited Store');
    expect(rows[1].after.name).toBe('Audited Store 2');
  });
});

describe('backstop triggers: the database refuses what the rules refuse, even for a direct write', () => {
  const rejected = (sql: string, values: unknown[] = []) =>
    db.pool.query(sql, values).then(() => undefined, (e: { message?: string }) => e.message);

  it('the built-in ledger, groups and voucher types cannot be renamed, moved or deactivated', async () => {
    expect(await rejected(`update public.ledgers set name = 'Hacked' where company_id = $1 and reserved_key = 'opening-difference'`, [a.companyId])).toBe('SYSTEM_MASTER_LOCKED');
    expect(await rejected(`update public.ledgers set is_active = false where company_id = $1 and reserved_key = 'opening-difference'`, [a.companyId])).toBe('SYSTEM_MASTER_LOCKED');
    expect(await rejected(`update public.account_groups set name = 'Hacked' where id = $1`, [group(a, 'sales-accounts')])).toBe('SYSTEM_MASTER_LOCKED');
    expect(await rejected(`update public.voucher_types set name = 'Hacked' where id = $1`, [a.uuid('type:payment')])).toBe('SYSTEM_MASTER_LOCKED');
  });

  it('an ordinary ledger and group can still be changed', async () => {
    mustOk(await create(a, 'ledger', 'plain', { name: 'Plain Ledger', groupId: group(a, 'indirect-expenses') }));
    expect(await rejected(`update public.ledgers set name = 'Plain Ledger 2' where id = $1`, [a.uuid('db:plain')])).toBeUndefined();
  });

  it('a ledger with entries cannot move to a group of another nature', async () => {
    mustOk(await create(a, 'ledger', 'moving', { name: 'Moving Ledger', groupId: group(a, 'cash-in-hand') }));
    mustOk(
      await a.backend.post({
        companyId: a.companyId,
        draft: { id: a.uuid('db:ob-moving'), voucherTypeId: a.uuid('type:opening'), date: '2024-04-01', ledgerId: a.uuid('db:moving'), side: 'debit', amount: '10', offsetLedgerId: a.uuid('ledger:opening-difference') },
      }),
    );
    expect(await rejected(`update public.ledgers set group_id = $2 where id = $1`, [a.uuid('db:moving'), group(a, 'indirect-expenses')])).toBe('NATURE_LOCKED');
    expect(await rejected(`update public.ledgers set group_id = $2 where id = $1`, [a.uuid('db:moving'), group(a, 'bank-accounts')])).toBeUndefined(); // asset → asset
  });

  it('a series and a voucher type in use keep their start number and base kind', async () => {
    expect(await rejected(`update public.numbering_series set start_at = 99 where company_id = $1 and voucher_type_id = $2`, [a.companyId, a.uuid('type:opening')])).toBe('IN_USE');
    expect(await rejected(`update public.voucher_types set base_kind = 'journal' where id = $1`, [a.uuid('type:opening')])).toBe('IN_USE'); // vouchers use it
    expect(await rejected(`update public.voucher_types set base_kind = 'journal' where id = $1`, [a.uuid('type:payment')])).toBe('SYSTEM_MASTER_LOCKED'); // unused, but built in
  });

  it('the schema itself refuses malformed masters', async () => {
    const bad = (sql: string) => rejected(sql, [a.companyId, randomUUID()]);
    expect(await bad(`insert into public.stock_items (id, company_id, name, unit_id, item_type) values ($2, $1, 'X', gen_random_uuid(), 'raw')`)).toMatch(/foreign key/i); // unknown unit
    expect(await bad(`insert into public.gst_rates (id, company_id, name, rate_percent, effective_from) values ($2, $1, 'X', 101, '2024-04-01')`)).toMatch(/check/i);
    expect(await bad(`insert into public.units (id, company_id, symbol, name, base_unit_id, factor) values ($2, $1, 'Z', 'Z', null, 5)`)).toMatch(/check/i); // factor without base
    expect(await bad(`insert into public.stock_items (id, company_id, name, unit_id, item_type, hsn) select $2, $1, 'X', id, 'raw', '12' from public.units where company_id = $1 limit 1`)).toMatch(/check/i); // bad HSN
    expect(await bad(`insert into public.parties (id, company_id, name) values ($2, $1, 'ABC INDUSTRIES')`)).toMatch(/unique/i); // name, any case
  });

  it('a record can never reference another company’s master (composite foreign keys)', async () => {
    const r = await rejected(
      `insert into public.ledgers (id, company_id, name, group_id) values ($1, $2, 'Sneaky', $3)`,
      [randomUUID(), a.companyId, group(b, 'sundry-debtors')],
    );
    expect(r).toMatch(/foreign key/i);
  });
});

describe('master changes are serialised per company', () => {
  it('ten unrelated changes made at once all succeed', async () => {
    const w = await pgMasterWorldFactory(db)();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => run(w, 'create', 'warehouse', w.uuid(`par:${i}`), { name: `Store ${i}` })),
    );
    expect(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok))).toBe(true);
    expect((await w.backend.load(w.companyId)).warehouses.filter((x) => x.name.startsWith('Store '))).toHaveLength(10);
  });

  it('twelve racing changes to the same name: exactly one wins, and no error is a raw database error', async () => {
    const w = await pgMasterWorldFactory(db)();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => run(w, 'create', 'party', w.uuid(`race:${i}`), { name: 'Contested Name' })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(codesOf(r)).toEqual([IssueCode.NameTaken]);
    expect((await w.backend.load(w.companyId)).parties.filter((p) => p.name === 'Contested Name')).toHaveLength(1);
  });

  it('a stale command is refused by the database itself (defence in depth)', async () => {
    const w = await pgMasterWorldFactory(db)();
    const row = { id: w.uuid('stale:1'), company_id: w.companyId, name: 'Stale', parent_id: null, is_active: true };
    const call = (version: number) =>
      db.pool.query(`select public.master_apply($1::uuid, $2::uuid, null, $3::bigint, $4::jsonb)`, [
        w.ownerId, w.companyId, version, JSON.stringify({ kind: 'warehouse', op: 'create', id: row.id, row }),
      ]);
    await call(0);
    await expect(call(0)).rejects.toMatchObject({ message: 'MASTERS_CHANGED' });
  });
});

describe('the Edge Function handler takes master commands', () => {
  const handler = () =>
    createPostingHandler({
      authenticate: async (req) => {
        const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
        return m?.[1] ? { userId: m[1] } : undefined;
      },
      gatewayFor: (actorId, requestId) => new PostgresBackend(db.pool, { actorId, requestId }),
    });
  const call = (body: unknown, user: string | null = a.ownerId) =>
    handler()(
      new Request('http://localhost/functions/v1/post-voucher', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(user ? { authorization: `Bearer ${user}` } : {}) },
        body: JSON.stringify(body),
      }),
    );
  const create_ = (name: string, id = randomUUID()) => ({
    action: 'master', companyId: a.companyId, command: { op: 'create', kind: 'warehouse', id, data: { name } },
  });

  it('creates a master: 200 with the outcome', async () => {
    const res = await call(create_('Via HTTP'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; value: { kind: string; name: string; replayed: boolean } };
    expect(body).toMatchObject({ ok: true, value: { kind: 'warehouse', op: 'create', name: 'Via HTTP', replayed: false } });
  });

  it('a retry with the same id is a replay', async () => {
    const id = randomUUID();
    await call(create_('Retried', id));
    const again = (await (await call(create_('Retried', id))).json()) as { ok: true; value: { replayed: boolean } };
    expect(again.value.replayed).toBe(true);
  });

  it('a business refusal is a 200 with issues; not signed in is 401; a malformed body is 400', async () => {
    const refused = await call(create_('via http')); // name already taken above (any case)
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({ ok: false, issues: [{ code: 'NAME_TAKEN' }] });
    expect((await call(create_('No One'), null)).status).toBe(401);
    expect((await call({ action: 'master', companyId: a.companyId })).status).toBe(400); // no command
    expect((await call({ action: 'master' })).status).toBe(400);
    expect(await (await call({ action: 'master', companyId: a.companyId, command: 'nonsense' })).json()).toMatchObject({ ok: false, issues: [{ code: 'SCHEMA_INVALID' }] }); // bad command: an answer, not a crash
  });

  it('a clerk is refused with PERMISSION_DENIED', async () => {
    const res = await call(create_('Clerk Store'), users.clerk);
    expect(await res.json()).toMatchObject({ ok: false, issues: [{ code: 'PERMISSION_DENIED' }] });
  });
});

describe('Invoice / PDF Settings (company fields)', () => {
  const alterCompany = (data: Record<string, unknown>, actor: string) =>
    run(
      a,
      'alter',
      'company',
      a.companyId,
      {
        name: 'Acme Works',
        gstin: undefined,
        stateCode: undefined,
        address: undefined,
        chargeGst: undefined,
        ...data,
      },
      undefined,
      actor,
    );

  it('owner and accountant can set them; the fields round-trip through the real backend, unchanged fields untouched', async () => {
    const set = await alterCompany(
      {
        phone: '022-4000 0000',
        email: 'accounts@acme.test',
        bankName: 'HDFC Bank',
        bankAccountNo: '50200012345678',
        bankIfsc: 'HDFC0000123',
        bankBranch: 'Andheri East',
        invoiceNote: 'Thank you for your business.',
        invoiceTerms: 'Goods once sold will not be taken back.\n\nSubject to Mumbai jurisdiction.',
      },
      users.accountant,
    );
    expect(mustOk(set).replayed).toBe(false);

    const loaded = await new PostgresBackend(db.pool, { actorId: a.ownerId }).load(a.companyId as never);
    expect(loaded.company).toMatchObject({
      name: 'Acme Works', // untouched by this alter, still present
      phone: '022-4000 0000',
      email: 'accounts@acme.test',
      bankName: 'HDFC Bank',
      bankAccountNo: '50200012345678',
      bankIfsc: 'HDFC0000123',
      bankBranch: 'Andheri East',
      invoiceNote: 'Thank you for your business.',
      invoiceTerms: 'Goods once sold will not be taken back.\n\nSubject to Mumbai jurisdiction.',
    });
  });

  it('a field left blank stays blank — never defaulted to an empty string', async () => {
    await alterCompany({ phone: '', bankName: 'Kept Bank' }, a.ownerId);
    const loaded = await new PostgresBackend(db.pool, { actorId: a.ownerId }).load(a.companyId as never);
    expect(loaded.company.phone).toBeUndefined();
    expect(loaded.company.bankName).toBe('Kept Bank');
  });

  it('a clerk is refused with PERMISSION_DENIED, and nothing changes', async () => {
    const before = await new PostgresBackend(db.pool, { actorId: a.ownerId }).load(a.companyId as never);
    const res = await alterCompany({ phone: '999-999-9999' }, users.clerk);
    expect(codesOf(res)).toEqual([IssueCode.PermissionDenied]);
    const after = await new PostgresBackend(db.pool, { actorId: a.ownerId }).load(a.companyId as never);
    expect(after.company.phone).toBe(before.company.phone);
  });
});

describe('the manual next-number override (ADR-0021)', () => {
  const nextValueOf = async (seriesId: string) =>
    Number((await db.pool.query('select next_value::text v from public.numbering_series where id = $1', [seriesId])).rows[0].v);
  const openingSeries = (w: PgMasterWorld) => w.seed.series.find((s) => s.voucherTypeId === w.uuid('type:opening'))!.id;
  const advance = (w: PgMasterWorld, seriesId: string, nextValue: number, actor = w.ownerId) => run(w, 'advanceSeries', 'numberingSeries', seriesId, { nextValue }, undefined, actor);

  it('owner and accountant may move it forward; clerk, viewer and outsider may not', async () => {
    const w = await pgMasterWorldFactory(db)();
    await addMember(db.pool, w.companyId, users.accountant, 'accountant');
    await addMember(db.pool, w.companyId, users.clerk, 'clerk');
    await addMember(db.pool, w.companyId, users.viewer, 'viewer');
    const series = openingSeries(w);
    mustOk(await advance(w, series, 50, w.ownerId));
    expect(await nextValueOf(series)).toBe(50);
    mustOk(await advance(w, series, 60, users.accountant));
    expect(await nextValueOf(series)).toBe(60);
    for (const [who, actor] of [['clerk', users.clerk], ['viewer', users.viewer], ['outsider', users.outsider]] as const) {
      expect(codesOf(await advance(w, series, 70, actor)), who).toEqual([IssueCode.PermissionDenied]);
      expect(await nextValueOf(series), who).toBe(60); // unchanged
    }
  });

  it('a forward jump changes next_value, and the next posted voucher picks it up', async () => {
    const w = await pgMasterWorldFactory(db)();
    const series = openingSeries(w);
    mustOk(await advance(w, series, 500));
    const posted = mustOk(
      await w.backend.post({
        companyId: w.companyId,
        draft: { id: randomUUID(), voucherTypeId: w.uuid('type:opening'), date: '2024-04-01', ledgerId: w.uuid('ledger:cash'), side: 'debit', amount: '1', offsetLedgerId: w.uuid('ledger:opening-difference') },
      }),
    );
    expect(posted.voucher.number).toBe('OB/0500');
    expect(await nextValueOf(series)).toBe(501); // posting advanced it the ordinary way, from the new base
  });

  it('works even when the series already has vouchers posted — unlike start_at, which locks once used', async () => {
    const w = await pgMasterWorldFactory(db)();
    const series = openingSeries(w);
    mustOk(
      await w.backend.post({
        companyId: w.companyId,
        draft: { id: randomUUID(), voucherTypeId: w.uuid('type:opening'), date: '2024-04-01', ledgerId: w.uuid('ledger:cash'), side: 'debit', amount: '1', offsetLedgerId: w.uuid('ledger:opening-difference') },
      }),
    );
    expect(await nextValueOf(series)).toBe(2); // ordinary posting already moved it
    mustOk(await advance(w, series, 900));
    expect(await nextValueOf(series)).toBe(900);
  });

  it('the same value as the current one is a safe no-op replay: no audit row, next_value unchanged', async () => {
    const w = await pgMasterWorldFactory(db)();
    const series = openingSeries(w);
    const before = await nextValueOf(series);
    const countBefore = Number((await db.pool.query(`select count(*)::int n from public.audit_log where company_id = $1 and entity_id = $2`, [w.companyId, series])).rows[0].n);
    const r = mustOk(await advance(w, series, before));
    expect(r.replayed).toBe(true);
    expect(await nextValueOf(series)).toBe(before);
    const countAfter = Number((await db.pool.query(`select count(*)::int n from public.audit_log where company_id = $1 and entity_id = $2`, [w.companyId, series])).rows[0].n);
    expect(countAfter).toBe(countBefore);
  });

  it('a backward jump is refused, and next_value is left exactly as it was', async () => {
    const w = await pgMasterWorldFactory(db)();
    const series = openingSeries(w);
    mustOk(await advance(w, series, 100));
    expect(codesOf(await advance(w, series, 40))).toEqual([IssueCode.SeriesNextBehind]);
    expect(await nextValueOf(series)).toBe(100);
  });

  it('the audit row records the gap the jump created, before and after', async () => {
    const w = await pgMasterWorldFactory(db)();
    const series = openingSeries(w);
    mustOk(await advance(w, series, 250));
    const row = (
      await db.pool.query(`select action, before, after from public.audit_log where company_id = $1 and entity_id = $2 order by id desc limit 1`, [w.companyId, series])
    ).rows[0];
    expect(row.action).toBe('series.advanceNext');
    expect(row.before).toMatchObject({ next_value: 1 });
    expect(row.after).toMatchObject({ next_value: 250, gap: 249 });
  });
});
