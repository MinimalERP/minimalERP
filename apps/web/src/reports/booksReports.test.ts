import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type GroupId, applyGridQuery, formatMoney, localDate } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { bookGroupIds, tbColumns, tbRows } from './booksReports';
import { billColumns, billRows, outstandingRowClass, partyColumns, partyRows, partyTotals } from './outstandingReports';

async function demo(): Promise<{ books: Books; range: { from: ReturnType<typeof localDate>; to: ReturnType<typeof localDate> } }> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  const fy = r.value.masters.financialYears[0];
  return { books: r.value, range: { from: localDate(fy?.start as string), to: localDate(fy?.end as string) } };
}

const money = (m: bigint) => formatMoney(m as never);

describe('the Trial Balance over the demo company', () => {
  it('lists the primary groups and debit equals credit', async () => {
    const { books, range } = await demo();
    const rows = tbRows({ masters: books.masters, lines: books.lines, range });
    expect(rows.map((r) => r.name)).toEqual(['Capital Account', 'Current Assets', 'Current Liabilities', 'Indirect Expenses', 'Sales Accounts', 'Suspense A/c']);
    expect(rows.every((r) => r.kind === 'group' && r.rowType === 'tb')).toBe(true);
    expect(rows.reduce((s, r) => s + r.debit, 0n)).toBe(rows.reduce((s, r) => s + r.credit, 0n));
    expect(rows.reduce((s, r) => s + r.closing, 0n)).toBe(0n);
  });

  it('a group opens one level down, and its children add up to it', async () => {
    const { books, range } = await demo();
    const top = tbRows({ masters: books.masters, lines: books.lines, range });
    const assets = top.find((r) => r.name === 'Current Assets');
    const kids = tbRows({ masters: books.masters, lines: books.lines, range, parentIds: [assets?.id as GroupId] });
    expect(kids.map((r) => r.name)).toEqual(expect.arrayContaining(['Bank Accounts', 'Cash-in-Hand', 'Sundry Debtors']));
    expect(kids.reduce((s, r) => s + r.closing, 0n)).toBe(assets?.closing);
    expect(kids.reduce((s, r) => s + r.debit, 0n)).toBe(assets?.debit);
  });

  it('the columns sort and filter like any report grid', async () => {
    const { books, range } = await demo();
    const rows = tbRows({ masters: books.masters, lines: books.lines, range });
    const cols = tbColumns();
    expect(cols.map((c) => c.label)).toEqual(['Particulars', 'Type', 'Opening', 'Debit', 'Credit', 'Closing']);
    const byClosing = applyGridQuery(rows, cols, { sort: [{ column: 'closing', direction: 'desc' }], filters: [], quick: '' } as never);
    expect(byClosing[0]?.name).toBe('Current Assets');
    const sales = applyGridQuery(rows, cols, { sort: [], filters: [], quick: 'sales' } as never);
    expect(sales.map((r) => r.name)).toEqual(['Sales Accounts']);
  });
});

describe('the Cash Book and the Bank Book', () => {
  it('the cash book is the Cash-in-Hand ledgers, the bank book the Bank Accounts (and Bank OD) ledgers — used or not', async () => {
    const { books, range } = await demo();
    const cash = tbRows({ masters: books.masters, lines: books.lines, range, parentIds: bookGroupIds(books.masters, 'cash'), includeEmpty: true });
    expect(cash.map((r) => [r.name, money(r.closing)])).toEqual([['Cash', '20000.00'], ['Petty Cash Box', '23000.00']]);
    const bank = tbRows({ masters: books.masters, lines: books.lines, range, parentIds: bookGroupIds(books.masters, 'bank'), includeEmpty: true });
    expect(bank.map((r) => [r.name, money(r.closing)])).toEqual([['HDFC Bank Current A/c', '756600.00']]);
    expect(cash.every((r) => r.kind === 'ledger')).toBe(true);
  });
});

describe('Outstanding over the demo company', () => {
  const asOn = localDate('2026-09-21');

  it('receivables: a row per customer whose balance is the ledger balance; the buckets add up to what is pending', async () => {
    const { books } = await demo();
    const rows = partyRows({ vouchers: books.vouchers, lines: books.lines, masters: books.masters, side: 'receivable', asOn });
    expect(rows.map((r) => r.name)).toEqual(['ABC Industries', 'Sharma Traders']);
    for (const r of rows) {
      const bucketed = Object.values(r.buckets).reduce((s, x) => s + x, 0n);
      expect(bucketed, r.name).toBe(r.pending);
      expect(r.balance, r.name).toBe(r.pending - r.advances + r.notInBills);
    }
    const t = partyTotals(rows);
    expect(money(t.pending)).toBe('135000.00');
    expect(money(t.balance)).toBe('125000.00');
  });

  it('a bill row has its due date, days overdue and bucket; overdue ones are bold', async () => {
    const { books } = await demo();
    const bills = billRows({ vouchers: books.vouchers, masters: books.masters, side: 'receivable', asOn });
    const inv = bills.find((b) => b.ref === 'INV-001');
    expect(inv?.daysOverdue).toBeGreaterThan(90);
    expect(outstandingRowClass(inv as never)).toBe('open-line');
    // as on a day before anything was due, nothing is overdue
    const early = billRows({ vouchers: books.vouchers, masters: books.masters, side: 'receivable', asOn: localDate('2026-04-02') });
    expect(early.every((b) => b.daysOverdue === 0)).toBe(true);
    expect(early.every((b) => outstandingRowClass(b) === '')).toBe(true);
  });

  it('one party’s bills, and the column sets of both grids', async () => {
    const { books } = await demo();
    const parties = partyRows({ vouchers: books.vouchers, lines: books.lines, masters: books.masters, side: 'receivable', asOn });
    const abc = parties.find((p) => p.name === 'ABC Industries');
    const own = billRows({ vouchers: books.vouchers, masters: books.masters, side: 'receivable', asOn, ledgerId: abc?.ledgerId });
    expect(own.map((b) => b.ref)).toEqual(['INV-001', 'SAL/26-27/0001']);
    expect(partyColumns('receivable')[0]?.label).toBe('Customer');
    expect(partyColumns('payable')[0]?.label).toBe('Supplier');
    expect(billColumns().map((c) => c.label)).toEqual(['Bill / ref', 'Party', 'Bill date', 'Due', 'Pending', 'Days overdue', 'Ageing']);
  });

  it('payables list the suppliers we owe, reconciled the same way', async () => {
    const { books } = await demo();
    const rows = partyRows({ vouchers: books.vouchers, lines: books.lines, masters: books.masters, side: 'payable', asOn });
    expect(rows.map((r) => [r.name, money(r.balance)])).toEqual([['Bharat Chemicals', '1500.00'], ['Steel Supplies Pvt Ltd', '110000.00']]);
  });
});
