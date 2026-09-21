/**
 * What only the database can promise about Purchase Orders and Purchase Invoices (Phase 8, ADR-0018):
 *   - a purchase invoice's supplier line is mirrored as a NEW credit bill named by the SUPPLIER'S invoice number (`billNo`)
 *   - a supplier's invoice number is used once per supplier, even for a direct update (BILL_REF_IN_USE)
 *   - a purchase invoice's stock goes IN and its receipts sit on stock coming in; a sales order cannot be filled by a purchase invoice
 *   - a purchase order (a document) carries no journal lines and no stock lines
 *   - the backfill gives companies that already exist the two voucher types and their numbering
 */
import { mustOk } from '@minimalerp/testkit';
import { partyLedgerId } from '@minimalerp/domain';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgMasterWorld;

const rejected = (sql: string, values: unknown[] = []) => db.pool.query(sql, values).then(() => undefined, (e: { message?: string }) => e.message);
const count = async (sql: string, values: unknown[] = []) => Number((await db.pool.query(sql, values)).rows[0]?.n);

interface Seeded {
  main: string;
  order: string;
  invoice: string;
  salesOrder: string;
}
let s: Seeded;

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgMasterWorldFactory(db)();
  const create = async (kind: string, id: string, data: unknown) =>
    mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
  await create('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
  await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'] });
  await create('party', w.uuid('party:steel'), { name: 'Steel Supplier', roles: ['vendor'] });
  await create('party', w.uuid('party:other'), { name: 'Other Supplier', roles: ['vendor'] });
  await create('ledger', w.uuid('ledger:purchases'), { name: 'Purchases', groupId: w.uuid('group:purchase-accounts') });
  const main = (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
  const details = (p: string) => ({ partyId: w.uuid(`party:${p}`), mailingName: 'X' });
  const order = mustOk(
    await w.backend.post({
      companyId: w.companyId,
      draft: {
        id: w.uuid('v:po'), voucherTypeId: w.uuid('type:purchaseOrder'), date: '2024-05-01', partyId: w.uuid('party:steel'), partyDetails: details('steel'),
        lines: [{ id: 'a', itemId: w.uuid('item:bolt'), qty: '100', rate: '10', dueDate: '2024-05-20' }],
      },
    }),
  ).voucher;
  const invoice = mustOk(
    await w.backend.post({
      companyId: w.companyId,
      draft: {
        id: w.uuid('v:pur'), voucherTypeId: w.uuid('type:purchase'), date: '2024-05-12', partyId: w.uuid('party:steel'), partyDetails: details('steel'),
        purchaseLedgerId: w.uuid('ledger:purchases'), billNo: ' SS/889 ', dueDate: '2024-06-11',
        lines: [{ itemId: w.uuid('item:bolt'), warehouseId: main, qty: '60', rate: '10', orderRef: { orderId: order.id, lineId: 'a' } }],
      },
    }),
  ).voucher;
  const salesOrder = mustOk(
    await w.backend.post({
      companyId: w.companyId,
      draft: {
        id: w.uuid('v:so'), voucherTypeId: w.uuid('type:salesOrder'), date: '2024-05-01', partyId: w.uuid('party:acme'), partyDetails: details('acme'),
        lines: [{ id: 'a', itemId: w.uuid('item:bolt'), qty: '10', rate: '25', dueDate: '2024-05-20' }],
      },
    }),
  ).voucher;
  s = { main, order: order.id, invoice: invoice.id, salesOrder: salesOrder.id };
});
afterAll(async () => {
  await db?.close();
});

describe('the supplier’s bill', () => {
  it('is mirrored as a NEW credit bill on the supplier’s ledger, named by the supplier’s invoice number (trimmed), for the total, due on the invoice’s due date', async () => {
    const rows = (await db.pool.query(`select ledger_id, side, kind, ref, due_date::text as due, amount::text as amount from public.bill_allocations where voucher_id = $1`, [s.invoice])).rows;
    expect(rows).toEqual([{ ledger_id: partyLedgerId(w.uuid('party:steel') as never, 'vendor'), side: 'credit', kind: 'new', ref: 'SS/889', due: '2024-06-11', amount: '600.00' }]);
  });

  it('a supplier’s invoice number is used once per supplier, even for a direct update; another supplier may use it', async () => {
    const other = mustOk(
      await w.backend.post({
        companyId: w.companyId,
        draft: {
          id: w.uuid('v:pur2'), voucherTypeId: w.uuid('type:purchase'), date: '2024-05-13', partyId: w.uuid('party:steel'), partyDetails: { partyId: w.uuid('party:steel'), mailingName: 'X' },
          purchaseLedgerId: w.uuid('ledger:purchases'), billNo: 'SS/890', dueDate: '2024-06-12', lines: [{ itemId: w.uuid('item:bolt'), warehouseId: s.main, qty: '5', rate: '10' }],
        },
      }),
    ).voucher;
    expect(await rejected(`update public.vouchers set content = jsonb_set(content, '{billNo}', '"SS/889"') where id = $1`, [other.id])).toBe('BILL_REF_IN_USE');
    expect(await count('select count(*) n from public.bill_allocations where voucher_id = $1 and ref = $2', [other.id, 'SS/890'])).toBe(1); // untouched
    // the same number under ANOTHER supplier is a different bill
    mustOk(
      await w.backend.post({
        companyId: w.companyId,
        draft: {
          id: w.uuid('v:pur3'), voucherTypeId: w.uuid('type:purchase'), date: '2024-05-14', partyId: w.uuid('party:other'), partyDetails: { partyId: w.uuid('party:other'), mailingName: 'X' },
          purchaseLedgerId: w.uuid('ledger:purchases'), billNo: 'SS/889', dueDate: '2024-06-13', lines: [{ itemId: w.uuid('item:bolt'), warehouseId: s.main, qty: '1', rate: '10' }],
        },
      }),
    );
  });
});

describe('the database refuses what the rules refuse, even for a direct write', () => {
  const addStock = (voucher: string, direction: 'in' | 'out', lineNo: number) =>
    rejected(
      `insert into public.stock_movements (company_id, voucher_id, line_no, entry_date, financial_year_id, item_id, warehouse_id, direction, qty, value)
       select v.company_id, v.id, $2, v.voucher_date, v.financial_year_id, $3, $4, $5, 1, case when $5 = 'in' then 10 else null end from public.vouchers v where v.id = $1`,
      [voucher, lineNo, w.uuid('item:bolt'), s.main, direction],
    );

  it('a purchase invoice cannot move stock the wrong way', async () => {
    expect(await addStock(s.invoice, 'out', 2)).toBe('STOCK_LINE_INVALID');
    expect(await count('select count(*) n from public.stock_movements where voucher_id = $1', [s.invoice])).toBe(1);
  });

  it('a purchase order is a document: no journal lines, no stock lines', async () => {
    expect(await addStock(s.order, 'in', 1)).toBe('PLAN_INCONSISTENT_LINES');
    const journal = await rejected(
      `insert into public.journal_lines (company_id, voucher_id, line_no, entry_date, financial_year_id, ledger_id, debit, credit)
       select v.company_id, v.id, n.no, v.voucher_date, v.financial_year_id, $2, case when n.no = 1 then 5 else 0 end, case when n.no = 2 then 5 else 0 end
         from public.vouchers v cross join (values (1), (2)) as n(no) where v.id = $1`,
      [s.order, w.uuid('ledger:purchases')],
    );
    expect(journal).toBe('PLAN_INCONSISTENT_LINES');
  });

  it('a purchase invoice cannot fill a SALES order (nor the reverse) — by any route', async () => {
    // give the invoice a second stock-in line, and hang a receipt on it that points at the sales order
    await db.pool.query(
      `insert into public.stock_movements (company_id, voucher_id, line_no, entry_date, financial_year_id, item_id, warehouse_id, direction, qty, value)
       select v.company_id, v.id, 2, v.voucher_date, v.financial_year_id, $2, $3, 'in', 1, 10 from public.vouchers v where v.id = $1`,
      [s.invoice, w.uuid('item:bolt'), s.main],
    );
    const r = await rejected(
      `insert into public.voucher_links (company_id, voucher_id, line_no, entry_date, order_id, order_line_id, item_id, qty)
       select v.company_id, v.id, 2, v.voucher_date, $2, 'a', $3, 1 from public.vouchers v where v.id = $1`,
      [s.invoice, s.salesOrder, w.uuid('item:bolt')],
    );
    expect(r).toBe('ORDER_REF_INVALID');
    await db.pool.query('delete from public.stock_movements where voucher_id = $1 and line_no = 2', [s.invoice]);
  });

  it('a receipt past what the purchase order asked for is refused (OVER_DELIVERY)', async () => {
    await db.pool.query(
      `insert into public.stock_movements (company_id, voucher_id, line_no, entry_date, financial_year_id, item_id, warehouse_id, direction, qty, value)
       select v.company_id, v.id, 2, v.voucher_date, v.financial_year_id, $2, $3, 'in', 41, 410 from public.vouchers v where v.id = $1`,
      [s.invoice, w.uuid('item:bolt'), s.main],
    );
    const r = await rejected(
      `insert into public.voucher_links (company_id, voucher_id, line_no, entry_date, order_id, order_line_id, item_id, qty)
       select v.company_id, v.id, 2, v.voucher_date, $2, 'a', $3, 41 from public.vouchers v where v.id = $1`,
      [s.invoice, s.order, w.uuid('item:bolt')],
    );
    expect(r).toBe('OVER_DELIVERY'); // 60 received of 100: 41 more is one too many
    await db.pool.query('delete from public.stock_movements where voucher_id = $1 and line_no = 2', [s.invoice]);
  });
});

describe('existing companies get the purchase kinds', () => {
  it('the company has both voucher types, each with a numbering series for its financial year', async () => {
    const types = (await db.pool.query(`select base_kind from public.voucher_types where company_id = $1 and base_kind in ('purchase', 'purchaseOrder') order by base_kind`, [w.companyId])).rows.map((r) => r.base_kind);
    expect(types).toEqual(['purchase', 'purchaseOrder']);
    const series = (
      await db.pool.query(
        `select t.base_kind, s.prefix from public.numbering_series s join public.voucher_types t on t.id = s.voucher_type_id where s.company_id = $1 and t.base_kind in ('purchase', 'purchaseOrder') order by t.base_kind`,
        [w.companyId],
      )
    ).rows;
    expect(series.map((r) => r.base_kind)).toEqual(['purchase', 'purchaseOrder']);
    expect(series[0]?.prefix).toMatch(/^PUR\//);
    expect(series[1]?.prefix).toMatch(/^PO\//);
  });
});
