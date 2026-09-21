/**
 * Values read back from PostgreSQL are the SAME values the browser and the memory backend hold (regression for the Phase 8 report).
 *
 * A voucher's content is stored as JSON, where money is decimal text ("400.00"); the memory backend keeps the parsed draft, where money is a bigint.
 * Every consumer that reads a voucher back — `openBills`, Outstanding, the party ageing, the voucher lists — does arithmetic on those amounts, so
 * an un-normalised read gives text concatenation instead of a sum ("100000" + "400.00"). The Postgres adapter therefore normalises what it reads
 * through the voucher kind's own schema. This runs one scenario on the memory backend and on PostgreSQL and requires the read-side answers to be
 * identical.
 */
import {
  type LedgerId,
  type LocalDate,
  type Voucher,
  outstandingBills,
  outstandingByParty,
  openBills,
  parseQty,
  parseRate,
  partyLedgerId,
} from '@minimalerp/domain';
import { type MasterWorld, buildMasterWorld, mustOk } from '@minimalerp/testkit';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { pgMasterWorldFactory } from './harness/pgMasterWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;

/** A voucher's content, read loosely: the test looks at a handful of named fields. */
type Content = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
});
afterAll(async () => {
  await db?.close();
});

/** The scenario: a purchase bill part-paid against its number, an on-account receipt, a sales invoice, a journal bill, an opening bill. */
async function scenario(w: MasterWorld): Promise<void> {
  const create = async (kind: string, id: string, data: unknown) =>
    mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
  await create('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
  await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'], creditDays: 30 });
  await create('party', w.uuid('party:steel'), { name: 'Steel Supplier', roles: ['vendor'], creditDays: 30 });
  await create('party', w.uuid('party:other'), { name: 'Other Supplier', roles: ['vendor'] });
  await create('ledger', w.uuid('ledger:sales'), { name: 'Domestic Sales', groupId: w.uuid('group:sales-accounts') });
  await create('ledger', w.uuid('ledger:purchases'), { name: 'Purchases', groupId: w.uuid('group:purchase-accounts') });
  await create('ledger', w.uuid('ledger:freight'), { name: 'Freight', groupId: w.uuid('group:indirect-expenses') });
  const main = (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
  const post = async (draft: unknown) => mustOk(await w.backend.post({ companyId: w.companyId, draft }));
  const details = (p: string) => ({ partyId: w.uuid(`party:${p}`), mailingName: 'X' });
  const vendor = (p: string) => partyLedgerId(w.uuid(`party:${p}`) as never, 'vendor');
  const customer = partyLedgerId(w.uuid('party:acme') as never, 'customer');

  // a bill brought forward as an opening balance (the amounts live at the top level of the content)
  await post({ id: w.uuid('v:open'), voucherTypeId: w.uuid('type:opening'), date: '2024-04-01', ledgerId: customer, side: 'debit', amount: '5000', offsetLedgerId: (await w.backend.load(w.companyId)).openingDifferenceLedger()?.id, allocations: [{ kind: 'new', ref: 'INV-001', dueDate: '2024-04-30', amount: '5000' }] });
  // a purchase invoice: the supplier's bill, 100 × 10 = 1,000.00, and a payment of 400 against its number
  await post({
    id: w.uuid('v:pur'), voucherTypeId: w.uuid('type:purchase'), date: '2024-05-12', partyId: w.uuid('party:steel'), partyDetails: details('steel'),
    purchaseLedgerId: w.uuid('ledger:purchases'), billNo: 'SS/889', dueDate: '2024-06-11', lines: [{ itemId: w.uuid('item:bolt'), warehouseId: main, qty: '100', rate: '10' }],
  });
  await post({
    id: w.uuid('v:pay'), voucherTypeId: w.uuid('type:payment'), date: '2024-05-20', accountLedgerId: w.uuid('ledger:cash'),
    lines: [{ ledgerId: vendor('steel'), amount: '400', allocations: [{ kind: 'against', ref: 'SS/889', amount: '400' }] }],
  });
  // a sales invoice (its bill is named by its own number) and a receipt on account
  await post({
    id: w.uuid('v:sal'), voucherTypeId: w.uuid('type:sales'), date: '2024-05-15', partyId: w.uuid('party:acme'), partyDetails: details('acme'),
    salesLedgerId: w.uuid('ledger:sales'), dueDate: '2024-06-14', lines: [{ itemId: w.uuid('item:bolt'), warehouseId: main, qty: '5', rate: '25' }],
  });
  await post({
    id: w.uuid('v:rec'), voucherTypeId: w.uuid('type:receipt'), date: '2024-05-25', accountLedgerId: w.uuid('ledger:cash'),
    lines: [{ ledgerId: customer, amount: '100', allocations: [{ kind: 'onAccount', amount: '100' }] }],
  });
  // a journal that raises a bill on another supplier
  await post({
    id: w.uuid('v:jrn'), voucherTypeId: w.uuid('type:journal'), date: '2024-05-26',
    entries: [
      { ledgerId: w.uuid('ledger:freight'), side: 'debit', amount: '1500' },
      { ledgerId: vendor('other'), side: 'credit', amount: '1500', allocations: [{ kind: 'new', ref: 'BC-77', dueDate: '2024-06-25', amount: '1500' }] },
    ],
  });
}

/** What the report consumers say, in a form that does not depend on ids (each world has its own). */
async function answers(w: MasterWorld) {
  const masters = await w.backend.load(w.companyId);
  const vouchers: readonly Voucher[] = await w.backend.list(w.companyId);
  const lines = await w.backend.lines({ companyId: w.companyId });
  const ledgerOf = (party: string, role: 'customer' | 'vendor'): LedgerId => partyLedgerId(w.uuid(`party:${party}`) as never, role) as LedgerId;
  const bills = (party: string, role: 'customer' | 'vendor') =>
    openBills(vouchers, masters, ledgerOf(party, role)).map((b) => [b.ref, b.side, b.pending, b.dueDate] as const);
  const asOn = '2024-09-30' as LocalDate;
  const party = (side: 'receivable' | 'payable') =>
    outstandingByParty({ vouchers, lines, masters, side, asOn }).map((p) => [p.name, p.bills, p.pending, p.advances, p.notInBills, p.balance, p.buckets] as const);
  const billRows = (side: 'receivable' | 'payable') =>
    outstandingBills({ vouchers, masters, side, asOn }).map((b) => [b.party, b.ref, b.billDate, b.dueDate, b.pending, b.daysOverdue, b.bucket] as const);
  return {
    supplier: bills('steel', 'vendor'),
    otherSupplier: bills('other', 'vendor'),
    customer: bills('acme', 'customer'),
    receivable: party('receivable'),
    payable: party('payable'),
    receivableBills: billRows('receivable'),
    payableBills: billRows('payable'),
    vouchers,
  };
}

describe('what is read back from PostgreSQL is what the memory backend holds', () => {
  it('bills, Outstanding and the party ageing come out the same, to the paisa', async () => {
    const memory = buildMasterWorld();
    await scenario(memory);
    const pg = await pgMasterWorldFactory(db)();
    await scenario(pg);
    const m = await answers(memory);
    const p = await answers(pg);

    // the expected figures, stated (so a bug that breaks both sides the same way would still fail): 1,000.00 less the 400.00 paid
    expect(p.supplier).toEqual([['SS/889', 'credit', 60000n, '2024-06-11']]);
    expect(p.otherSupplier).toEqual([['BC-77', 'credit', 150000n, '2024-06-25']]);
    expect(p.customer.map((b) => [b.at(0), b.at(2)])).toEqual([['INV-001', 500000n], [expect.stringMatching(/^SAL\//), 12500n]]);
    expect(p.payable.map((r) => [r[0], r[2], r[5]])).toEqual([['Other Supplier', 150000n, 150000n], ['Steel Supplier', 60000n, 60000n]]);
    expect(p.receivable.map((r) => [r[0], r[2], r[3], r[5]])).toEqual([['Acme Ltd', 512500n, 10000n, 502500n]]); // bills 5,125.00, advance 100.00, balance 5,025.00

    // and identical to what the memory backend answers
    expect(p.supplier).toEqual(m.supplier);
    expect(p.otherSupplier).toEqual(m.otherSupplier);
    expect(p.customer).toEqual(m.customer);
    expect(p.receivable).toEqual(m.receivable);
    expect(p.payable).toEqual(m.payable);
    expect(p.receivableBills).toEqual(m.receivableBills);
    expect(p.payableBills).toEqual(m.payableBills);
  });

  it('a voucher’s money is a bigint after a read — allocations, journal entries, opening balances — not the text it is stored as', async () => {
    const pg = await pgMasterWorldFactory(db)();
    await scenario(pg);
    const vouchers = await pg.backend.list(pg.companyId);
    const byId = (id: string) => vouchers.find((v) => v.id === pg.uuid(id))?.content as unknown as Content;
    expect(byId('v:pay').lines[0].amount).toBe(40000n);
    expect(byId('v:pay').lines[0].allocations[0].amount).toBe(40000n);
    expect(byId('v:rec').lines[0].allocations[0]).toMatchObject({ kind: 'onAccount', amount: 10000n });
    expect(byId('v:jrn').entries[1].allocations[0].amount).toBe(150000n);
    expect(byId('v:open')).toMatchObject({ amount: 500000n });
    expect(byId('v:open').allocations[0].amount).toBe(500000n);
    // quantities and rates stay the text they are (they are not money)
    expect(typeof byId('v:pur').lines[0].qty).toBe('string');
    expect(parseQty(byId('v:pur').lines[0].qty)).toBe(parseQty('100'));
    expect(parseRate(byId('v:pur').lines[0].rate)).toBe(parseRate('10'));
    expect(byId('v:pur').billNo).toBe('SS/889');
    // one voucher, read by id, is the same as the same voucher in the list; and the post outcome carries the normalised content too
    const one = await pg.backend.get(pg.companyId, pg.uuid('v:pay') as never);
    expect(one?.content).toEqual(byId('v:pay'));
    const replay = mustOk(await pg.backend.post({ companyId: pg.companyId, draft: byId('v:pay') }));
    expect(replay.replayed).toBe(true);
    expect((replay.voucher.content as unknown as Content).lines[0].amount).toBe(40000n);
  });

  it('a stored voucher whose kind is unknown, or whose content no longer parses, is returned as stored — a read never throws', async () => {
    const pg = await pgMasterWorldFactory(db)();
    await scenario(pg);
    await db.pool.query(`update public.vouchers set content = content - 'accountLedgerId' where id = $1`, [pg.uuid('v:pay')]); // no longer a valid payment
    const vouchers = await pg.backend.list(pg.companyId);
    const pay = vouchers.find((v) => v.id === pg.uuid('v:pay'));
    expect(pay).toBeDefined();
    expect((pay?.content as unknown as Content).lines[0].amount).toBe('400.00'); // as stored
  });
});
