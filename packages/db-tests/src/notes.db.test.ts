/**
 * What only the database can promise about Credit and Debit Notes (ADR-0026):
 *   - a note is mirrored on the OTHER side of the party's ledger: the part set against its invoice as an `against` row naming that invoice,
 *     the rest as a NEW bill named by the note's own number — and never more against the invoice than the note comes to
 *   - a credit note's stock comes IN and a debit note's goes OUT, even for a direct write
 *   - the migration's backfill gives a company that already exists the two voucher types and their numbering, once
 */
import { mustOk } from '@minimalerp/testkit';
import { partyLedgerId } from '@minimalerp/domain';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { type TestDb, createTestDb, migrationFiles } from './harness/testDb';

let db: TestDb;
let w: PgMasterWorld;
let main: string;
let invoiceNo: string;

const rejected = (sql: string, values: unknown[] = []) => db.pool.query(sql, values).then(() => undefined, (e: { message?: string }) => e.message);
const bills = async (voucher: string) =>
  (await db.pool.query(`select ledger_id, side, kind, ref, due_date::text as due, amount::text as amount from public.bill_allocations where voucher_id = $1 order by kind`, [voucher])).rows;
const details = (p: string) => ({ partyId: w.uuid(`party:${p}`), mailingName: 'X' });
const post = async (draft: unknown) => mustOk(await w.backend.post({ companyId: w.companyId, draft })).voucher;
const bolts = (qty: string, rate: string) => ({ itemId: w.uuid('item:bolt'), warehouseId: main, qty, rate });
const creditNote = (id: string, lines: unknown[], over: Record<string, unknown> = {}) =>
  post({ id: w.uuid(`v:${id}`), voucherTypeId: w.uuid('type:creditNote'), date: '2024-05-20', partyId: w.uuid('party:acme'), partyDetails: details('acme'), salesLedgerId: w.uuid('ledger:sales'), lines, ...over });
const debitNote = (id: string, lines: unknown[], over: Record<string, unknown> = {}) =>
  post({ id: w.uuid(`v:${id}`), voucherTypeId: w.uuid('type:debitNote'), date: '2024-05-20', partyId: w.uuid('party:steel'), partyDetails: details('steel'), purchaseLedgerId: w.uuid('ledger:purchases'), lines, ...over });

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgMasterWorldFactory(db)();
  const create = async (kind: string, id: string, data: unknown) =>
    mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
  await create('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
  await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'] });
  await create('party', w.uuid('party:steel'), { name: 'Steel Supplier', roles: ['vendor'] });
  await create('ledger', w.uuid('ledger:sales'), { name: 'Domestic Sales', groupId: w.uuid('group:sales-accounts') });
  await create('ledger', w.uuid('ledger:purchases'), { name: 'Purchases', groupId: w.uuid('group:purchase-accounts') });
  main = (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
  await post({ id: w.uuid('v:pur'), voucherTypeId: w.uuid('type:purchase'), date: '2024-05-02', partyId: w.uuid('party:steel'), partyDetails: details('steel'), purchaseLedgerId: w.uuid('ledger:purchases'), billNo: 'SS/889', dueDate: '2024-06-01', lines: [bolts('100', '10')] });
  invoiceNo = (await post({ id: w.uuid('v:sale'), voucherTypeId: w.uuid('type:sales'), date: '2024-05-12', partyId: w.uuid('party:acme'), partyDetails: details('acme'), salesLedgerId: w.uuid('ledger:sales'), dueDate: '2024-06-11', lines: [bolts('10', '100')] })).number;
});
afterAll(async () => {
  await db?.close();
});

describe('a note’s bill rows', () => {
  const customer = () => partyLedgerId(w.uuid('party:acme') as never, 'customer');
  const supplier = () => partyLedgerId(w.uuid('party:steel') as never, 'vendor');

  it('a credit note set against its invoice in part: an against row naming the invoice, and a new credit bill named by the note for the rest', async () => {
    const note = await creditNote('cn1', [bolts('2', '100'), { description: 'Rate difference', qty: '1', rate: '50.40' }], { invoiceRef: ` ${invoiceNo} `, against: '200.00' });
    // 200.00 + 50.40 = 250.40, rounded like an invoice to 250.00: 200.00 against the invoice, 50.00 the note's own
    expect(await bills(note.id)).toEqual([
      { ledger_id: customer(), side: 'credit', kind: 'against', ref: invoiceNo, due: null, amount: '200.00' },
      { ledger_id: customer(), side: 'credit', kind: 'new', ref: note.number, due: null, amount: '50.00' },
    ]);
  });

  it('a credit note against nothing is one new credit bill; an amount stated without an invoice, or beyond the note, never reaches the mirror', async () => {
    const note = await creditNote('cn2', [bolts('1', '100')]);
    expect(await bills(note.id)).toEqual([{ ledger_id: customer(), side: 'credit', kind: 'new', ref: note.number, due: null, amount: '100.00' }]);
    // a direct write that sets more against the invoice than the note is: the mirror holds it to the note's total
    await db.pool.query(`update public.vouchers set content = content || '{"invoiceRef": "X-1", "against": "999.00"}'::jsonb where id = $1`, [note.id]);
    expect(await bills(note.id)).toEqual([{ ledger_id: customer(), side: 'credit', kind: 'against', ref: 'X-1', due: null, amount: '100.00' }]);
  });

  it('a debit note is the mirror image on the supplier’s ledger: a debit against the supplier’s bill', async () => {
    const note = await debitNote('dn1', [bolts('30', '10')], { invoiceRef: 'SS/889', against: '300.00' });
    expect(note.number).toMatch(/^DN\//);
    expect(await bills(note.id)).toEqual([{ ledger_id: supplier(), side: 'debit', kind: 'against', ref: 'SS/889', due: null, amount: '300.00' }]);
  });

  it('a cancelled note has no rows', async () => {
    const note = await creditNote('cn3', [bolts('1', '100')]);
    mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: note.id, expectedVersion: note.version }));
    expect(await bills(note.id)).toEqual([]);
  });
});

describe('the database refuses what the rules refuse, even for a direct write', () => {
  const addStock = (voucher: string, direction: 'in' | 'out') =>
    rejected(
      `insert into public.stock_movements (company_id, voucher_id, line_no, entry_date, financial_year_id, item_id, warehouse_id, direction, qty, value)
       select v.company_id, v.id, 9, v.voucher_date, v.financial_year_id, $2, $3, $4, 1, case when $4 = 'in' then 10 else null end from public.vouchers v where v.id = $1`,
      [voucher, w.uuid('item:bolt'), main, direction],
    );

  it('a credit note brings goods in and a debit note sends them out — never the other way', async () => {
    const cn = await creditNote('cn4', [bolts('1', '100')]);
    const dn = await debitNote('dn2', [bolts('1', '10')]);
    expect(await addStock(cn.id, 'out')).toBe('STOCK_LINE_INVALID');
    expect(await addStock(dn.id, 'in')).toBe('STOCK_LINE_INVALID');
  });

  it('a note of written lines alone moves no stock', async () => {
    const cn = await creditNote('cn5', [{ description: 'Discount allowed', qty: '1', rate: '25' }]);
    expect(await addStock(cn.id, 'in')).toBe('PLAN_INCONSISTENT_LINES');
  });
});

describe('existing companies get the note kinds', () => {
  it('the migration’s backfill adds both voucher types and their numbering to a company without them — once', async () => {
    const other = await pgMasterWorldFactory(db)();
    const kinds = () =>
      db.pool
        .query(
          `select t.base_kind, t.is_system, s.prefix from public.voucher_types t left join public.numbering_series s on s.voucher_type_id = t.id
            where t.company_id = $1 and t.base_kind in ('creditNote', 'debitNote') order by t.base_kind`,
          [other.companyId],
        )
        .then((r) => r.rows);
    // as the company was before the migration: neither type, neither series
    await db.pool.query(`delete from public.numbering_series where voucher_type_id in (select id from public.voucher_types where company_id = $1 and base_kind in ('creditNote', 'debitNote'))`, [other.companyId]);
    await db.pool.query(`delete from public.voucher_types where company_id = $1 and base_kind in ('creditNote', 'debitNote')`, [other.companyId]);
    expect(await kinds()).toEqual([]);

    const sql = migrationFiles().find((m) => m.name.endsWith('_credit_debit_notes.sql'))?.sql as string;
    const statement = (start: string): string => {
      const from = sql.indexOf(start);
      return sql.slice(from, sql.indexOf(';', from) + 1);
    };
    const backfill = [statement('insert into public.voucher_types'), statement('insert into public.numbering_series')];
    for (const s of [...backfill, ...backfill]) await db.pool.query(s); // twice: the second run adds nothing
    expect(await kinds()).toEqual([
      { base_kind: 'creditNote', is_system: true, prefix: 'CN/24-25/' },
      { base_kind: 'debitNote', is_system: true, prefix: 'DN/24-25/' },
    ]);
  });
});
