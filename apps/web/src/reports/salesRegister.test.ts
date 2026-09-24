import { MemoryBackend } from '@minimalerp/adapter-memory';
import { localDate } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { newestInvoicesFirst, salesRegisterRows } from './salesRegister';

async function demo(): Promise<{ books: Books; from: ReturnType<typeof localDate>; to: ReturnType<typeof localDate> }> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  const fy = r.value.masters.financialYears[0];
  return { books: r.value, from: fy?.start as never, to: fy?.end as never };
}

describe('the Sales Register', () => {
  it('has one row per invoice line, item by item, oldest invoice first', async () => {
    const { books, from, to } = await demo();
    const rows = salesRegisterRows(books.vouchers, books.masters, from, to);
    expect(rows.map((r) => [r.item, r.hsn, r.qty, r.taxable])).toEqual([
      ['ABC Hex Bolt M8', '7318', 2000_0000n, 1_300_000n], // 2000 × 6.5
      ['Mounting Bracket', '7326', 120_0000n, 660_000n], // 120 × 55
      ['Machine Oil', '2710', 40_0000n, 1_040_000n], // 40 × 260
    ]);
    // both lines of the same invoice share its number and party
    expect(rows[0]?.number).toBe(rows[1]?.number);
    expect(rows[0]?.party).toBe('ABC Industries');
    expect(rows[2]?.party).toBe('Sharma Traders');
    expect(rows.map((r) => r.value)).toEqual(rows.map((r) => r.taxable + r.cgst + r.sgst + r.igst));
  });

  it('a row key is unique per line', async () => {
    const { books, from, to } = await demo();
    const rows = salesRegisterRows(books.vouchers, books.masters, from, to);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('a date range that excludes every invoice returns nothing', async () => {
    const { books } = await demo();
    expect(salesRegisterRows(books.vouchers, books.masters, localDate('1999-01-01'), localDate('1999-12-31'))).toEqual([]);
  });
});

describe('newestInvoicesFirst', () => {
  it('reverses invoice order but keeps each invoice’s own lines in the order they were entered', () => {
    const rows = [
      { voucherId: 'a', n: 1 },
      { voucherId: 'a', n: 2 },
      { voucherId: 'b', n: 3 },
    ];
    expect(newestInvoicesFirst(rows).map((r) => r.n)).toEqual([3, 1, 2]);
  });
});
