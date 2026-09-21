import { describe, expect, it } from 'vitest';
import { type ColumnSpec, EMPTY_QUERY, type GridQuery, applyGridQuery, compareCells, cycleSort, sanitizeQuery, withFilter } from './grid';

interface Row {
  id: number;
  name: string;
  kind: string;
  amount: bigint;
  when: string | null;
}
const cols: ColumnSpec<Row>[] = [
  { id: 'name', label: 'Name', type: 'text', value: (r) => r.name },
  { id: 'kind', label: 'Kind', type: 'choice', value: (r) => r.kind },
  {
    id: 'amount',
    label: 'Amount',
    type: 'money',
    align: 'right',
    value: (r) => r.amount,
    text: (r) => `${r.amount / 100n}.${String(r.amount % 100n).padStart(2, '0')}`,
  },
  { id: 'when', label: 'Date', type: 'date', value: (r) => r.when },
  { id: 'secret', label: 'Secret', type: 'text', sortable: false, filterable: false, value: (r) => `s${r.id}` },
];
const rows: Row[] = [
  { id: 1, name: 'Rent', kind: 'Payment', amount: 1200000n, when: '2024-05-10' },
  { id: 2, name: 'ABC Industries', kind: 'Receipt', amount: 12000000n, when: '2024-05-11' },
  { id: 3, name: 'Salary', kind: 'Payment', amount: 5000000n, when: '2024-05-10' },
  { id: 4, name: 'Adjustment', kind: 'Journal', amount: 5000000n, when: null },
  { id: 5, name: 'Rent 2', kind: 'Payment', amount: 1200000n, when: '2024-06-01' },
];
const q = (over: Partial<GridQuery>): GridQuery => ({ ...EMPTY_QUERY, ...over });
const ids = (rs: readonly Row[]) => rs.map((r) => r.id);

describe('sorting', () => {
  it('sorts text naturally and case-insensitively, either way', () => {
    expect(ids(applyGridQuery(rows, cols, q({ sort: [{ column: 'name', dir: 'asc' }] })))).toEqual([2, 4, 1, 5, 3]);
    expect(ids(applyGridQuery(rows, cols, q({ sort: [{ column: 'name', dir: 'desc' }] })))).toEqual([3, 5, 1, 4, 2]);
  });

  it('sorts money numerically, not as text', () => {
    expect(ids(applyGridQuery(rows, cols, q({ sort: [{ column: 'amount', dir: 'desc' }] })))).toEqual([2, 3, 4, 1, 5]);
  });

  it('is stable: equal cells keep their incoming order, in both directions', () => {
    expect(ids(applyGridQuery(rows, cols, q({ sort: [{ column: 'amount', dir: 'asc' }] })))).toEqual([1, 5, 3, 4, 2]);
    expect(ids(applyGridQuery(rows, cols, q({ sort: [{ column: 'kind', dir: 'asc' }] })))).toEqual([4, 1, 3, 5, 2]);
    expect(ids(applyGridQuery(rows, cols, q({ sort: [{ column: 'kind', dir: 'desc' }] })))).toEqual([2, 1, 3, 5, 4]);
  });

  it('puts empty cells last whichever way it is sorted', () => {
    expect(applyGridQuery(rows, cols, q({ sort: [{ column: 'when', dir: 'asc' }] })).at(-1)?.id).toBe(4);
    expect(applyGridQuery(rows, cols, q({ sort: [{ column: 'when', dir: 'desc' }] })).at(-1)?.id).toBe(4);
  });

  it('a second key breaks ties in the first', () => {
    const out = applyGridQuery(rows, cols, q({ sort: [{ column: 'when', dir: 'asc' }, { column: 'amount', dir: 'desc' }] }));
    expect(ids(out).slice(0, 2)).toEqual([3, 1]); // both 10 May: bigger amount first
  });

  it('never loses or duplicates a row', () => {
    for (const col of cols) {
      for (const dir of ['asc', 'desc'] as const) {
        expect(ids(applyGridQuery(rows, cols, q({ sort: [{ column: col.id, dir }] }))).sort()).toEqual([1, 2, 3, 4, 5]);
      }
    }
  });
});

describe('filtering', () => {
  it('contains: case-insensitive, on what is shown', () => {
    expect(ids(applyGridQuery(rows, cols, q({ filters: { name: { kind: 'contains', text: 'RENT' } } })))).toEqual([1, 5]);
    expect(ids(applyGridQuery(rows, cols, q({ filters: { amount: { kind: 'contains', text: '50000.00' } } })))).toEqual([3, 4]);
  });

  it('range: inclusive, open-ended, on money and on dates', () => {
    expect(ids(applyGridQuery(rows, cols, q({ filters: { amount: { kind: 'range', min: 5000000n } } })))).toEqual([2, 3, 4]);
    expect(ids(applyGridQuery(rows, cols, q({ filters: { amount: { kind: 'range', min: 1200000n, max: 1200000n } } })))).toEqual([1, 5]);
    expect(ids(applyGridQuery(rows, cols, q({ filters: { when: { kind: 'range', min: '2024-05-11', max: '2024-05-31' } } })))).toEqual([2]);
  });

  it('in / notIn: pick or exclude values; an empty pick means everything', () => {
    expect(ids(applyGridQuery(rows, cols, q({ filters: { kind: { kind: 'in', values: ['Receipt', 'Journal'] } } })))).toEqual([2, 4]);
    expect(ids(applyGridQuery(rows, cols, q({ filters: { kind: { kind: 'notIn', values: ['Payment'] } } })))).toEqual([2, 4]);
    expect(ids(applyGridQuery(rows, cols, q({ filters: { kind: { kind: 'in', values: [] } } })))).toEqual([1, 2, 3, 4, 5]);
  });

  it('the quick filter needs every word somewhere in the row', () => {
    expect(ids(applyGridQuery(rows, cols, q({ quick: 'rent payment' })))).toEqual([1, 5]);
    expect(ids(applyGridQuery(rows, cols, q({ quick: 'abc receipt' })))).toEqual([2]);
    expect(ids(applyGridQuery(rows, cols, q({ quick: 'abc payment' })))).toEqual([]);
  });

  it('filters combine, commute, and never add rows', () => {
    const a = { name: { kind: 'contains', text: 'r' } } as const;
    const b = { kind: { kind: 'in', values: ['Payment'] } } as const;
    const both = ids(applyGridQuery(rows, cols, q({ filters: { ...a, ...b } })));
    expect(both).toEqual(ids(applyGridQuery(rows, cols, q({ filters: { ...b, ...a } }))));
    expect(both.every((id) => ids(applyGridQuery(rows, cols, q({ filters: a }))).includes(id))).toBe(true);
    expect(both.every((id) => ids(applyGridQuery(rows, cols, q({ filters: b }))).includes(id))).toBe(true);
  });

  it('applying a query twice changes nothing (idempotent)', () => {
    const query = q({ quick: 'r', sort: [{ column: 'amount', dir: 'desc' }], filters: { kind: { kind: 'in', values: ['Payment'] } } });
    const once = applyGridQuery(rows, cols, query);
    expect(applyGridQuery(once, cols, query)).toEqual(once);
  });
});

describe('the column whitelist', () => {
  it('ignores sorts and filters on columns that do not exist, or that forbid them', () => {
    const query = q({
      sort: [{ column: 'nope', dir: 'asc' }, { column: 'secret', dir: 'asc' }],
      filters: { nope: { kind: 'contains', text: 'x' }, secret: { kind: 'contains', text: 'x' } },
    });
    expect(sanitizeQuery(cols, query)).toEqual({ sort: [], filters: {}, quick: '' });
    expect(ids(applyGridQuery(rows, cols, query))).toEqual([1, 2, 3, 4, 5]);
  });

  it('cannot be tricked by prototype-ish column names', () => {
    const query = q({ filters: JSON.parse('{"__proto__":{"kind":"contains","text":"x"},"constructor":{"kind":"contains","text":"x"}}'), sort: [{ column: 'constructor', dir: 'asc' }] });
    expect(ids(applyGridQuery(rows, cols, query))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('query helpers', () => {
  it('cycles a sort none → asc → desc → none, one column at a time', () => {
    let query = EMPTY_QUERY;
    query = cycleSort(query, 'name');
    expect(query.sort).toEqual([{ column: 'name', dir: 'asc' }]);
    query = cycleSort(query, 'name');
    expect(query.sort).toEqual([{ column: 'name', dir: 'desc' }]);
    query = cycleSort(query, 'name');
    expect(query.sort).toEqual([]);
    expect(cycleSort(cycleSort(EMPTY_QUERY, 'name'), 'amount').sort).toEqual([{ column: 'amount', dir: 'asc' }]);
  });

  it('adds and removes a column filter without touching the others', () => {
    const one = withFilter(EMPTY_QUERY, 'kind', { kind: 'in', values: ['Payment'] });
    const two = withFilter(one, 'name', { kind: 'contains', text: 'r' });
    expect(Object.keys(two.filters)).toEqual(['kind', 'name']);
    expect(Object.keys(withFilter(two, 'kind', undefined).filters)).toEqual(['name']);
  });

  it('compares mixed numbers and bigints, and text in natural order', () => {
    expect(compareCells(5n, 7)).toBeLessThan(0);
    expect(compareCells('a10', 'a9')).toBeGreaterThan(0);
  });
});

describe('randomised: any query keeps rows intact and sorted', () => {
  it('holds for 300 random queries over 60 random rows', () => {
    let seed = 99;
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const kinds = ['Payment', 'Receipt', 'Journal', 'Contra'];
    const data: Row[] = Array.from({ length: 60 }, (_, i) => ({
      id: i,
      name: `Party ${next(20)}`,
      kind: kinds[next(4)] as string,
      amount: BigInt(next(50)) * 100n,
      when: next(5) === 0 ? null : `2024-0${1 + next(9)}-1${next(9)}`,
    }));
    for (let n = 0; n < 300; n++) {
      const column = ['name', 'kind', 'amount', 'when'][next(4)] as string;
      const dir = next(2) === 0 ? 'asc' : 'desc';
      const filters = next(2) === 0 ? { kind: { kind: 'in', values: [kinds[next(4)] as string] } as const } : {};
      const out = applyGridQuery(data, cols, q({ sort: [{ column, dir }], filters }));
      expect(out.every((r) => data.includes(r))).toBe(true);
      expect(new Set(ids(out)).size).toBe(out.length);
      const col = cols.find((c) => c.id === column) as ColumnSpec<Row>;
      const values = out.map((r) => col.value(r)).filter((v) => v !== null);
      for (let i = 1; i < values.length; i++) {
        const c = compareCells(values[i - 1] as never, values[i] as never);
        expect(dir === 'asc' ? c <= 0 : c >= 0).toBe(true);
      }
    }
  });
});
