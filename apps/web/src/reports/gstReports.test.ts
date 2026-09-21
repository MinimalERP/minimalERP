import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type Gstr1Row, type Gstr3bRow, type HsnRow, applyGridQuery, localDate } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { defaultPeriod, findFinancialYear, gstr1Columns, gstr3bColumns, hsnColumns, monthPeriod, parseMonth, periodInYear, periodOfYm, yearOf } from './gstReports';

async function demoMasters() {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.masters;
}

describe('the period a GST return is for: a financial year and a month', () => {
  it('a month is its first and last day, leap years included', () => {
    expect(monthPeriod(2026, 4)).toEqual({ from: '2026-04-01', to: '2026-04-30', ym: '2026-04', label: 'Apr 2026' });
    expect(monthPeriod(2028, 2).to).toBe('2028-02-29');
    expect(monthPeriod(2027, 2).to).toBe('2027-02-28');
    expect(monthPeriod(2026, 12).to).toBe('2026-12-31');
  });

  it('an address of the form YYYY-MM is a month; anything else is not', () => {
    expect(periodOfYm('2026-04')?.label).toBe('Apr 2026');
    for (const bad of [undefined, '', '2026', '2026-13', '2026-00', '26-04', 'apr']) expect(periodOfYm(bad), String(bad)).toBeUndefined();
  });

  it.each([
    ['apr', 4], ['April', 4], ['APR', 4], ['4', 4], ['04', 4], ['12', 12], ['sept', 9], ['Sep', 9], [' mar ', 3],
  ])('%j is month %d', (text, n) => {
    expect(parseMonth(text)).toBe(n);
  });

  it.each(['', 'xyz', '0', '13', 'a', 'ma', 'foo'])('%j is not a month', (text) => {
    expect(parseMonth(text)).toBeUndefined();
  });

  it('April is in the year the financial year starts in, January is in the year after', async () => {
    const m = await demoMasters();
    const fy = m.financialYears[0];
    if (!fy) throw new Error('no financial year');
    const first = Number(fy.start.slice(0, 4));
    expect(periodInYear(fy, 4)?.ym).toBe(`${first}-04`);
    expect(periodInYear(fy, 12)?.ym).toBe(`${first}-12`);
    expect(periodInYear(fy, 1)?.ym).toBe(`${first + 1}-01`);
    expect(periodInYear(fy, 3)?.ym).toBe(`${first + 1}-03`);
    expect(yearOf(m, periodInYear(fy, 1) as never)?.label).toBe(fy.label);
  });

  it('the financial year is found by its label, with or without the century or the dash', async () => {
    const m = await demoMasters();
    const fy = m.financialYears[0];
    if (!fy) throw new Error('no financial year');
    expect(findFinancialYear(m, fy.label)?.label).toBe(fy.label);
    expect(findFinancialYear(m, fy.label.replace(/^20/, '').replace('-20', '-'))?.label).toBe(fy.label);
    expect(findFinancialYear(m, '')).toBeUndefined();
    expect(findFinancialYear(m, '1999-00')).toBeUndefined();
  });

  it('with no month asked for, today’s month if it is inside a financial year, otherwise the last month of the latest year', async () => {
    const m = await demoMasters();
    const fy = m.financialYears.at(-1);
    if (!fy) throw new Error('no financial year');
    const inside = fy.start.slice(0, 7);
    expect(defaultPeriod(m, `${inside}-15`).ym).toBe(inside);
    expect(defaultPeriod(m, '1990-01-01').ym).toBe(fy.end.slice(0, 7));
  });
});

const row1 = (over: Partial<Gstr1Row> = {}): Gstr1Row =>
  ({
    rowType: 'gstr1', key: 'k', voucherId: 'v1', number: 'SAL/26-27/0001', date: localDate('2026-09-21'), party: 'ABC Industries', gstin: '27AAPFU0939F1ZV', placeOfSupply: '27', section: 'B2B',
    rate: '18', taxable: 1_000_000n, cgst: 90_000n, sgst: 90_000n, igst: 0n, value: 1_180_000n, hsns: '7318', ...over,
  }) as unknown as Gstr1Row;

describe('the GSTR-1 columns', () => {
  it('the sales report has a Type column (B2B / B2CL / B2CS / Export); the purchase register does not, and names its party a supplier', () => {
    expect(gstr1Columns('sales').map((c) => c.label)).toContain('Type');
    expect(gstr1Columns('purchase').map((c) => c.label)).not.toContain('Type');
    expect(gstr1Columns('sales').map((c) => c.label)).toContain('Customer');
    expect(gstr1Columns('purchase').map((c) => c.label)).toContain('Supplier');
  });

  it('shows money in rupees, and a tax head that does not apply as empty rather than 0.00', () => {
    const cols = gstr1Columns('sales');
    const text = (id: string) => {
      const c = cols.find((x) => x.id === id);
      return (c?.text ?? ((r: Gstr1Row) => String(c?.value(r))))(row1());
    };
    expect(text('taxable')).toBe('10,000.00');
    expect(text('cgst')).toBe('900.00');
    expect(text('igst')).toBe('');
    expect(text('value')).toBe('11,800.00');
    expect(text('rate')).toBe('18');
  });

  it('sorts and filters on the numbers, not the text', () => {
    const cols = gstr1Columns('sales');
    const rows = [row1({ key: 'a', taxable: 900n as never }), row1({ key: 'b', taxable: 100_000n as never }), row1({ key: 'c', taxable: 20_000n as never })];
    const sorted = applyGridQuery(rows, cols, { sort: [{ column: 'taxable', dir: 'asc' }], filters: {}, quick: '' } as never);
    expect(sorted.map((r) => r.key)).toEqual(['a', 'c', 'b']);
    expect(applyGridQuery(rows, cols, { sort: [], filters: {}, quick: '7318' } as never)).toHaveLength(3); // the quick filter finds an invoice by its HSN
    expect(applyGridQuery(rows, cols, { sort: [], filters: {}, quick: '9999' } as never)).toHaveLength(0);
  });
});

describe('the HSN summary columns', () => {
  const hsn = { rowType: 'hsn', key: 'h', hsn: '', uqc: 'KGS', rate: '18', qty: 25_000n, taxable: 100_000n, cgst: 9_000n, sgst: 9_000n, igst: 0n, value: 118_000n, invoices: 2 } as unknown as HsnRow;

  it('an item with no HSN reads "(none)" instead of a blank, so the gap is visible', () => {
    const c = hsnColumns().find((x) => x.id === 'hsn');
    expect(c?.value(hsn)).toBe('(none)');
    expect(c?.value({ ...hsn, hsn: '7208' })).toBe('7208');
  });

  it('shows the quantity in its unit’s precision and the count of invoices behind the row', () => {
    const cols = hsnColumns();
    expect(cols.find((x) => x.id === 'qty')?.text?.(hsn)).toBe('2.500');
    expect(cols.find((x) => x.id === 'invoices')?.value(hsn)).toBe(2);
  });
});

describe('the GSTR-3B columns', () => {
  const heading = { rowType: 'gstr3b', key: 'h', drill: undefined, label: '3.1 Outward supplies', heading: true, taxable: undefined, cgst: undefined, sgst: undefined, igst: undefined, total: undefined, review: false } as unknown as Gstr3bRow;
  const line = { ...heading, key: 'l', label: '(a) Taxable', heading: false, taxable: 1_000_000n, cgst: 90_000n, sgst: 90_000n, igst: 0n, total: 180_000n } as unknown as Gstr3bRow;

  it('a heading is in capitals and carries no figures; a line shows every figure, zeros included (a return states its zeros)', () => {
    const cols = gstr3bColumns();
    const text = (id: string, r: Gstr3bRow) => cols.find((c) => c.id === id)?.text?.(r);
    expect(text('label', heading)).toBe('3.1 OUTWARD SUPPLIES');
    expect(text('taxable', heading)).toBe('');
    expect(text('taxable', line)).toBe('10,000.00');
    expect(text('igst', line)).toBe('0.00');
    expect(text('total', line)).toBe('1,800.00');
  });

  it('the return is in the order of the return: nothing on it can be sorted or filtered away', () => {
    for (const c of gstr3bColumns()) {
      expect(c.sortable, c.id).toBe(false);
      expect(c.filterable, c.id).toBe(false);
    }
  });
});
