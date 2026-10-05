/**
 * What the database promises about the Delivery Challan:
 *   - every company has the type and its DC/ numbering
 *   - a posted challan has stock lines, all going out, and no journal
 *   - a clerk may post one; cancelling it puts the goods back
 *   - a sales invoice bills a challan's lines without moving stock again; more than went out is refused, even written straight to the table,
 *     and an invoiced challan cannot be cancelled
 */
import { mustOk } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { addMember } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let a: PgMasterWorld;
let main: string;
const clerk = randomUUID();

const rejected = (sql: string, values: unknown[] = []) => db.pool.query(sql, values).then(() => undefined, (e: { message?: string }) => e.message);

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  a = await pgMasterWorldFactory(db)();
  const create = async (kind: string, id: string, data: unknown) =>
    mustOk(await a.backend.execute({ companyId: a.companyId, command: { op: 'create', kind, id, data } }));
  await create('stockItem', a.uuid('item:bolt'), { name: 'Bolt', unitId: a.uuid('unit:Nos'), itemType: 'finished' });
  await create('party', a.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'] });
  await create('ledger', a.uuid('l:sales'), { name: 'Sales', groupId: a.uuid('group:sales-accounts') });
  main = (await a.backend.load(a.companyId)).warehouses[0]?.id as string;
  mustOk(
    await a.backend.post({
      companyId: a.companyId,
      draft: { id: a.uuid('v:open'), voucherTypeId: a.uuid('type:stockOpening'), date: '2024-04-01', itemId: a.uuid('item:bolt'), warehouseId: main, qty: '100', rate: '5' },
    }),
  );
  await addMember(db.pool, a.companyId, clerk, 'clerk');
});
afterAll(async () => {
  await db?.close();
});

const challan = (id: string, purpose: 'sale' | 'foc', qty: string) => ({
  id,
  voucherTypeId: a.uuid('type:deliveryChallan'),
  date: '2024-05-01',
  partyId: a.uuid('party:acme'),
  partyDetails: { partyId: a.uuid('party:acme'), mailingName: 'Acme Ltd' },
  purpose,
  lines: [{ id: 'l1', itemId: a.uuid('item:bolt'), warehouseId: main, qty, rate: '12' }],
});
const held = async () =>
  Number(
    (
      await db.pool.query(
        `select coalesce(sum(case direction when 'in' then qty else -qty end), 0) n from public.stock_movements where company_id = $1 and item_id = $2`,
        [a.companyId, a.uuid('item:bolt')],
      )
    ).rows[0]?.n,
  );

describe('the Delivery Challan', () => {
  it('is a voucher type of the company with DC numbering', async () => {
    const r = await db.pool.query(
      `select s.prefix from public.voucher_types t join public.numbering_series s on s.voucher_type_id = t.id where t.company_id = $1 and t.base_kind = 'deliveryChallan'`,
      [a.companyId],
    );
    expect(r.rows.map((x) => x.prefix)).toEqual(['DC/24-25/']);
  });

  it('takes the goods out and posts no journal', async () => {
    const sale = mustOk(await a.backend.post({ companyId: a.companyId, draft: challan(a.uuid('v:dc1'), 'sale', '40') }));
    expect(sale.voucher.number).toBe('DC/24-25/0001');
    const foc = mustOk(await a.backend.post({ companyId: a.companyId, draft: challan(a.uuid('v:dc2'), 'foc', '10') }));
    expect(foc.voucher.number).toBe('DC/24-25/0002');
    expect(await held()).toBe(50);
    const journal = await db.pool.query(`select count(*)::int n from public.journal_lines where voucher_id in ($1, $2)`, [a.uuid('v:dc1'), a.uuid('v:dc2')]);
    expect(journal.rows[0]?.n).toBe(0);
  });

  it('a written-only challan posts with no stock and no journal: closing out job work where nothing of ours moves', async () => {
    const written = {
      id: a.uuid('v:dc-written'),
      voucherTypeId: a.uuid('type:deliveryChallan'),
      date: '2024-05-01',
      partyId: a.uuid('party:acme'),
      partyDetails: { partyId: a.uuid('party:acme'), mailingName: 'Acme Ltd' },
      purpose: 'foc',
      lines: [{ id: 'l1', description: 'Machining job 44 closed, part returned', unit: 'Nos', qty: '1', rate: '0' }],
    };
    const posted = mustOk(await a.backend.post({ companyId: a.companyId, draft: written }));
    const stock = await db.pool.query(`select count(*)::int n from public.stock_movements where voucher_id = $1`, [a.uuid('v:dc-written')]);
    const journal = await db.pool.query(`select count(*)::int n from public.journal_lines where voucher_id = $1`, [a.uuid('v:dc-written')]);
    expect(stock.rows[0]?.n).toBe(0);
    expect(journal.rows[0]?.n).toBe(0);
    expect(posted.voucher.status).toBe('posted');
  });

  it('a clerk may post a challan but not alter or cancel one', async () => {
    const can = async (permission: string) => (await db.pool.query('select public.actor_can($1, $2, $3) as ok', [clerk, a.companyId, permission])).rows[0]?.ok;
    expect(await can('voucher.deliveryChallan.post')).toBe(true);
    expect(await can('voucher.deliveryChallan.alter')).toBe(false);
    expect(await can('voucher.deliveryChallan.cancel')).toBe(false);
  });

  it('refuses a challan whose stock comes in', async () => {
    const msg = await rejected(`update public.stock_movements set direction = 'in', value = 1 where voucher_id = $1`, [a.uuid('v:dc1')]);
    expect(msg).toMatch(/STOCK_LINE_INVALID/);
  });

  it('cancelling puts the goods back', async () => {
    mustOk(await a.backend.cancel({ companyId: a.companyId, voucherId: a.uuid('v:dc1') as never, expectedVersion: 1 }));
    expect(await held()).toBe(90);
  });
});

describe('an invoice against a challan', () => {
  const invoice = (id: string, qty: string) => ({
    id,
    voucherTypeId: a.uuid('type:sales'),
    date: '2024-05-05',
    partyId: a.uuid('party:acme'),
    partyDetails: { partyId: a.uuid('party:acme'), mailingName: 'Acme Ltd' },
    salesLedgerId: a.uuid('l:sales'),
    dueDate: '2024-05-05',
    lines: [{ itemId: a.uuid('item:bolt'), qty, rate: '12', challanRef: { challanId: a.uuid('v:dc3'), lineId: 'l1' } }],
  });

  it('bills the challan without moving stock; more than went out is refused', async () => {
    mustOk(await a.backend.post({ companyId: a.companyId, draft: challan(a.uuid('v:dc3'), 'sale', '20') }));
    const before = await held();
    const over = await a.backend.post({ companyId: a.companyId, draft: invoice(a.uuid('v:inv-over'), '25') });
    expect(over.ok).toBe(false);
    mustOk(await a.backend.post({ companyId: a.companyId, draft: invoice(a.uuid('v:inv1'), '15') }));
    expect(await held()).toBe(before);
    const stock = await db.pool.query(`select count(*)::int n from public.stock_movements where voucher_id = $1`, [a.uuid('v:inv1')]);
    expect(stock.rows[0]?.n).toBe(0);
  });

  it('the database itself refuses billing beyond what went out', async () => {
    const msg = await rejected(
      `update public.vouchers set content = jsonb_set(content, '{lines,0,qty}', '"30.0000"') where id = $1`,
      [a.uuid('v:inv1')],
    );
    expect(msg).toMatch(/OVER_DELIVERY/);
  });

  it('an invoiced challan cannot be cancelled', async () => {
    const r = await a.backend.cancel({ companyId: a.companyId, voucherId: a.uuid('v:dc3') as never, expectedVersion: 1 });
    expect(r.ok).toBe(false);
    const msg = await rejected(`update public.vouchers set status = 'cancelled' where id = $1`, [a.uuid('v:dc3')]);
    expect(msg).toMatch(/ORDER_HAS_DELIVERIES|CANCELLED_WITH_LINES/);
  });
});

describe('the returnable challan', () => {
  it('goes out to a supplier and its return brings the same back — once', async () => {
    await a.backend.execute({ companyId: a.companyId, command: { op: 'create', kind: 'party', id: a.uuid('party:repair'), data: { name: 'Repair Works', roles: ['vendor'] } } });
    const details = { partyId: a.uuid('party:repair'), mailingName: 'Repair Works' };
    const lines = [{ id: 'r1', itemId: a.uuid('item:bolt'), warehouseId: main, qty: '5', rate: '12' }];
    const before = await held();
    const sent = mustOk(await a.backend.post({ companyId: a.companyId, draft: { id: a.uuid('v:rc1'), voucherTypeId: a.uuid('type:returnableChallan'), date: '2024-05-10', partyId: a.uuid('party:repair'), partyDetails: details, lines } }));
    expect(sent.voucher.number).toBe('RC/24-25/0001');
    expect(await held()).toBe(before - 5);
    const back = (id: string) => ({ id, voucherTypeId: a.uuid('type:returnableChallan'), date: '2024-05-20', partyId: a.uuid('party:repair'), partyDetails: details, returnOf: a.uuid('v:rc1'), lines });
    mustOk(await a.backend.post({ companyId: a.companyId, draft: back(a.uuid('v:rc1-back')) }));
    expect(await held()).toBe(before);
    expect((await a.backend.post({ companyId: a.companyId, draft: back(a.uuid('v:rc1-again')) })).ok).toBe(false);
    expect((await a.backend.cancel({ companyId: a.companyId, voucherId: a.uuid('v:rc1') as never, expectedVersion: 1 })).ok).toBe(false);
  });

  it('the database keeps one return per challan, and a challan’s stock going the right way', async () => {
    const dup = await rejected(
      `insert into public.vouchers (id, company_id, voucher_type_id, financial_year_id, series_id, number, voucher_date, status, version, revision, content, created_by)
       select gen_random_uuid(), company_id, voucher_type_id, financial_year_id, series_id, 'RC/X', voucher_date, 'posted', 1, 0, content, created_by
         from public.vouchers where id = $1`,
      [a.uuid('v:rc1-back')],
    );
    expect(dup).toMatch(/duplicate key|vouchers_one_return_per_challan/);
    const wrongWay = await rejected(`update public.stock_movements set direction = 'in', value = 1 where voucher_id = $1`, [a.uuid('v:rc1')]);
    expect(wrongWay).toMatch(/STOCK_LINE_INVALID/);
  });
});
