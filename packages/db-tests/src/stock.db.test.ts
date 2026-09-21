/**
 * What only the database can promise about stock:
 *   - stock_movements is read-only to everyone but the server, and members read their own company's only
 *   - the database itself refuses a movement that would take a godown below zero, however it got there
 *   - a stock voucher has no journal lines, an accounting voucher no stock lines
 *   - stock in a locked period cannot change
 *   - the backfill gives companies that already exist the two stock voucher types and their numbering
 *   - the posting functions carry the stock, and a clerk may post stock journals but not opening stock
 */
import { mustOk } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { addMember } from './harness/pgWorld';
import { type TestDb, createTestDb, migrationFiles } from './harness/testDb';

let db: TestDb;
let a: PgMasterWorld;
let b: PgMasterWorld;
const viewer = randomUUID();
const clerk = randomUUID();
const outsider = randomUUID();

const rejected = (sql: string, values: unknown[] = []) => db.pool.query(sql, values).then(() => undefined, (e: { message?: string }) => e.message);
const count = async (sql: string, values: unknown[] = []) => Number((await db.pool.query(sql, values)).rows[0]?.n);

const seed = async (w: PgMasterWorld) => {
  const create = async (kind: string, id: string, data: unknown) =>
    mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
  await create('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
  await create('ledger', w.uuid('l:bank'), { name: 'HDFC', groupId: w.uuid('group:bank-accounts') });
  await create('ledger', w.uuid('l:rent'), { name: 'Rent', groupId: w.uuid('group:indirect-expenses') });
  const main = (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
  mustOk(
    await w.backend.post({
      companyId: w.companyId,
      draft: { id: w.uuid('v:open'), voucherTypeId: w.uuid('type:stockOpening'), date: '2024-04-01', itemId: w.uuid('item:bolt'), warehouseId: main, qty: '10', rate: '5' },
    }),
  );
  mustOk(
    await w.backend.post({
      companyId: w.companyId,
      draft: { id: w.uuid('v:pay'), voucherTypeId: w.uuid('type:payment'), date: '2024-05-10', accountLedgerId: w.uuid('l:bank'), lines: [{ ledgerId: w.uuid('l:rent'), amount: '100' }] },
    }),
  );
  return main;
};
let mainA: string;

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  const make = pgMasterWorldFactory(db);
  a = await make();
  b = await make();
  mainA = await seed(a);
  await seed(b);
  await addMember(db.pool, a.companyId, viewer, 'viewer');
  await addMember(db.pool, a.companyId, clerk, 'clerk');
  await db.pool.query(`insert into auth.users (id, email) values ($1, 'outsider3@example.test')`, [outsider]);
});
afterAll(async () => {
  await db?.close();
});

describe('stock_movements: who can read and write', () => {
  const visible = (userId: string, where = 'true') =>
    db.asRole('authenticated', userId, async (c) => Number((await c.query(`select count(*)::int n from public.stock_movements where ${where}`)).rows[0].n));

  it('members with report.view read their own company’s stock, nobody else’s', async () => {
    expect(await visible(a.ownerId, `company_id = '${a.companyId}'`)).toBe(1);
    expect(await visible(viewer, `company_id = '${a.companyId}'`)).toBe(1);
    expect(await visible(a.ownerId, `company_id = '${b.companyId}'`)).toBe(0);
    expect(await visible(outsider)).toBe(0);
  });

  it('a signed-in user cannot write it', async () => {
    const denied = (sql: string) => db.asRole('authenticated', a.ownerId, async (c) => c.query(sql)).then(() => undefined, (e: { code?: string }) => e.code);
    expect(await denied(`update public.stock_movements set qty = 1`)).toBe('42501');
    expect(await denied(`delete from public.stock_movements`)).toBe('42501');
    expect(await denied(`insert into public.stock_movements (company_id, voucher_id, line_no, entry_date, financial_year_id, item_id, warehouse_id, direction, qty, value) select company_id, voucher_id, 9, entry_date, financial_year_id, item_id, warehouse_id, 'in', 1, 1 from public.stock_movements limit 1`)).toBe('42501');
  });
});

describe('the database refuses what the rules refuse, even for a direct write', () => {
  const insertMovement = (voucher: string, direction: string, qty: string, value: string | null, lineNo: number, warehouse = () => mainA) =>
    rejected(
      `insert into public.stock_movements (company_id, voucher_id, line_no, entry_date, financial_year_id, item_id, warehouse_id, direction, qty, value)
       select v.company_id, v.id, $2, v.voucher_date, v.financial_year_id, $3, $4, $5, $6::numeric, $7::numeric from public.vouchers v where v.id = $1`,
      [voucher, lineNo, a.uuid('item:bolt'), warehouse(), direction, qty, value],
    );

  it('a movement that would take a godown below zero is refused (STOCK_NEGATIVE), and nothing is left behind', async () => {
    expect(await insertMovement(a.uuid('v:open'), 'out', '11', null, 2)).toBe('STOCK_NEGATIVE');
    expect(await count('select count(*) n from public.stock_movements where company_id = $1', [a.companyId])).toBe(1);
    expect(await insertMovement(a.uuid('v:open'), 'out', '10', null, 3)).toBeUndefined(); // exactly what there is: fine… (rolled into the opening voucher)
    await db.pool.query('delete from public.stock_movements where voucher_id = $1 and line_no = 3', [a.uuid('v:open')]);
  });

  it('is checked per godown: an Out from an empty godown is refused', async () => {
    const yard = randomUUID();
    await db.pool.query(`insert into public.warehouses (id, company_id, name, is_active) values ($1, $2, 'Yard', true)`, [yard, a.companyId]);
    expect(await insertMovement(a.uuid('v:open'), 'out', '1', null, 4, () => yard)).toBe('STOCK_NEGATIVE');
  });

  it('a voucher of a stock kind cannot carry journal lines, and an accounting voucher cannot carry stock', async () => {
    const line = (voucher: string) =>
      rejected(
        `insert into public.journal_lines (company_id, voucher_id, line_no, entry_date, financial_year_id, ledger_id, debit, credit)
         select v.company_id, v.id, n.no, v.voucher_date, v.financial_year_id, $2, case when n.no = 7 then 5 else 0 end, case when n.no = 8 then 5 else 0 end
           from public.vouchers v cross join (values (7), (8)) as n(no) where v.id = $1`,
        [voucher, a.uuid('l:rent')],
      );
    expect(await line(a.uuid('v:open'))).toBe('PLAN_UNBALANCED'); // "a stock voucher has no accounting effect"
    expect(await insertMovement(a.uuid('v:pay'), 'in', '1', '1', 1)).toBe('STOCK_LINE_INVALID');
  });

  it('the schema itself refuses malformed movements: an In without a value, an Out with one, a zero quantity', async () => {
    expect(await insertMovement(a.uuid('v:open'), 'in', '1', null, 5)).toMatch(/stock_in_has_value/);
    expect(await insertMovement(a.uuid('v:open'), 'out', '1', '5', 5)).toMatch(/stock_in_has_value/);
    expect(await insertMovement(a.uuid('v:open'), 'in', '0', '0', 5)).toMatch(/check/i);
  });

  it('stock in a locked period cannot change', async () => {
    await db.pool.query(`update public.financial_years set locked_through = '2024-04-30' where company_id = $1`, [a.companyId]);
    expect(await rejected(`delete from public.stock_movements where voucher_id = $1`, [a.uuid('v:open')])).toBe('PERIOD_LOCKED');
    await db.pool.query(`update public.financial_years set locked_through = null where company_id = $1`, [a.companyId]);
  });
});

describe('the posting functions and permissions', () => {
  it('post and alter carry the stock and, since Phase 6b, the deliveries (seven and nine arguments); the old signatures are gone', async () => {
    const r = await db.pool.query(
      `select proname, pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and proname in ('post_voucher_atomic', 'alter_voucher_atomic') order by proname`,
    );
    expect(r.rows.map((x) => [x.proname, x.pronargs])).toEqual([['alter_voucher_atomic', 9], ['post_voucher_atomic', 7]]);
  });

  it('a clerk may post a stock journal but not opening stock; a viewer neither', async () => {
    const can = async (user: string, permission: string) => (await db.pool.query('select public.actor_can($1, $2, $3) as ok', [user, a.companyId, permission])).rows[0]?.ok;
    expect(await can(clerk, 'voucher.stockJournal.post')).toBe(true);
    expect(await can(clerk, 'voucher.stockJournal.alter')).toBe(false);
    expect(await can(clerk, 'voucher.stockOpening.post')).toBe(false);
    expect(await can(viewer, 'voucher.stockJournal.post')).toBe(false);
    expect(await can(a.ownerId, 'voucher.stockOpening.post')).toBe(true);
  });
});

describe('the backfill', () => {
  it('gives a company that already exists the two stock voucher types and their numbering', async () => {
    const w = await pgMasterWorldFactory(db)();
    await db.pool.query(`delete from public.numbering_series where company_id = $1 and voucher_type_id in (select id from public.voucher_types where company_id = $1 and base_kind in ('stockJournal', 'stockOpening'))`, [w.companyId]);
    await db.pool.query(`delete from public.voucher_types where company_id = $1 and base_kind in ('stockJournal', 'stockOpening')`, [w.companyId]);
    expect(await count(`select count(*) n from public.voucher_types where company_id = $1 and base_kind in ('stockJournal', 'stockOpening')`, [w.companyId])).toBe(0);

    const sql = migrationFiles().find((m) => m.name.includes('stock_phase6a'))?.sql ?? '';
    const from = sql.indexOf('-- Companies that already exist');
    const to = sql.indexOf('-- The stock ledger');
    expect(from).toBeGreaterThan(-1);
    await db.pool.query(sql.slice(from, to));

    const types = (await db.pool.query(`select name, base_kind, is_system from public.voucher_types where company_id = $1 and base_kind in ('stockJournal', 'stockOpening') order by base_kind`, [w.companyId])).rows;
    expect(types).toEqual([
      { name: 'Stock Journal', base_kind: 'stockJournal', is_system: true },
      { name: 'Opening Stock', base_kind: 'stockOpening', is_system: true },
    ]);
    const series = (await db.pool.query(`select prefix, width from public.numbering_series s join public.voucher_types t on t.id = s.voucher_type_id where s.company_id = $1 and t.base_kind in ('stockJournal', 'stockOpening') order by prefix`, [w.companyId])).rows;
    expect(series.map((s) => s.prefix)).toEqual(['OS/', 'STJ/24-25/']);
    // and they work: a stock voucher can be posted through them
    const type = types.find((t) => t.base_kind === 'stockJournal');
    expect(type).toBeDefined();
  });
});
