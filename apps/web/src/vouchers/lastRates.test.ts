import { MemoryBackend } from '@minimalerp/adapter-memory';
import type { Voucher } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { lastDealText, lastDeals } from './lastRates';

async function demo(): Promise<Books> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

/** The posted invoices of one kind, as (party, item, rate, date) — what the index is read from. */
function invoiceLines(books: Books, kind: 'sales' | 'purchase') {
  return books.vouchers
    .filter((v: Voucher) => v.status === 'posted' && books.masters.voucherType(v.voucherTypeId)?.baseKind === kind)
    .flatMap((v: Voucher) => {
      const c = v.content as unknown as { partyId?: string; lines?: { itemId?: string; rate?: string }[] };
      return (c.lines ?? []).filter((l) => l.itemId && l.rate).map((l) => ({ partyId: c.partyId ?? '', itemId: l.itemId as string, rate: l.rate as string, date: v.date as string }));
    });
}

describe('what an item last went for', () => {
  it('is the rate on its latest posted invoice: to the party asked for if ever, else anyone’s — and nothing where it never sold', async () => {
    const books = await demo();
    const deals = lastDeals(books.vouchers, books.masters);
    const sold = invoiceLines(books, 'sales');
    expect(sold.length).toBeGreaterThan(0);
    const one = sold[0] as (typeof sold)[number];
    const latest = sold.filter((l) => l.itemId === one.itemId).sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1) as (typeof sold)[number];

    const anyone = deals(one.itemId, 'sales');
    expect(anyone).toMatchObject({ date: latest.date, own: true });
    expect(Number(anyone?.rate)).toBe(Number(latest.rate));

    // to the customer it was sold to: theirs
    expect(deals(one.itemId, 'sales', one.partyId)).toMatchObject({ own: true });
    // to a customer who never bought it: the latest with anyone, said to be another's
    expect(deals(one.itemId, 'sales', 'someone-else')).toMatchObject({ date: latest.date, own: false });
    // an item with no invoice has nothing to say
    expect(deals('no-such-item', 'sales')).toBeUndefined();
    expect(deals('no-such-item', 'purchase')).toBeUndefined();
  });

  it('an order or a quotation is not a sale: only invoices count', async () => {
    const books = await demo();
    const deals = lastDeals(books.vouchers, books.masters);
    const soldItems = new Set(invoiceLines(books, 'sales').map((l) => l.itemId));
    const orderedOnly = books.vouchers
      .filter((v: Voucher) => v.status === 'posted' && books.masters.voucherType(v.voucherTypeId)?.baseKind === 'salesOrder')
      .flatMap((v: Voucher) => ((v.content as unknown as { lines?: { itemId?: string }[] }).lines ?? []).map((l) => l.itemId ?? ''))
      .filter((id) => id !== '' && !soldItems.has(id));
    expect(orderedOnly.length).toBeGreaterThan(0); // the demo orders frames it has never invoiced
    for (const id of orderedOnly) expect(deals(id, 'sales')).toBeUndefined();
  });

  it('reads the way a person would say it', () => {
    expect(lastDealText({ rate: '35000', date: '2026-09-27', own: true }, 'sales')).toBe('Last sold @ ₹35000 on 27-Sep-2026');
    expect(lastDealText({ rate: '58.25', date: '2026-04-03', own: false }, 'sales')).toBe('Last sold @ ₹58.25 on 3-Apr-2026 (another customer)');
    expect(lastDealText({ rate: '4.5', date: '2026-04-03', own: false }, 'purchase')).toBe('Last bought @ ₹4.5 on 3-Apr-2026 (another supplier)');
    expect(lastDealText(undefined, 'sales')).toBe('');
  });
});
