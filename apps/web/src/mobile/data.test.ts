import { MemoryBackend } from '@minimalerp/adapter-memory';
import { deterministicUuid, formatMoney, localDate } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { partyRows, partyTotals } from '../reports/outstandingReports';
import { voucherListRows } from '../reports/voucherLists';
import { TRANSACTION_GROUPS, docList, docView, goToHits, homeFigures, itemList, itemPage, listTitleOf, partyList, partyPage } from './data';

const TODAY = '2026-06-30';
const id = (kind: string, name: string) => deterministicUuid(`demo|${kind}|${name}`);

async function demo(): Promise<Books> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

describe('what the mobile screens show is what the desktop reports say', () => {
  it('the Gateway’s receivable and payable are Outstanding’s own totals', async () => {
    const books = await demo();
    const home = homeFigures(books, TODAY);
    const totals = (side: 'receivable' | 'payable') => partyTotals(partyRows({ vouchers: books.vouchers, lines: books.lines, masters: books.masters, side, asOn: localDate(TODAY) }));
    expect(home.receivable).toBe(totals('receivable').pending);
    expect(home.payable).toBe(totals('payable').pending);
    expect(home.receivableOverdue).toBeGreaterThan(0n);
    expect(home.salesToday).toBe(0n); // nothing was sold on that day
    expect(home.dueLines.length).toBeGreaterThan(0); // the demo's open orders
  });

  it('a party’s page: its balance, its open bills and its documents, newest first', async () => {
    const books = await demo();
    const abc = partyPage(books, id('party', 'ABC Industries'), TODAY)!;
    expect(abc.party.name).toBe('ABC Industries');
    expect(abc.payable).toBeUndefined(); // a customer only
    const listed = partyList(books, TODAY).find((r) => r.partyId === abc.party.id)!;
    expect(listed.receivable).toBe(abc.receivable?.balance);
    expect(abc.receivable?.bills.reduce((t, b) => t + b.pending, 0n)).toBeGreaterThan(0n);
    expect(abc.documents.length).toBeGreaterThan(0);
    expect([...abc.documents].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).map((d) => d.date)).toEqual(abc.documents.map((d) => d.date));
    // Kumar is both: it has a side of each
    const kumar = partyPage(books, id('party', 'Kumar Engineering Works'), TODAY)!;
    expect(kumar.receivable).toBeDefined();
    expect(kumar.payable).toBeDefined();
    expect(partyPage(books, 'nobody', TODAY)).toBeUndefined();
  });

  it('stock: every active item is listed with what the book holds, and an item’s page with its godowns and movements', async () => {
    const books = await demo();
    const rows = itemList(books, TODAY);
    const oil = rows.find((r) => r.name === 'Machine Oil')!;
    expect(oil.closing.qty).toBe(800000n); // 120 brought forward, 40 sold
    expect(oil.available).toBe(oil.closing.qty - oil.committed);
    expect(rows.map((r) => r.name)).toEqual([...rows.map((r) => r.name)].sort((a, b) => a.localeCompare(b)));
    const page = itemPage(books, oil.itemId, TODAY)!;
    expect(page.godowns.reduce((t, g) => t + g.qty, 0n)).toBe(800000n);
    expect(page.movements[0]?.balance).toBe(800000n); // newest first: the last movement leaves what is there now
    expect(itemPage(books, 'nothing', TODAY)).toBeUndefined();
  });

  it('a voucher list is the desktop’s list, newest first — and every list of Transactions has a title', async () => {
    const books = await demo();
    const desktop = voucherListRows({ vouchers: books.vouchers, lines: books.lines, masters: books.masters, orders: books.orders, kind: 'sales', asOf: localDate(TODAY) });
    expect(docList(books, 'sales', TODAY)).toEqual([...desktop].reverse());
    for (const l of TRANSACTION_GROUPS.flatMap((g) => g.lists)) expect(listTitleOf(l.kind)).toBe(l.title);
    expect(TRANSACTION_GROUPS.map((g) => g.group)).toEqual(['Sales', 'Purchase', 'Inventory', 'General']);
  });

  it('an invoice is shown with the engine’s own figures; an accounting voucher with what it posted', async () => {
    const books = await demo();
    const row = docList(books, 'sales', TODAY)[0]!;
    const view = docView(books, row.voucherId)!;
    expect(view.item?.kind).toBe('sales');
    expect(view.item?.preview.grand).toBe(row.amount);
    expect(view.bill?.pending).toBe(row.pending);
    const payment = docList(books, 'payment', TODAY)[0]!;
    const paid = docView(books, payment.voucherId)!;
    expect(paid.item).toBeUndefined();
    const dr = paid.journal.filter((l) => l.side === 'debit').reduce((t, l) => t + l.amount, 0n);
    const cr = paid.journal.filter((l) => l.side === 'credit').reduce((t, l) => t + l.amount, 0n);
    expect(formatMoney(dr as never)).toBe(formatMoney(cr as never));
    expect(dr).toBe(payment.amount);
    expect(docView(books, 'no-such-voucher')).toBeUndefined();
  });

  it('Go to finds parties, items and vouchers by number; under two letters it finds nothing', async () => {
    const books = await demo();
    expect(goToHits(books, 'a')).toEqual([]);
    const abc = goToHits(books, 'abc');
    expect(abc.map((h) => h.open.page)).toEqual(expect.arrayContaining(['party', 'item']));
    const sal = goToHits(books, 'SAL/');
    expect(sal.length).toBeGreaterThan(0);
    expect(sal.every((h) => h.open.page === 'doc')).toBe(true);
    expect(goToHits(books, 'zzzz-nothing')).toEqual([]);
  });
});
