import {
  type Masters,
  type StockItemId,
  type StockMovement,
  type VoucherId,
  type WarehouseId,
  IssueCode,
  StockBook,
  defaultVoucherKinds,
  deterministicUuid,
  localDate,
  prepareMasterCommand,
  prepareVoucher,
  seedCompany,
} from '@minimalerp/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

/**
 * The stock book's promises, for any history: the answer never depends on the order the movements were entered in; a period always
 * reconciles (closing = opening + in − out, in quantity AND in value); an item's quantity is the sum of its godowns; and a book built only
 * by posting vouchers the engine accepted is never negative.
 */
const newId = (n: string) => deterministicUuid(`sp|${n}`);
const ITEMS = ['a', 'b'].map((n) => newId(`item:${n}`) as StockItemId);
const WAREHOUSES = ['w1', 'w2'].map((n) => newId(`wh:${n}`) as WarehouseId);
const DAYS = Array.from({ length: 10 }, (_, i) => localDate(`2024-05-${String(i + 1).padStart(2, '0')}`));

const arbMovement = fc.record({
  n: fc.integer({ min: 0, max: 1_000_000 }),
  day: fc.integer({ min: 0, max: 9 }),
  item: fc.integer({ min: 0, max: 1 }),
  wh: fc.integer({ min: 0, max: 1 }),
  direction: fc.constantFrom('in' as const, 'out' as const),
  qty: fc.integer({ min: 1, max: 50 }),
  value: fc.integer({ min: 0, max: 500_000 }),
});

interface Raw {
  readonly n: number;
  readonly day: number;
  readonly item: number;
  readonly wh: number;
  readonly direction: 'in' | 'out';
  readonly qty: number;
  readonly value: number;
}

const toMovements = (raw: readonly Raw[]): StockMovement[] =>
  raw.map((r, i) => ({
    voucherId: `v${i}` as VoucherId,
    lineNo: 1,
    date: DAYS[r.day] as StockMovement['date'],
    itemId: ITEMS[r.item] as StockItemId,
    warehouseId: WAREHOUSES[r.wh] as WarehouseId,
    direction: r.direction,
    qty: (BigInt(r.qty) * 10_000n) as never,
    ...(r.direction === 'in' ? { value: BigInt(r.value) as never } : {}),
  }));

const fingerprint = (book: StockBook): string =>
  JSON.stringify(
    ITEMS.map((i) => book.steps(i).map((s) => [s.movement.voucherId, String(s.value), String(s.after.qty), String(s.after.value)])),
  );

describe('the stock book (properties)', () => {
  it('does not depend on the order movements were entered in', () => {
    fc.assert(
      fc.property(
        fc.array(arbMovement, { maxLength: 40 }).chain((raw) =>
          fc.shuffledSubarray(
            raw.map((_, i) => i),
            { minLength: raw.length, maxLength: raw.length },
          ).map((order) => ({ raw, order })),
        ),
        ({ raw, order }) => {
        const movements = toMovements(raw);
        const shuffled = order.map((i) => movements[i] as StockMovement);
        expect(fingerprint(new StockBook(shuffled))).toBe(fingerprint(new StockBook(movements)));
        expect(new StockBook(shuffled).shortfalls()).toEqual(new StockBook(movements).shortfalls());
      }),
      { numRuns: 200 },
    );
  });

  it('reconciles for every item and period: closing = opening + in − out (quantity and value), and matches the position at the end', () => {
    fc.assert(
      fc.property(fc.array(arbMovement, { maxLength: 40 }), fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 9 }), (raw, a, b) => {
        const book = new StockBook(toMovements(raw));
        const [from, to] = [Math.min(a, b), Math.max(a, b)];
        for (const row of book.summary(DAYS[from] as never, DAYS[to] as never)) {
          expect(row.closing.qty).toBe(row.opening.qty + row.inward.qty - row.outward.qty);
          expect(row.closing.value).toBe(row.opening.value + row.inward.value - row.outward.value);
          expect(row.closing).toEqual(book.positionAt(row.itemId, DAYS[to] as never));
          expect(row.opening).toEqual(book.positionBefore(row.itemId, DAYS[from] as never));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('an item’s quantity is the sum of its godowns, on every day', () => {
    fc.assert(
      fc.property(fc.array(arbMovement, { maxLength: 40 }), (raw) => {
        const book = new StockBook(toMovements(raw));
        for (const item of ITEMS) {
          for (const day of DAYS) {
            const total = WAREHOUSES.reduce((sum, w) => sum + book.qtyAt(item, w, day), 0n);
            expect(total).toBe(book.positionAt(item, day).qty);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a ledger’s last running balance is the item’s closing position', () => {
    fc.assert(
      fc.property(fc.array(arbMovement, { maxLength: 40 }), (raw) => {
        const book = new StockBook(toMovements(raw));
        for (const item of ITEMS) {
          const l = book.ledger(item, DAYS[0] as never, DAYS[9] as never);
          expect(l.closing).toEqual(l.rows.at(-1)?.balance ?? l.opening);
          expect(l.closing).toEqual(book.positionAt(item, DAYS[9] as never));
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('posting through the engine never builds a negative book', () => {
  const masters = (() => {
    let m: Masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
    const run = (kind: string, id: string, data: unknown) => {
      const r = prepareMasterCommand({ op: 'create', kind, id, data }, m);
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      m = r.value.masters;
    };
    const nos = m.units.find((u) => u.symbol === 'Nos')?.id as string;
    run('stockItem', ITEMS[0] as string, { name: 'A', unitId: nos, itemType: 'finished' });
    run('stockItem', ITEMS[1] as string, { name: 'B', unitId: nos, itemType: 'finished' });
    run('warehouse', WAREHOUSES[0] as string, { name: 'W1' });
    run('warehouse', WAREHOUSES[1] as string, { name: 'W2' });
    return m;
  })();
  const type = masters.voucherTypes.find((t) => t.baseKind === 'stockJournal')?.id as string;
  const kinds = defaultVoucherKinds();

  it('every accepted stock journal keeps the book sound; every refusal is a stock rule, never a crash', () => {
    fc.assert(
      fc.property(fc.array(fc.array(arbMovement, { minLength: 1, maxLength: 3 }), { maxLength: 25 }), (vouchers) => {
        let book = StockBook.empty;
        vouchers.forEach((lines, v) => {
          const draft = {
            id: `pv${v}`,
            voucherTypeId: type,
            date: DAYS[lines[0]?.day ?? 0],
            entries: lines.map((l) => ({
              itemId: ITEMS[l.item],
              warehouseId: WAREHOUSES[l.wh],
              direction: l.direction,
              qty: String(l.qty),
              ...(l.direction === 'in' ? { rate: String(l.value / 100) } : {}),
            })),
          };
          const r = prepareVoucher(draft, masters, kinds, book);
          if (r.ok) book = book.withChange({ add: r.value.plan.stock });
          else for (const i of r.issues) expect([IssueCode.StockNegative, IssueCode.StockLineInvalid]).toContain(i.code);
          expect(book.shortfalls()).toEqual([]);
        });
      }),
      { numRuns: 150 },
    );
  });
});
