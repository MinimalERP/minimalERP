import { MemoryBackend } from '@minimalerp/adapter-memory';
import { deterministicUuid, localDate } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { partyDetailsOfParty } from '../vouchers/salesModel';
import { partyItemRows, partyItemTotals } from './partyItemReport';

const id = (kind: string, name: string) => deterministicUuid(`demo|${kind}|${name}`);

async function demo(): Promise<{ host: BooksHost; books: Books; from: ReturnType<typeof localDate>; to: ReturnType<typeof localDate> }> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  const fy = r.value.masters.financialYears[0];
  return { host, books: r.value, from: fy?.start as never, to: fy?.end as never };
}

/** A purchase invoice of MS Sheet 2mm from Steel Supplies, dated as the demo's last voucher. */
async function buy(host: BooksHost, books: Books, billNo: string, qty: string, rate: string): Promise<Books> {
  const steel = books.masters.party(id('party', 'Steel Supplies Pvt Ltd') as never)!;
  const date = books.vouchers.map((v) => v.date).sort().at(-1)!;
  const posted = await books.post({
    id: deterministicUuid(`test|purchase|${billNo}`),
    voucherTypeId: books.masters.voucherTypes.find((t) => t.baseKind === 'purchase')!.id,
    date,
    partyId: steel.id,
    partyDetails: partyDetailsOfParty(steel),
    purchaseLedgerId: books.masters.ledgers.find((l) => l.name === 'Purchase - Raw Material')!.id,
    billNo,
    dueDate: date,
    lines: [{ itemId: id('stockItem', 'MS Sheet 2mm'), warehouseId: books.masters.warehouses.find((w) => w.isActive)!.id, qty, rate }],
  } as never);
  if (!posted.ok) throw new Error(JSON.stringify(posted.issues));
  return host.current!;
}

describe('Item Movement by Party', () => {
  it('has one row per party and item: what the demo sold is Out, by party and then by item', async () => {
    const { books, from, to } = await demo();
    const rows = partyItemRows(books.vouchers, books.masters, from, to);
    expect(rows.map((r) => [r.party, r.item, r.unit, r.inQty, r.inValue, r.outQty, r.outValue])).toEqual([
      ['ABC Industries', 'ABC Hex Bolt M8', 'Nos', 0n, 0n, 2000_0000n, 1_300_000n], // 2000 × 6.5
      ['ABC Industries', 'Mounting Bracket', 'Nos', 0n, 0n, 120_0000n, 660_000n], // 120 × 55
      ['Sharma Traders', 'Machine Oil', 'Ltr', 0n, 0n, 40_0000n, 1_040_000n], // 40 × 260
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(partyItemTotals(rows)).toEqual({ inward: 0n, outward: 3_000_000n });
  });

  it('a purchase is In, and two invoices of the same party and item add up on one row', async () => {
    const { host, books, from, to } = await demo();
    const after = await buy(host, await buy(host, books, 'SS/901', '100', '59'), 'SS/902', '50', '60');
    const rows = partyItemRows(after.vouchers, after.masters, from, to);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.party === 'Steel Supplies Pvt Ltd')).toMatchObject({ item: 'MS Sheet 2mm', unit: 'Kg', inQty: 150_0000n, inValue: 890_000n, outQty: 0n, outValue: 0n }); // 100 × 59 + 50 × 60
    expect(partyItemTotals(rows)).toEqual({ inward: 890_000n, outward: 3_000_000n });
  });

  it('a date range that excludes every invoice returns nothing', async () => {
    const { books } = await demo();
    expect(partyItemRows(books.vouchers, books.masters, localDate('1999-01-01'), localDate('1999-12-31'))).toEqual([]);
  });
});
