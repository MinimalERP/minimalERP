import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { IssueCode } from '../errors';
import { type StockItemId, type VoucherId, type WarehouseId, deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { seedCompany } from '../masters/seed';
import { type Voucher } from '../vouchers/voucher';
import { defaultVoucherKinds } from '../vouchers/registry';
import { checkPlanInvariants, stampPlan } from '../posting/plan';
import { prepareAlteration, prepareCancellation } from '../posting/lifecycle';
import { prepareVoucher } from '../posting/engine';
import { StockBook } from './book';
import type { StockMovement } from './movement';
import { decimalsUsed, formatQty, formatRate, parseQty, parseRate, qty, rateOf, valueOf } from './quantity';

const newId = (n: string) => deterministicUuid(`s|${n}`);
const kinds = defaultVoucherKinds();

function company(): { masters: Masters; item: StockItemId; kg: StockItemId; main: WarehouseId; yard: WarehouseId } {
  let masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
  const run = (kind: string, id: string, data: unknown) => {
    const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    masters = r.value.masters;
  };
  const nos = masters.units.find((u) => u.symbol === 'Nos')?.id as string;
  const kgUnit = masters.units.find((u) => u.symbol === 'Kg')?.id as string;
  run('stockItem', newId('bolt'), { name: 'Bolt', unitId: nos, itemType: 'finished' });
  run('stockItem', newId('sheet'), { name: 'Sheet', unitId: kgUnit, itemType: 'raw' });
  run('warehouse', newId('yard'), { name: 'Scrap Yard' });
  const main = masters.warehouses[0]?.id as WarehouseId;
  return { masters, item: newId('bolt') as StockItemId, kg: newId('sheet') as StockItemId, main, yard: newId('yard') as WarehouseId };
}

const mv = (
  over: Partial<StockMovement> & Pick<StockMovement, 'direction' | 'qty'>,
  item: StockItemId,
  wh: WarehouseId,
  n = 1,
): StockMovement => ({
  voucherId: `v${n}` as VoucherId,
  lineNo: 1,
  date: localDate('2024-05-01'),
  itemId: item,
  warehouseId: wh,
  ...over,
});

describe('quantities and rates', () => {
  it('parse and print exactly, with the unit’s decimals', () => {
    expect(parseQty('10')).toBe(100000n);
    expect(parseQty('2.5')).toBe(25000n);
    expect(parseQty('0.0625')).toBe(625n);
    for (const bad of ['', '-1', '1.23456', '1,000', 'x', '.5']) expect(parseQty(bad), bad).toBeUndefined();
    expect(formatQty(qty(25000n), 0)).toBe('2.5'); // more places than the unit only when the quantity has them
    expect(formatQty(qty(100000n), 3)).toBe('10.000');
    expect(formatQty(qty(-25000n), 2)).toBe('-2.50');
    expect(decimalsUsed(qty(25000n))).toBe(1);
    expect(decimalsUsed(qty(30000n))).toBe(0);
    expect(decimalsUsed(qty(625n))).toBe(4);
  });

  it('a value is quantity × rate to the paisa, half up; a rate reads back from value and quantity', () => {
    expect(valueOf(parseQty('10') as never, parseRate('58.5') as never)).toBe(58500n); // 585.00
    expect(valueOf(parseQty('3') as never, parseRate('33.3333') as never)).toBe(10000n); // 99.9999 → 100.00
    expect(valueOf(parseQty('0.0001') as never, parseRate('0.5') as never)).toBe(0n);
    expect(formatRate(parseRate('58') as never)).toBe('58.00');
    expect(formatRate(parseRate('58.3333') as never)).toBe('58.3333');
    expect(rateOf(58500n as never, parseQty('10') as never)).toBe(585000n);
    expect(rateOf(100n as never, qty(0n))).toBeUndefined();
  });
});

describe('the stock book: a moving weighted average', () => {
  const c = company();
  const book = new StockBook([
    mv({ direction: 'in', qty: parseQty('10') as never, value: 100000n as never }, c.item, c.main, 1), // 10 @ 1000.00
    mv({ direction: 'in', qty: parseQty('10') as never, value: 140000n as never, date: localDate('2024-05-03') }, c.item, c.main, 2), // 10 @ 1400.00
    mv({ direction: 'out', qty: parseQty('5') as never, date: localDate('2024-05-04') }, c.item, c.main, 3),
  ]);

  it('values an Out at the running average of its day, and keeps the rest exactly', () => {
    const steps = book.steps(c.item);
    expect(steps.map((s) => [s.movement.direction, s.value])).toEqual([['in', 100000n], ['in', 140000n], ['out', 60000n]]); // avg 1200.00 × 5
    expect(steps.at(-1)?.after).toEqual({ qty: qty(150000n), value: 180000n });
  });

  it('answers as of a date', () => {
    expect(book.positionAt(c.item, localDate('2024-05-02'))).toEqual({ qty: qty(100000n), value: 100000n });
    expect(book.positionBefore(c.item, localDate('2024-05-03'))).toEqual({ qty: qty(100000n), value: 100000n });
    expect(book.positionAt(c.item, localDate('2024-04-30'))).toEqual({ qty: qty(0n), value: 0n });
  });

  it('a summary reconciles: closing = opening + in − out, in quantity and in value', () => {
    const [row] = book.summary(localDate('2024-05-02'), localDate('2024-05-31'));
    expect(row?.opening).toEqual({ qty: qty(100000n), value: 100000n });
    expect(row?.inward).toEqual({ qty: qty(100000n), value: 140000n });
    expect(row?.outward).toEqual({ qty: qty(50000n), value: 60000n });
    expect(row?.closing).toEqual({ qty: qty(150000n), value: 180000n });
  });

  it('a ledger lists the movements with the running position', () => {
    const l = book.ledger(c.item, localDate('2024-05-01'), localDate('2024-05-31'));
    expect(l.rows.map((r) => r.balance.qty)).toEqual([100000n, 200000n, 150000n]);
    expect(l.closing).toEqual({ qty: qty(150000n), value: 180000n });
  });

  it('taking out everything takes out the whole value (no paisa is left behind)', () => {
    const b = new StockBook([
      mv({ direction: 'in', qty: parseQty('3') as never, value: 10000n as never }, c.item, c.main, 1), // 100.00 for 3: 33.3333 each
      mv({ direction: 'out', qty: parseQty('1') as never }, c.item, c.main, 2),
      mv({ direction: 'out', qty: parseQty('1') as never }, c.item, c.main, 3),
      mv({ direction: 'out', qty: parseQty('1') as never }, c.item, c.main, 4),
    ]);
    const steps = b.steps(c.item);
    expect(steps.reduce((sum, s) => sum + (s.movement.direction === 'out' ? s.value : 0n), 0n)).toBe(10000n);
    expect(steps.at(-1)?.after).toEqual({ qty: qty(0n), value: 0n });
  });

  it('same-day: an In is processed before an Out, whatever order they were entered in', () => {
    const inn = mv({ direction: 'in', qty: parseQty('4') as never, value: 4000n as never }, c.item, c.main, 1);
    const out = mv({ direction: 'out', qty: parseQty('4') as never }, c.item, c.main, 2);
    expect(new StockBook([out, inn]).shortfalls()).toEqual([]);
    expect(new StockBook([inn, out]).shortfalls()).toEqual([]);
  });

  it('finds where a godown would go below zero — per godown, not per item', () => {
    const b = new StockBook([
      mv({ direction: 'in', qty: parseQty('10') as never, value: 1000n as never }, c.item, c.main, 1),
      mv({ direction: 'out', qty: parseQty('4') as never, date: localDate('2024-05-02') }, c.item, c.yard, 2), // nothing in the yard
    ]);
    expect(b.shortfalls()).toEqual([
      { itemId: c.item, warehouseId: c.yard, date: '2024-05-02', voucherId: 'v2', lineNo: 1, short: qty(40000n) },
    ]);
    expect(b.qtyAt(c.item, c.main, localDate('2024-05-31'))).toBe(100000n);
  });

  it('withChange leaves the original book alone', () => {
    const changed = book.withChange({ remove: ['v1' as VoucherId] });
    expect(book.movements).toHaveLength(3);
    expect(changed.movements).toHaveLength(2);
    expect(changed.shortfalls()).toEqual([]); // the later In still covers the Out
    expect(book.withChange({ remove: ['v1', 'v2'] as VoucherId[] }).shortfalls()).toHaveLength(1); // …but not with both gone
  });
});

describe('the plan: a stock-only voucher has no journal', () => {
  const c = company();
  it('is accepted with stock and no journal, refused with neither', () => {
    const stock = mv({ direction: 'in', qty: qty(10000n), value: 100n as never }, c.item, c.main, 1);
    const planned = stampPlan('v1' as VoucherId, localDate('2024-05-01'), [], [stock]);
    expect(checkPlanInvariants(planned)).toEqual([]);
    expect(checkPlanInvariants({ journal: [], stock: [], links: [] }).map((i) => i.code)).toContain(IssueCode.PlanTooFewLines);
  });

  it('refuses a malformed stock line: a zero quantity, an In without a value, an Out with one', () => {
    const bad = (m: Partial<StockMovement>) =>
      checkPlanInvariants({ journal: [], stock: [{ ...mv({ direction: 'in', qty: qty(10000n), value: 100n as never }, c.item, c.main, 1), ...m }], links: [] }).map((i) => i.code);
    expect(bad({ qty: qty(0n) })).toContain(IssueCode.StockLineInvalid);
    expect(bad({ value: undefined })).toContain(IssueCode.StockLineInvalid);
    expect(bad({ direction: 'out' })).toContain(IssueCode.StockLineInvalid);
  });
});

describe('the Stock Journal voucher', () => {
  const c = company();
  const type = c.masters.voucherTypes.find((t) => t.baseKind === 'stockJournal')?.id as string;
  const openingType = c.masters.voucherTypes.find((t) => t.baseKind === 'stockOpening')?.id as string;
  const fyStart = '2024-04-01';

  const opening = (id: string, item: StockItemId, wh: WarehouseId, q: string, rate: string) => ({
    id, voucherTypeId: openingType, date: fyStart, itemId: item, warehouseId: wh, qty: q, rate,
  });
  const journal = (id: string, entries: unknown[], date = '2024-05-01') => ({ id, voucherTypeId: type, date, entries });
  const prepared = (draft: unknown, stock = StockBook.empty) => prepareVoucher(draft, c.masters, kinds, stock);
  const bookWith = (...drafts: unknown[]): StockBook => {
    let stock = StockBook.empty;
    for (const d of drafts) {
      const p = prepareVoucher(d, c.masters, kinds, stock);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      stock = stock.withChange({ add: p.value.plan.stock });
    }
    return stock;
  };
  const codes = (r: ReturnType<typeof prepareVoucher>) => (r.ok ? [] : r.issues.map((i) => i.code));

  it('opening stock is one In at the start of the year, with no accounting effect', () => {
    const p = prepared(opening('o1', c.item, c.main, '100', '12.5'));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.plan.journal).toEqual([]);
    expect(p.value.plan.stock).toMatchObject([{ direction: 'in', qty: 1000000n, value: 125000n, lineNo: 1 }]);
    expect(codes(prepared({ ...opening('o2', c.item, c.main, '100', '12.5'), date: '2024-05-01' }))).toContain(IssueCode.OpeningInvalid);
  });

  it('a transfer is an Out and an In of one item; the book is unchanged in total', () => {
    const stock = bookWith(opening('o1', c.item, c.main, '100', '10'));
    const p = prepared(
      journal('j1', [
        { itemId: c.item, warehouseId: c.main, direction: 'out', qty: '30' },
        { itemId: c.item, warehouseId: c.yard, direction: 'in', qty: '30', rate: '10' },
      ]),
      stock,
    );
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.plan.journal).toEqual([]);
    const after = stock.withChange({ add: p.value.plan.stock });
    expect(after.positionAt(c.item, localDate('2024-05-31'))).toEqual(stock.positionAt(c.item, localDate('2024-05-31')));
    expect(after.qtyAt(c.item, c.yard, localDate('2024-05-31'))).toBe(300000n);
  });

  it('refuses an Out beyond the stock, on that line, naming the item and the godown', () => {
    const stock = bookWith(opening('o1', c.item, c.main, '10', '10'));
    const r = prepared(journal('j1', [{ itemId: c.item, warehouseId: c.main, direction: 'out', qty: '11' }]), stock);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => [i.code, i.path])).toEqual([[IssueCode.StockNegative, 'entries.0.qty']]);
    expect(r.issues[0]?.message).toMatch(/Bolt/);
    expect(r.issues[0]?.message).toMatch(/1 Nos/);
  });

  it('refuses stock from a godown that has none even when another godown has plenty', () => {
    const stock = bookWith(opening('o1', c.item, c.main, '10', '10'));
    expect(codes(prepared(journal('j1', [{ itemId: c.item, warehouseId: c.yard, direction: 'out', qty: '1' }]), stock))).toEqual([IssueCode.StockNegative]);
  });

  it('a back-dated Out is checked against the day it is dated, and a later In does not help it', () => {
    const stock = bookWith(
      opening('o1', c.item, c.main, '5', '10'),
      journal('in1', [{ itemId: c.item, warehouseId: c.main, direction: 'in', qty: '20', rate: '10' }], '2024-06-10'),
    );
    expect(codes(prepared(journal('j1', [{ itemId: c.item, warehouseId: c.main, direction: 'out', qty: '10' }], '2024-06-01'), stock))).toEqual([IssueCode.StockNegative]);
    expect(prepared(journal('j2', [{ itemId: c.item, warehouseId: c.main, direction: 'out', qty: '10' }], '2024-06-11'), stock).ok).toBe(true);
  });

  it('a back-dated Out that would starve a LATER Out is refused, on the entry that causes it', () => {
    const stock = bookWith(
      opening('o1', c.item, c.main, '10', '10'),
      journal('out1', [{ itemId: c.item, warehouseId: c.main, direction: 'out', qty: '8' }], '2024-06-10'),
    );
    const r = prepared(journal('j1', [{ itemId: c.item, warehouseId: c.main, direction: 'out', qty: '5' }], '2024-05-01'), stock);
    expect(codes(r)).toEqual([IssueCode.StockNegative]);
  });

  it('checks the line shape: a rate on an Out, no rate on an In, decimals the unit does not take, a service, an inactive godown', () => {
    const one = (e: Record<string, unknown>) => codes(prepared(journal('j', [{ itemId: c.item, warehouseId: c.main, direction: 'in', qty: '1', rate: '1', ...e }])));
    expect(one({ direction: 'out', rate: '5' })).toContain(IssueCode.StockLineInvalid);
    expect(one({ rate: undefined })).toContain(IssueCode.StockLineInvalid);
    expect(one({ qty: '1.5' })).toContain(IssueCode.StockLineInvalid); // Nos are whole
    expect(codes(prepared(journal('j', [{ itemId: c.kg, warehouseId: c.main, direction: 'in', qty: '1.5', rate: '1' }])))).toEqual([]); // Kg take three places
    expect(one({ qty: '0' })).toContain(IssueCode.StockLineInvalid);
    expect(one({ itemId: 'ghost' })).toContain(IssueCode.StockLineInvalid);
    expect(codes(prepared(journal('j', [])))).toContain(IssueCode.TooFewLines);
  });

  it('quantities are kept in canonical text, so "10" and "10.0" are one voucher', () => {
    const a = prepared(journal('j', [{ itemId: c.item, warehouseId: c.main, direction: 'in', qty: '10', rate: '2' }]));
    const b = prepared(journal('j', [{ itemId: c.item, warehouseId: c.main, direction: 'in', qty: '10.0', rate: '2.00' }]));
    expect(a.ok && b.ok && JSON.stringify(a.value.draft) === JSON.stringify(b.value.draft)).toBe(true);
  });

  const posted = (draft: unknown, stock: StockBook): Voucher => {
    const p = prepareVoucher(draft, c.masters, kinds, stock);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return { id: p.value.draft.id, companyId: c.masters.company.id, voucherTypeId: p.value.voucherType.id, financialYearId: p.value.financialYear.id, number: 'X/1', date: p.value.draft.date, status: 'posted', version: 1, revision: 0, content: p.value.draft };
  };

  it('altering or cancelling an In that later Outs depend on is refused; altering an Out frees stock', () => {
    const o = opening('o1', c.item, c.main, '10', '10');
    const out = journal('out1', [{ itemId: c.item, warehouseId: c.main, direction: 'out', qty: '8' }], '2024-06-10');
    const stock = bookWith(o, out);
    const opened = posted(o, StockBook.empty);
    const cancel = prepareCancellation(opened, 1, c.masters, stock);
    expect(cancel.ok).toBe(false);
    if (!cancel.ok) expect(cancel.issues[0]?.code).toBe(IssueCode.StockNegative);

    const shrink = prepareAlteration({ existing: opened, input: opening('o1', c.item, c.main, '5', '10'), expectedVersion: 1, masters: c.masters, registry: kinds, stock });
    expect(shrink.ok).toBe(false); // 5 opening cannot cover the 8 issued later
    if (!shrink.ok) expect(shrink.issues[0]).toMatchObject({ code: IssueCode.StockNegative, path: 'qty' });
    // and the same for a Stock Journal In that a later Out depends on
    const inn = journal('in1', [{ itemId: c.item, warehouseId: c.main, direction: 'in', qty: '10', rate: '10' }], '2024-05-01');
    const stock2 = bookWith(inn, journal('out2', [{ itemId: c.item, warehouseId: c.main, direction: 'out', qty: '8' }], '2024-06-10'));
    const lower = prepareAlteration({ existing: posted(inn, StockBook.empty), input: journal('in1', [{ itemId: c.item, warehouseId: c.main, direction: 'in', qty: '5', rate: '10' }], '2024-05-01'), expectedVersion: 1, masters: c.masters, registry: kinds, stock: stock2 });
    expect(lower.ok).toBe(false);

    const outVoucher = posted(out, bookWith(o));
    expect(prepareCancellation(outVoucher, 1, c.masters, stock).ok).toBe(true); // an Out can always be cancelled
  });
});
