/**
 * What only the database can promise about a party and its ledgers:
 *   - master_apply commits several records in ONE transaction: a failure in any record rolls back all of them, and the version moves once
 *   - every record gets its own audit entry
 *   - the database itself refuses a party ledger under the wrong group, one moved to another party or role, or a role taken away
 *   - the search index has one hit per party (with its roles), and none for the party's own ledgers
 *   - the loaders bring the new columns back exactly (and an untouched party reads back with no roles)
 */
import { PostgresBackend } from '@minimalerp/adapter-postgres';
import { partyLedgerId } from '@minimalerp/domain';
import { mustOk } from '@minimalerp/testkit';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgMasterWorld;

const backend = () => new PostgresBackend(db.pool, { actorId: w.ownerId });
const run = (op: 'create' | 'alter' | 'setActive', kind: string, id: string, data?: unknown, active?: boolean) =>
  backend().execute({
    companyId: w.companyId,
    command: { op, kind, id, ...(data === undefined ? {} : { data }), ...(active === undefined ? {} : { active }) },
  });
const pid = (name: string) => w.uuid(`pr:${name}`);
const rejected = (sql: string, values: unknown[] = []) => db.pool.query(sql, values).then(() => undefined, (e: { message?: string }) => e.message);
const count = async (sql: string, values: unknown[] = []) => Number((await db.pool.query(sql, values)).rows[0]?.n);
const version = async () => Number((await db.pool.query('select masters_version v from public.companies where id = $1', [w.companyId])).rows[0]?.v);

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgMasterWorldFactory(db)();
});
afterAll(async () => {
  await db?.close();
});

describe('master_apply commits a party and its ledgers together', () => {
  it('one version bump and one audit entry per record', async () => {
    const before = await version();
    mustOk(await run('create', 'party', pid('audited'), { name: 'Audited Party', roles: ['customer', 'vendor'] }));
    expect(await version()).toBe(before + 1);
    const rows = (
      await db.pool.query(
        `select entity_type, action from public.audit_log where company_id = $1 and entity_id = any($2::uuid[]) order by id`,
        [w.companyId, [pid('audited'), partyLedgerId(pid('audited'), 'customer'), partyLedgerId(pid('audited'), 'vendor')]],
      )
    ).rows;
    expect(rows).toEqual([
      { entity_type: 'party', action: 'master.create' },
      { entity_type: 'ledger', action: 'master.create' },
      { entity_type: 'ledger', action: 'master.create' },
    ]);
  });

  it('a record that fails rolls the whole change back: no party, no ledger, no version bump', async () => {
    const id = pid('atomic');
    const party = { id, company_id: w.companyId, name: 'Atomic Party', is_active: true, addresses: [], roles: ['customer'] };
    const good = { id: partyLedgerId(id, 'customer'), company_id: w.companyId, name: 'Atomic Party', group_id: w.uuid('group:sundry-debtors'), is_active: true, party_id: id, party_role: 'customer' };
    const bad = { ...good, id: partyLedgerId(id, 'vendor'), name: 'Atomic Party (Vendor)', party_role: 'vendor' }; // a vendor ledger under Sundry Debtors
    const before = await version();
    const call = (changes: unknown[]) =>
      db.pool.query(`select public.master_apply($1::uuid, $2::uuid, null, $3::bigint, $4::jsonb)`, [w.ownerId, w.companyId, before, JSON.stringify({ changes })]);
    await expect(
      call([
        { kind: 'party', op: 'create', id, row: party },
        { kind: 'ledger', op: 'create', id: good.id, row: good },
        { kind: 'ledger', op: 'create', id: bad.id, row: bad },
      ]),
    ).rejects.toMatchObject({ message: 'UNSUPPORTED_OPERATION' });
    expect(await version()).toBe(before);
    expect(await count('select count(*) n from public.parties where id = $1', [id])).toBe(0);
    expect(await count('select count(*) n from public.ledgers where party_id = $1', [id])).toBe(0);
    expect(await count('select count(*) n from public.audit_log where entity_id = $1', [id])).toBe(0);
  });

  it('a single-record change (the older shape) is still accepted', async () => {
    const before = await version();
    const row = { id: w.uuid('pr:single'), company_id: w.companyId, name: 'Single Store', parent_id: null, is_active: true };
    await db.pool.query(`select public.master_apply($1::uuid, $2::uuid, null, $3::bigint, $4::jsonb)`, [w.ownerId, w.companyId, before, JSON.stringify({ kind: 'warehouse', op: 'create', id: row.id, row })]);
    expect(await version()).toBe(before + 1);
  });

  it('an empty list of changes is refused', async () => {
    const before = await version();
    await expect(
      db.pool.query(`select public.master_apply($1::uuid, $2::uuid, null, $3::bigint, $4::jsonb)`, [w.ownerId, w.companyId, before, JSON.stringify({ changes: [] })]),
    ).rejects.toMatchObject({ message: 'SCHEMA_INVALID' });
  });
});

describe('backstop triggers for party ledgers', () => {
  beforeAll(async () => {
    mustOk(await run('create', 'party', pid('guarded'), { name: 'Guarded Party', roles: ['customer'] }));
    mustOk(await run('create', 'party', pid('other'), { name: 'Other Party', roles: ['vendor'] }));
  });

  it('a party ledger under the wrong group is refused', async () => {
    expect(
      await rejected(`update public.ledgers set group_id = $2 where id = $1`, [partyLedgerId(pid('guarded'), 'customer'), w.uuid('group:sundry-creditors')]),
    ).toBe('UNSUPPORTED_OPERATION');
  });

  it('a party ledger cannot be moved to another party or changed to another role', async () => {
    const ledger = partyLedgerId(pid('guarded'), 'customer');
    expect(await rejected(`update public.ledgers set party_id = $2 where id = $1`, [ledger, pid('other')])).toBe('UNSUPPORTED_OPERATION');
    expect(await rejected(`update public.ledgers set party_role = 'vendor' where id = $1`, [ledger])).toBe('UNSUPPORTED_OPERATION');
  });

  it('a party has at most one ledger per role, and a role needs a party', async () => {
    const dup = await rejected(
      `insert into public.ledgers (id, company_id, name, group_id, party_id, party_role) values ($1, $2, 'Second', $3, $4, 'customer')`,
      [w.uuid('pr:dup'), w.companyId, w.uuid('group:sundry-debtors'), pid('guarded')],
    );
    expect(dup).toMatch(/ledgers_party_role_uq/);
    const orphan = await rejected(
      `insert into public.ledgers (id, company_id, name, group_id, party_role) values ($1, $2, 'Orphan', $3, 'customer')`,
      [w.uuid('pr:orphan'), w.companyId, w.uuid('group:sundry-debtors')],
    );
    expect(orphan).toMatch(/ledger_party_role_needs_party/);
  });

  it('a role cannot be taken away from a party, even by a direct write; adding one is fine', async () => {
    expect(await rejected(`update public.parties set roles = '["vendor"]'::jsonb where id = $1`, [pid('guarded')])).toBe('UNSUPPORTED_OPERATION');
    expect(await rejected(`update public.parties set roles = null where id = $1`, [pid('guarded')])).toBe('UNSUPPORTED_OPERATION');
    expect(await rejected(`update public.parties set roles = '["customer", "vendor"]'::jsonb where id = $1`, [pid('guarded')])).toBeUndefined();
  });

  it('the schema refuses an empty or malformed roles list', async () => {
    expect(await rejected(`update public.parties set roles = '[]'::jsonb where id = $1`, [pid('other')])).toMatch(/check/);
    expect(await rejected(`update public.parties set roles = '"customer"'::jsonb where id = $1`, [pid('other')])).toMatch(/check/);
  });
});

describe('the search index and the loaders', () => {
  it('one hit per party, with its roles; its own ledgers are not separate hits', async () => {
    mustOk(await run('create', 'party', pid('indexed'), { name: 'Indexed Party', roles: ['customer', 'vendor'], gstin: undefined, phone: '9820012345' }));
    const hits = (await db.pool.query(`select entity_type, subtitle from public.search_index where company_id = $1 and title like 'Indexed Party%'`, [w.companyId])).rows;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ entity_type: 'party' });
    expect(hits[0]?.subtitle).toContain('Customer / Vendor');
  });

  it('a party made without roles still indexes (older data)', async () => {
    mustOk(await run('create', 'party', pid('legacy'), { name: 'Legacy Party' }));
    expect(await count(`select count(*) n from public.search_index where entity_id = $1`, [pid('legacy')])).toBe(1);
  });

  it('billing, shipping, roles and a ledger’s role read back exactly; a party without them reads back without', async () => {
    mustOk(
      await run('create', 'party', pid('full'), {
        name: 'Full Party', roles: ['vendor', 'customer'], address: 'Plot 14, MIDC', stateCode: '27', pincode: '411026', country: 'India',
        shipping: { lines: 'Godown 3, Chakan', stateCode: '27', pincode: '410501' },
      }),
    );
    const m = await backend().load(w.companyId);
    expect(m.parties.find((p) => p.id === pid('full'))).toMatchObject({
      roles: ['vendor', 'customer'], pincode: '411026', country: 'India', shipping: { lines: 'Godown 3, Chakan', stateCode: '27', pincode: '410501' },
    });
    expect(m.ledgers.find((l) => l.id === partyLedgerId(pid('full'), 'vendor'))).toMatchObject({ partyId: pid('full'), partyRole: 'vendor' });
    const legacy = m.parties.find((p) => p.id === pid('legacy'));
    expect(legacy?.roles).toBeUndefined();
    expect(legacy?.shipping).toBeUndefined();
  });
});
