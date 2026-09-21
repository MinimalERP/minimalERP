/**
 * What only the database can promise about Sales Orders and Sales Invoices (Phase 6b, ADR-0015):
 *   - voucher_links (the deliveries) is read-only to everyone but the server, and members read their own company's only
 *   - the database itself refuses a delivery that would take an order line past what was ordered, points at a line that is not there, or
 *     sits on the wrong stock — however it got there — and an order with deliveries cannot be cancelled or shrunk by a direct update
 *   - a Sales Order (a document) has no journal lines and no stock lines; a Sales Invoice has both
 *   - an invoice's customer line is mirrored as a NEW bill named by the invoice number
 *   - the backfill gives companies that already exist the two voucher types and their numbering
 *   - the posting functions carry the links, and a clerk may post sales documents but not alter or cancel them
 */
import { mustOk } from '@minimalerp/testkit';
import { partyLedgerId } from '@minimalerp/domain';
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

interface Seeded {
  main: string;
  order: string;
  invoice: string;
  invoiceNumber: string;
}

const seed = async (w: PgMasterWorld): Promise<Seeded> => {
  const create = async (kind: string, id: string, data: unknown) =>
    mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
  await create('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
  await create('stockItem', w.uuid('item:nut'), { name: 'Nut', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
  await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'] });
  await create('ledger', w.uuid('ledger:sales'), { name: 'Domestic Sales', groupId: w.uuid('group:sales-accounts') });
  const main = (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
  for (const item of ['bolt', 'nut']) {
    mustOk(
      await w.backend.post({
        companyId: w.companyId,
        draft: { id: w.uuid(`v:open-${item}`), voucherTypeId: w.uuid('type:stockOpening'), date: '2024-04-01', itemId: w.uuid(`item:${item}`), warehouseId: main, qty: '100', rate: '10' },
      }),
    );
  }
  const details = { partyId: w.uuid('party:acme'), mailingName: 'Acme Ltd' };
  const order = mustOk(
    await w.backend.post({
      companyId: w.companyId,
      draft: {
        id: w.uuid('v:so'), voucherTypeId: w.uuid('type:salesOrder'), date: '2024-05-01', partyId: w.uuid('party:acme'), partyDetails: details, reference: 'PO-1',
        lines: [
          { id: 'a', itemId: w.uuid('item:bolt'), qty: '18', rate: '25', dueDate: '2024-05-20' },
          { id: 'b', itemId: w.uuid('item:nut'), qty: '10', rate: '5', dueDate: '2024-06-10' },
        ],
      },
    }),
  ).voucher;
  const invoice = mustOk(
    await w.backend.post({
      companyId: w.companyId,
      draft: {
        id: w.uuid('v:inv'), voucherTypeId: w.uuid('type:sales'), date: '2024-05-12', partyId: w.uuid('party:acme'), partyDetails: details,
        salesLedgerId: w.uuid('ledger:sales'), dueDate: '2024-06-11',
        lines: [{ itemId: w.uuid('item:bolt'), warehouseId: main, qty: '5', rate: '25', orderRef: { orderId: order.id, lineId: 'a' } }],
      },
    }),
  ).voucher;
  return { main, order: order.id, invoice: invoice.id, invoiceNumber: invoice.number };
};
let sa: Seeded;

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  const make = pgMasterWorldFactory(db);
  a = await make();
  b = await make();
  sa = await seed(a);
  await seed(b);
  await addMember(db.pool, a.companyId, viewer, 'viewer');
  await addMember(db.pool, a.companyId, clerk, 'clerk');
  await db.pool.query(`insert into auth.users (id, email) values ($1, 'outsider4@example.test')`, [outsider]);
});
afterAll(async () => {
  await db?.close();
});

describe('voucher_links: who can read and write', () => {
  const visible = (userId: string, where = 'true') =>
    db.asRole('authenticated', userId, async (c) => Number((await c.query(`select count(*)::int n from public.voucher_links where ${where}`)).rows[0].n));

  it('members with report.view read their own company’s deliveries, nobody else’s', async () => {
    expect(await visible(a.ownerId, `company_id = '${a.companyId}'`)).toBe(1);
    expect(await visible(viewer, `company_id = '${a.companyId}'`)).toBe(1);
    expect(await visible(a.ownerId, `company_id = '${b.companyId}'`)).toBe(0);
    expect(await visible(outsider)).toBe(0);
  });

  it('a signed-in user cannot write it', async () => {
    const denied = (sql: string) => db.asRole('authenticated', a.ownerId, async (c) => c.query(sql)).then(() => undefined, (e: { code?: string }) => e.code);
    expect(await denied(`update public.voucher_links set qty = 1`)).toBe('42501');
    expect(await denied(`delete from public.voucher_links`)).toBe('42501');
    expect(await denied(`insert into public.voucher_links (company_id, voucher_id, line_no, entry_date, order_id, order_line_id, item_id, qty) select company_id, voucher_id, 9, entry_date, order_id, order_line_id, item_id, 1 from public.voucher_links limit 1`)).toBe('42501');
  });
});

describe('the database refuses what the rules refuse, even for a direct write', () => {
  /** Puts one more stock-out on the invoice (line 2), so a delivery has something to sit on; returns to clean afterwards. */
  const addStockOut = async (qty: string, item = a.uuid('item:bolt'), lineNo = 2) =>
    db.pool.query(
      `insert into public.stock_movements (company_id, voucher_id, line_no, entry_date, financial_year_id, item_id, warehouse_id, direction, qty, value)
       select v.company_id, v.id, $2, v.voucher_date, v.financial_year_id, $3, $4, 'out', $5::numeric, null from public.vouchers v where v.id = $1`,
      [sa.invoice, lineNo, item, sa.main, qty],
    );
  const dropStockOut = (lineNo = 2) => db.pool.query('delete from public.stock_movements where voucher_id = $1 and line_no = $2', [sa.invoice, lineNo]);
  const addLink = (over: { line?: number; order?: string; orderLine?: string; item?: string; qty: string }) =>
    rejected(
      `insert into public.voucher_links (company_id, voucher_id, line_no, entry_date, order_id, order_line_id, item_id, qty)
       select v.company_id, v.id, $2, v.voucher_date, $3, $4, $5, $6::numeric from public.vouchers v where v.id = $1`,
      [sa.invoice, over.line ?? 2, over.order ?? sa.order, over.orderLine ?? 'a', over.item ?? a.uuid('item:bolt'), over.qty],
    );

  it('a delivery past what the order line asked for is refused (OVER_DELIVERY), and nothing is left behind', async () => {
    await addStockOut('14'); // 5 already delivered of 18: 14 more is one too many
    expect(await addLink({ qty: '14' })).toBe('OVER_DELIVERY');
    expect(await count('select count(*) n from public.voucher_links where voucher_id = $1', [sa.invoice])).toBe(1);
    await dropStockOut();
    await addStockOut('13');
    expect(await addLink({ qty: '13' })).toBeUndefined(); // exactly what is pending: fine
    await db.pool.query('delete from public.voucher_links where voucher_id = $1 and line_no = 2', [sa.invoice]);
    await dropStockOut();
  });

  it('a delivery must name a real line of the order, for the same item', async () => {
    await addStockOut('1', a.uuid('item:bolt'));
    expect(await addLink({ qty: '1', orderLine: 'zzz' })).toBe('ORDER_REF_INVALID');
    await dropStockOut();
    await addStockOut('1', a.uuid('item:nut'));
    expect(await addLink({ qty: '1', item: a.uuid('item:nut') })).toBe('ORDER_REF_INVALID'); // line "a" is for bolts
    await dropStockOut();
  });

  it('a delivery must sit on the stock going out on its own line, with the same item and quantity', async () => {
    await addStockOut('2');
    expect(await addLink({ qty: '3' })).toBe('PLAN_INCONSISTENT_LINES'); // the stock says 2
    await dropStockOut();
    expect(await addLink({ qty: '1' })).toMatch(/link_stock_fk/); // no stock line 2 at all
  });

  it('only a sales invoice can deliver', async () => {
    // a stock journal with an Out, and a delivery hung on it
    const journal = mustOk(
      await a.backend.post({
        companyId: a.companyId,
        draft: { id: a.uuid('v:stj'), voucherTypeId: a.uuid('type:stockJournal'), date: '2024-05-13', entries: [{ itemId: a.uuid('item:nut'), warehouseId: sa.main, direction: 'out', qty: '1' }] },
      }),
    ).voucher;
    const r = await rejected(
      `insert into public.voucher_links (company_id, voucher_id, line_no, entry_date, order_id, order_line_id, item_id, qty)
       select company_id, id, 1, voucher_date, $2, 'b', $3, 1 from public.vouchers where id = $1`,
      [journal.id, sa.order, a.uuid('item:nut')],
    );
    expect(r).toBe('PLAN_INCONSISTENT_LINES');
  });

  it('a sales order is a document: it cannot carry journal lines or stock lines', async () => {
    const journal = await rejected(
      `insert into public.journal_lines (company_id, voucher_id, line_no, entry_date, financial_year_id, ledger_id, debit, credit)
       select v.company_id, v.id, n.no, v.voucher_date, v.financial_year_id, $2, case when n.no = 1 then 5 else 0 end, case when n.no = 2 then 5 else 0 end
         from public.vouchers v cross join (values (1), (2)) as n(no) where v.id = $1`,
      [sa.order, a.uuid('ledger:sales')],
    );
    expect(journal).toBe('PLAN_INCONSISTENT_LINES');
    const stock = await rejected(
      `insert into public.stock_movements (company_id, voucher_id, line_no, entry_date, financial_year_id, item_id, warehouse_id, direction, qty, value)
       select company_id, id, 1, voucher_date, financial_year_id, $2, $3, 'out', 1, null from public.vouchers where id = $1`,
      [sa.order, a.uuid('item:bolt'), sa.main],
    );
    expect(stock).toBe('PLAN_INCONSISTENT_LINES');
  });

  it('an invoice must post to the accounts and move stock', async () => {
    await expect(
      db.pool.query('delete from public.journal_lines where voucher_id = $1', [sa.invoice]),
    ).rejects.toMatchObject({ message: 'PLAN_TOO_FEW_LINES' });
    expect(await count('select count(*) n from public.journal_lines where voucher_id = $1', [sa.invoice])).toBe(2);
  });

  it('an order with deliveries cannot be cancelled or shrunk below them by a direct update', async () => {
    expect(await rejected(`update public.vouchers set status = 'cancelled' where id = $1`, [sa.order])).toBe('ORDER_REF_INVALID');
    expect(await rejected(`update public.vouchers set content = jsonb_set(content, '{lines,0,qty}', '"4.0000"') where id = $1`, [sa.order])).toBe('OVER_DELIVERY');
    expect(await rejected(`update public.vouchers set content = jsonb_set(content, '{lines,0,id}', '"renamed"') where id = $1`, [sa.order])).toBe('ORDER_REF_INVALID');
    expect(await rejected(`update public.vouchers set content = jsonb_set(content, '{lines,0,itemId}', to_jsonb($2::text)) where id = $1`, [sa.order, a.uuid('item:nut')])).toBe('ORDER_REF_INVALID');
    // growing it is fine
    expect(await rejected(`update public.vouchers set content = jsonb_set(content, '{lines,0,qty}', '"30.0000"') where id = $1`, [sa.order])).toBeUndefined();
    await db.pool.query(`update public.vouchers set content = jsonb_set(content, '{lines,0,qty}', '"18.0000"') where id = $1`, [sa.order]);
  });
});

describe('the invoice’s customer line is mirrored as a new bill, named by the invoice number', () => {
  const bills = async (voucher: string) =>
    (await db.pool.query(`select ledger_id, side, kind, ref, due_date::text as due, amount::text as amount from public.bill_allocations where voucher_id = $1`, [voucher])).rows;

  it('is a debit new bill on the customer ledger for the total, due on the due date; an order has none', async () => {
    expect(await bills(sa.invoice)).toEqual([
      { ledger_id: partyLedgerId(a.uuid('party:acme'), 'customer'), side: 'debit', kind: 'new', ref: sa.invoiceNumber, due: '2024-06-11', amount: '125.00' },
    ]);
    expect(await bills(sa.order)).toEqual([]);
  });

  it('follows an alteration and disappears with a cancellation', async () => {
    const draft = (qty: string) => ({
      id: a.uuid('v:inv2'), voucherTypeId: a.uuid('type:sales'), date: '2024-05-14', partyId: a.uuid('party:acme'), partyDetails: { partyId: a.uuid('party:acme') },
      salesLedgerId: a.uuid('ledger:sales'), dueDate: '2024-06-13',
      lines: [{ itemId: a.uuid('item:nut'), warehouseId: sa.main, qty, rate: '3.3333' }],
    });
    const inv = mustOk(await a.backend.post({ companyId: a.companyId, draft: draft('3') })).voucher; // 3 × 3.3333 = 9.9999 → 10.00
    expect((await bills(inv.id))[0]).toMatchObject({ ref: inv.number, due: '2024-06-13', amount: '10.00' });
    mustOk(await a.backend.alter({ companyId: a.companyId, voucherId: inv.id, expectedVersion: 1, draft: draft('6') }));
    expect((await bills(inv.id))[0]).toMatchObject({ amount: '20.00' });
    mustOk(await a.backend.cancel({ companyId: a.companyId, voucherId: inv.id, expectedVersion: 2 }));
    expect(await bills(inv.id)).toEqual([]);
  });
});

describe('the posting functions and permissions', () => {
  it('post and alter carry the deliveries (seven and nine arguments); the older signatures are gone', async () => {
    const r = await db.pool.query(
      `select proname, pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and proname in ('post_voucher_atomic', 'alter_voucher_atomic') order by proname`,
    );
    expect(r.rows.map((x) => [x.proname, x.pronargs])).toEqual([['alter_voucher_atomic', 9], ['post_voucher_atomic', 7]]);
  });

  it('a clerk may post sales documents but not alter or cancel them; a viewer may not post', async () => {
    const can = async (user: string, permission: string) => (await db.pool.query('select public.actor_can($1, $2, $3) as ok', [user, a.companyId, permission])).rows[0]?.ok;
    for (const kind of ['sales', 'salesOrder']) {
      expect(await can(clerk, `voucher.${kind}.post`)).toBe(true);
      expect(await can(clerk, `voucher.${kind}.alter`)).toBe(false);
      expect(await can(clerk, `voucher.${kind}.cancel`)).toBe(false);
      expect(await can(viewer, `voucher.${kind}.post`)).toBe(false);
      expect(await can(a.ownerId, `voucher.${kind}.cancel`)).toBe(true);
    }
  });

  it('a document posted with journal lines is refused before anything is written', async () => {
    const r = await rejected(
      `select public.post_voucher_atomic($1, $2, 'r', $3::text::jsonb, $4::text::jsonb, '[]'::jsonb, '[]'::jsonb)`,
      [
        a.ownerId,
        a.companyId,
        JSON.stringify({ id: randomUUID(), voucher_type_id: a.uuid('type:salesOrder'), financial_year_id: (await db.pool.query('select id from public.financial_years where company_id = $1', [a.companyId])).rows[0].id, date: '2024-05-02', content: {} }),
        JSON.stringify([{ ledger_id: a.uuid('ledger:sales'), side: 'debit', amount: '5.00' }, { ledger_id: a.uuid('ledger:sales'), side: 'credit', amount: '5.00' }]),
      ],
    );
    expect(r).toBe('PLAN_INCONSISTENT_LINES');
  });
});

describe('the backfill', () => {
  it('gives a company that already exists the Sales and Sales Order voucher types and their numbering', async () => {
    const w = await pgMasterWorldFactory(db)();
    const kinds = `('sales', 'salesOrder')`;
    await db.pool.query(`delete from public.numbering_series where company_id = $1 and voucher_type_id in (select id from public.voucher_types where company_id = $1 and base_kind in ${kinds})`, [w.companyId]);
    await db.pool.query(`delete from public.voucher_types where company_id = $1 and base_kind in ${kinds}`, [w.companyId]);
    expect(await count(`select count(*) n from public.voucher_types where company_id = $1 and base_kind in ${kinds}`, [w.companyId])).toBe(0);

    const sql = migrationFiles().find((m) => m.name.includes('sales_phase6b'))?.sql ?? '';
    const from = sql.indexOf('-- Companies that already exist');
    const to = sql.indexOf('-- Deliveries: which invoice line');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    await db.pool.query(sql.slice(from, to));

    const types = (await db.pool.query(`select name, base_kind, is_system from public.voucher_types where company_id = $1 and base_kind in ${kinds} order by base_kind`, [w.companyId])).rows;
    expect(types).toEqual([
      { name: 'Sales', base_kind: 'sales', is_system: true },
      { name: 'Sales Order', base_kind: 'salesOrder', is_system: true },
    ]);
    const series = (await db.pool.query(`select prefix from public.numbering_series s join public.voucher_types t on t.id = s.voucher_type_id where s.company_id = $1 and t.base_kind in ${kinds} order by prefix`, [w.companyId])).rows;
    expect(series.map((s) => s.prefix)).toEqual(['SAL/24-25/', 'SO/24-25/']);
  });
});
