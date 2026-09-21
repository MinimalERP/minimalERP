import { MemoryBackend } from '@minimalerp/adapter-memory';
import { applyGridQuery, deterministicUuid, localDate } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { addDays } from '../vouchers/format';
import { fillRatio, fillText, orderRegisterColumns, orderRegisterRows, orderRowClass, registerCounts } from './salesReports';

const id = (kind: string, name: string) => deterministicUuid(`demo|${kind}|${name}`);

async function demo(): Promise<{ books: Books; from: ReturnType<typeof localDate>; to: ReturnType<typeof localDate> }> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  const fy = r.value.masters.financialYears[0];
  return { books: r.value, from: fy?.start as never, to: fy?.end as never };
}

const rowsOf = async (opts: { itemId?: string; asOf?: string } = {}) => {
  const { books, from, to } = await demo();
  return { books, rows: orderRegisterRows(books.orders, books.masters, from, to, { itemId: opts.itemId, asOf: localDate(opts.asOf ?? '2000-01-01') }) };
};

describe('the Sales Order Register', () => {
  it('has one row per order line, oldest order first, each with what was ordered, delivered and is pending, and how far it is filled', async () => {
    const { rows } = await rowsOf();
    expect(rows.map((r) => [r.reference, r.item, fillText(r), r.status])).toEqual([
      ['PO-4471', 'ABC Hex Bolt M8', '2,000/2,000', 'Open'], // delivered in full — but the order is open: another line is pending
      ['PO-4471', 'Mounting Bracket', '120/300', 'Open'],
      ['PO-4471', 'Fabricated Frame', '0/20', 'Open'],
      ['SH/PO/88', 'Machine Oil', '40.000/40.000', 'Closed'], // delivered in full: the whole order is closed
      ['KEW-12', 'ABC Hex Bolt M8', '0/800', 'Open'],
    ]);
    expect(rows.map((r) => r.number.slice(-4))).toEqual(['0001', '0001', '0001', '0002', '0003']); // SO/yy-yy/000n: the number is the order's, shared by its lines
  });

  it('an open order’s still-open line is bold; a delivered line is plain; a closed order’s lines are muted', async () => {
    const { rows } = await rowsOf();
    const classes = rows.map((r) => [r.item, r.reference, orderRowClass(r)]);
    expect(classes).toEqual([
      ['ABC Hex Bolt M8', 'PO-4471', ''], // filled, on an order that is still open: plain
      ['Mounting Bracket', 'PO-4471', 'open-line'],
      ['Fabricated Frame', 'PO-4471', 'open-line'],
      ['Machine Oil', 'SH/PO/88', 'closed-order'],
      ['ABC Hex Bolt M8', 'KEW-12', 'open-line'],
    ]);
  });

  it('says which open lines are overdue as of a date, and never a delivered or closed one', async () => {
    const { books, from } = await demo();
    const start = from as string;
    const at = (d: number) => localDate(addDays(start, d));
    const overdueAt = (asOf: ReturnType<typeof localDate>) =>
      orderRegisterRows(books.orders, books.masters, from, localDate('2999-01-01'), { asOf })
        .filter((r) => r.overdue)
        .map((r) => `${r.reference}/${r.item}`);
    expect(overdueAt(at(10))).toEqual([]);
    expect(overdueAt(at(49))).toEqual(['KEW-12/ABC Hex Bolt M8']); // due on day 48; the bolt line of PO-4471 is delivered (due day 45 but filled)
    expect(overdueAt(at(70))).toEqual(['PO-4471/Mounting Bracket', 'KEW-12/ABC Hex Bolt M8']);
  });

  it('can be limited to one item — every sales order that has it — and to a period (by the order’s date)', async () => {
    const { books, from, to } = await demo();
    const bolt = orderRegisterRows(books.orders, books.masters, from, to, { itemId: id('stockItem', 'ABC Hex Bolt M8'), asOf: localDate('2999-01-01') });
    expect(bolt.map((r) => [r.reference, fillText(r), r.status])).toEqual([['PO-4471', '2,000/2,000', 'Open'], ['KEW-12', '0/800', 'Open']]);
    const early = orderRegisterRows(books.orders, books.masters, from, localDate(addDays(from as string, 31)), { asOf: localDate('2999-01-01') });
    expect(early.map((r) => r.reference)).toEqual(['PO-4471', 'PO-4471', 'PO-4471']); // the other two orders are dated later
  });

  it('cancelling an invoice reopens its lines; closing an order closes it whatever is pending', async () => {
    const { books, from, to } = await demo();
    const sharma = books.vouchers.find((v) => (v.content as { partyId?: string }).partyId === id('party', 'Sharma Traders') && books.masters.voucherType(v.voucherTypeId)?.baseKind === 'sales');
    expect((await books.cancel(sharma?.id as string, sharma?.version as number)).ok).toBe(true);
    let rows = orderRegisterRows(books.orders, books.masters, from, to, { asOf: localDate('2999-01-01') });
    const oil = rows.find((r) => r.item === 'Machine Oil');
    expect([oil?.status, oil ? fillText(oil) : '', oil?.actionable]).toEqual(['Open', '0.000/40.000', true]); // pending again
    const kumar = books.vouchers.find((v) => (v.content as { reference?: string }).reference === 'KEW-12');
    expect((await books.alter(kumar?.id as string, kumar?.version as number, { ...(kumar?.content as object), closed: true })).ok).toBe(true);
    rows = orderRegisterRows(books.orders, books.masters, from, to, { asOf: localDate('2999-01-01') });
    const closed = rows.find((r) => r.reference === 'KEW-12');
    expect([closed?.status, closed?.actionable, closed ? orderRowClass(closed) : '']).toEqual(['Closed', false, 'closed-order']);
  });

  it('the fill sorts and ranges as a ratio, and counts summarise what is shown', async () => {
    const { rows } = await rowsOf();
    expect(rows.map((r) => Math.round(fillRatio(r) * 100))).toEqual([100, 40, 0, 100, 0]);
    const counts = registerCounts(rows);
    expect(counts).toEqual({ lines: 5, open: 3, overdue: 0, orders: 3 });
  });

  it('is sortable and filterable by construction — the columns are the grid’s own', async () => {
    const { rows } = await rowsOf();
    const cols = orderRegisterColumns();
    expect(cols.map((c) => c.label)).toEqual(['Order no.', 'Date', 'Cust PO / ref', 'Party', 'Item', 'Due', 'Ordered', 'Delivered', 'Pending', 'Fill', 'Status']);
    const byFill = applyGridQuery(rows, cols, { sort: [{ column: 'fill', dir: 'asc' }], filters: {}, quick: '' });
    expect(byFill.map((r) => fillText(r))).toEqual(['0/20', '0/800', '120/300', '2,000/2,000', '40.000/40.000']);
    const open = applyGridQuery(rows, cols, { sort: [], filters: { status: { kind: 'in', values: ['Open'] } }, quick: '' });
    expect(open).toHaveLength(4);
    const quick = applyGridQuery(rows, cols, { sort: [], filters: {}, quick: 'kew-12' });
    expect(quick.map((r) => r.reference)).toEqual(['KEW-12']);
    const pendingMost = applyGridQuery(rows, cols, { sort: [], filters: { pending: { kind: 'range', min: 100 } }, quick: '' });
    expect(pendingMost.map((r) => r.item)).toEqual(['Mounting Bracket', 'ABC Hex Bolt M8']); // 180 and 800 pending
    const byParty = applyGridQuery(rows, cols, { sort: [{ column: 'party', dir: 'asc' }], filters: {}, quick: '' });
    expect(byParty[0]?.party).toBe('ABC Industries');
  });
});
