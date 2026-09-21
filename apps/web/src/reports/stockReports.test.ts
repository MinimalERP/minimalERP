import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type StockItemId, applyGridQuery, deterministicUuid, formatMoney, localDate, onlyVoucherTypes } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { availableOf, stockLedgerColumns, stockLedgerOf, stockSummaryColumns, stockSummaryRows, summaryTotals } from './stockReports';

const item = (name: string) => deterministicUuid(`demo|stockItem|${name}`) as StockItemId;

async function demo(): Promise<{ books: Books; from: ReturnType<typeof localDate>; to: ReturnType<typeof localDate> }> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  const fy = r.value.masters.financialYears[0];
  return { books: r.value, from: localDate(fy?.start as string), to: localDate(fy?.end as string) };
}

describe('the demo company’s stock', () => {
  it('opens with the stock the item forms brought forward, then a transfer and a conversion moved it', async () => {
    const { books, from, to } = await demo();
    const rows = stockSummaryRows(books.masters, books.stock, from, to);
    expect(rows.map((r) => r.name)).toEqual(['ABC Hex Bolt M8', 'Fabricated Frame', 'Machine Oil', 'Mounting Bracket', 'MS Rod 12mm', 'MS Sheet 2mm']); // MS Scrap has no stock
    const by = (n: string) => rows.find((r) => r.name === n);
    expect(by('MS Sheet 2mm')?.closing).toEqual({ qty: 22_000_000n, value: 12_760_000n }); // 2,500 − 300 Kg; 58.00 average → 1,27,600.00
    // the transfer between godowns leaves the item as it was; the sales invoice against ABC's PO took 2,000 out at the 4.50 average
    expect(by('ABC Hex Bolt M8')?.closing).toEqual({ qty: 30_000_000n, value: 1_350_000n });
    expect(by('Fabricated Frame')?.closing).toEqual({ qty: 600_000n, value: 5_700_000n });
  });

  it('the summary reconciles, item by item and in total: closing = opening + inward − outward', async () => {
    const { books, from, to } = await demo();
    const rows = stockSummaryRows(books.masters, books.stock, from, to);
    for (const r of rows) {
      expect(r.closing.qty).toBe(r.opening.qty + r.inward.qty - r.outward.qty);
      expect(r.closing.value).toBe(r.opening.value + r.inward.value - r.outward.value);
    }
    const t = summaryTotals(rows);
    expect(formatMoney(t.closing as never)).toBe('346140.00'); // 3,68,100.00 less the goods the demo's two invoices sold (9,000 + 4,560 + 8,400 at cost)
    expect(t.closing).toBe(t.opening + t.inward - t.outward);
  });

  it('a later period opens with the earlier one’s closing', async () => {
    const { books, from } = await demo();
    const mid = localDate(`${from.slice(0, 4)}-${from.slice(5, 7)}-${String(Number(from.slice(8, 10)) + 15).padStart(2, '0')}`);
    const first = stockSummaryRows(books.masters, books.stock, from, mid);
    const second = stockSummaryRows(books.masters, books.stock, localDate(`${mid.slice(0, 8)}${String(Number(mid.slice(8, 10)) + 1).padStart(2, '0')}`), localDate('2999-12-31'));
    for (const r of second) {
      const before = first.find((x) => x.itemId === r.itemId);
      if (before) expect(r.opening).toEqual(before.closing);
    }
  });

  it('an item’s ledger lists every movement with the true running balance, and ends where the summary does', async () => {
    const { books, from, to } = await demo();
    const l = stockLedgerOf(books.masters, books.stock, books.vouchers, item('ABC Hex Bolt M8'), from, to);
    expect(l.rows.map((r) => [r.voucherType, r.inQty, r.outQty, r.balance.qty])).toEqual([
      ['Opening Stock', 50_000_000n, 0n, 50_000_000n],
      ['Stock Journal', 5_000_000n, 0n, 55_000_000n], // an In is read before an Out of the same day
      ['Stock Journal', 0n, 5_000_000n, 50_000_000n],
      ['Sales', 0n, 20_000_000n, 30_000_000n], // the invoice against ABC's PO-4471
    ]);
    expect(l.rows.every((r) => r.number !== '')).toBe(true);
    expect(l.rows[0]?.number).toMatch(/^OS\//);
    expect(l.closing).toEqual(stockSummaryRows(books.masters, books.stock, from, to).find((r) => r.name === 'ABC Hex Bolt M8')?.closing);
  });

  it('the columns sort and filter like every report’s (the grid is generic)', async () => {
    const { books, from, to } = await demo();
    const rows = stockSummaryRows(books.masters, books.stock, from, to);
    const cols = stockSummaryColumns();
    const byValue = applyGridQuery(rows, cols, { sort: [{ column: 'closeValue', dir: 'desc' }], filters: {}, quick: '' });
    expect(byValue[0]?.name).toBe('MS Sheet 2mm'); // the most valuable stock first
    const big = applyGridQuery(rows, cols, { sort: [], filters: { closeQty: { kind: 'range', min: 1000 } }, quick: '' });
    expect(big.map((r) => r.name).sort()).toEqual(['ABC Hex Bolt M8', 'MS Rod 12mm', 'MS Sheet 2mm']);
    const ledger = stockLedgerOf(books.masters, books.stock, books.vouchers, item('MS Sheet 2mm'), from, to);
    const ledgerCols = stockLedgerColumns([]);
    expect(applyGridQuery(ledger.rows, ledgerCols, { sort: [], filters: {}, quick: 'fabricated' }).map((r) => r.voucherType)).toEqual(['Stock Journal']);
    // (the last two are for the sales orders the ledger now lists: how far a line is filled, and whether its order is open)
    expect(ledgerCols.map((c) => c.id)).toEqual(['date', 'particulars', 'type', 'number', 'inQty', 'inValue', 'outQty', 'outValue', 'balanceQty', 'balanceValue', 'fill', 'orderStatus']);
  });

  it('the summary shows what is COMMITTED — the pending quantity on every open sales order — and what is left to promise', async () => {
    const { books, from, to } = await demo();
    const rows = stockSummaryRows(books.masters, books.stock, from, to, books.orders);
    const by = (n: string) => rows.find((r) => r.name === n);
    // ABC's PO-4471: 180 brackets and 20 frames pending; Kumar's KEW-12: 800 bolts. Sharma's oil order was delivered in full: nothing committed.
    expect([by('Mounting Bracket')?.committed, by('Fabricated Frame')?.committed, by('ABC Hex Bolt M8')?.committed, by('Machine Oil')?.committed]).toEqual([1_800_000n, 200_000n, 8_000_000n, 0n]);
    expect(availableOf(by('Mounting Bracket') as never)).toBe(6_800_000n - 1_800_000n); // 680 in stock − 180 committed
    const cols = stockSummaryColumns();
    // Available is shown for every item that has stock — not only the ones with orders — so 50 in stock and nothing committed reads 50
    expect(cols.find((c) => c.id === 'available')?.text?.(by('MS Sheet 2mm') as never)).toBe('2,200.000');
    expect(cols.slice(-2).map((c) => c.id)).toEqual(['committed', 'available']);
    const committedOnly = applyGridQuery(rows, cols, { sort: [], filters: { committed: { kind: 'range', min: 1 } }, quick: '' });
    expect(committedOnly.map((r) => r.name).sort()).toEqual(['ABC Hex Bolt M8', 'Fabricated Frame', 'Mounting Bracket']);
    // without the order book the column is just empty (the report is still a function of what it is given)
    expect(stockSummaryRows(books.masters, books.stock, from, to).every((r) => r.committed === 0n)).toBe(true);
  });

  it('an item’s ledger also lists its sales orders, each line with its fill status, and ends with current stock, committed and available', async () => {
    const { books, from, to } = await demo();
    const l = stockLedgerOf(books.masters, books.stock, books.vouchers, item('ABC Hex Bolt M8'), from, to, books.orders);
    const rows = l.rows.map((r) => [r.voucherType, r.fill ?? '', r.orderStatus ?? '']);
    expect(rows).toEqual([
      ['Opening Stock', '', ''],
      ['Stock Journal', '', ''],
      ['Stock Journal', '', ''],
      ['Sales Order', '2,000/2,000', 'Open'], // PO-4471's bolt line: delivered in full, on an order that is still open
      ['Sales Order', '0/800', 'Open'], // Kumar's KEW-12 (dated before the invoice, so it sits above it)
      ['Sales', '', ''],
    ]);
    const kumar = l.rows.find((r) => r.fill === '0/800');
    expect(kumar).toMatchObject({ actionable: true, isOrder: true });
    expect(kumar?.particulars).toContain('Kumar Engineering Works');
    expect(kumar?.particulars).toContain('KEW-12');
    expect(l.rows.find((r) => r.fill === '2,000/2,000')?.actionable).toBe(false);
    expect([l.current.qty, l.committed, l.available]).toEqual([30_000_000n, 8_000_000n, 22_000_000n]); // 3,000 in stock, 800 spoken for, 2,200 to promise
    // the voucher types filter works on it like on any ledger
    const onlyOrders = onlyVoucherTypes(l.rows, [books.masters.voucherTypes.find((t) => t.baseKind === 'salesOrder')?.id as never]);
    expect(onlyOrders).toHaveLength(2);
    // the orders' rows are documents: they carry no quantity movement and no balance
    expect(l.rows.filter((r) => r.isOrder).every((r) => r.inQty === 0n && r.outQty === 0n)).toBe(true);
    // the closing figures are still the item's true stock position
    expect(l.closing.qty).toBe(l.current.qty);
  });

  it('a cancelled stock journal leaves the reports (and the numbering keeps its gap)', async () => {
    const { books, from, to } = await demo();
    const journal = books.vouchers.find((v) => (v.content as { narration?: string }).narration === 'Frames fabricated from sheet and rod');
    expect(journal).toBeDefined();
    const cancelled = await books.cancel(journal?.id as string, journal?.version as number);
    expect(cancelled.ok).toBe(true);
    const rows = stockSummaryRows(books.masters, books.stock, from, to);
    expect(rows.find((r) => r.name === 'Fabricated Frame')).toBeUndefined();
    expect(rows.find((r) => r.name === 'MS Sheet 2mm')?.closing.qty).toBe(25_000_000n); // the 300 Kg is back
  });
});

describe('what is on order', () => {
  it('the summary shows the quantity still to come on open purchase orders — separately from what is committed to customers', async () => {
    const { books, from, to } = await demo();
    const rows = stockSummaryRows(books.masters, books.stock, from, to, books.orders);
    const by = (n: string) => rows.find((r) => r.name === n);
    expect([by('MS Sheet 2mm')?.onOrder, by('MS Rod 12mm')?.onOrder, by('ABC Hex Bolt M8')?.onOrder]).toEqual([10_000_000n, 5_000_000n, 0n]);
    expect(by('MS Sheet 2mm')?.committed).toBe(0n); // a purchase order commits nothing we hold
    const col = stockSummaryColumns().find((c) => c.id === 'onOrder');
    expect(col?.label).toBe('On order');
    expect(col?.text?.(by('MS Sheet 2mm') as never)).toBe('1,000.000');
    expect(col?.text?.(by('ABC Hex Bolt M8') as never)).toBe('');
    expect(stockSummaryRows(books.masters, books.stock, from, to).every((r) => r.onOrder === 0n)).toBe(true);
  });

  it('the item ledger carries it too, and lists the purchase order as a document beside the movements', async () => {
    const { books, from, to } = await demo();
    const sheet = item('MS Sheet 2mm');
    const ledger = stockLedgerOf(books.masters, books.stock, books.vouchers, sheet, from, to, books.orders);
    expect(ledger.onOrder).toBe(10_000_000n);
    expect(ledger.committed).toBe(0n);
    expect(ledger.rows.filter((r) => r.isOrder).map((r) => r.voucherType)).toEqual(['Purchase Order']);
  });
});
