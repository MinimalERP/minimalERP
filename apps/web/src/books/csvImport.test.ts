import { MemoryBackend } from '@minimalerp/adapter-memory';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from './books';
import { importItemsCsv, importPartiesCsv, importVouchersCsv } from './csvImport';
import { createLocalFactory, memoryStore } from './local';

async function freshCompany(): Promise<Books> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await host.create({ name: 'T', fyStart: '2024-04-01' });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

describe('importItemsCsv', () => {
  it('creates new items, and updates (not duplicates) on a second run of the same file', async () => {
    const books = await freshCompany();
    const csv = 'name,code,alias,group,unit,hsn,gstRate,itemType\nBolt,FG-1,,,Nos,7318,18,finished\nSheet,,,,Kg,,,raw';
    const first = await importItemsCsv(books, csv);
    expect(first).toMatchObject({ created: 2, updated: 0, errors: [] });
    expect(books.masters.stockItems).toHaveLength(2);

    const second = await importItemsCsv(books, csv);
    expect(second).toMatchObject({ created: 0, updated: 2, errors: [] });
    expect(books.masters.stockItems).toHaveLength(2); // still 2, not 4
  });

  it('reports an unresolved unit by row, without stopping the rest of the file', async () => {
    const books = await freshCompany();
    const csv = 'name,code,alias,group,unit,hsn,gstRate,itemType\nBad Item,,,,NoSuchUnit,,,finished\nBolt,,,,Nos,,,finished';
    const r = await importItemsCsv(books, csv);
    expect(r.created).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.row).toBe(1);
    expect(books.masters.stockItems.map((i) => i.name)).toEqual(['Bolt']);
  });
});

describe('importPartiesCsv', () => {
  it('creates new parties, and updates on a second run', async () => {
    const books = await freshCompany();
    const csv =
      'name,gstin,pan,phone,email,address,stateCode,creditDays,creditLimit,gstRegistration,pincode,country,shippingLines,shippingStateCode,shippingPincode,shippingCountry,roles\n' +
      'Acme Ltd,,,,,,,,,,,,,,,,customer';
    const first = await importPartiesCsv(books, csv);
    expect(first).toMatchObject({ created: 1, updated: 0, errors: [] });
    const second = await importPartiesCsv(books, csv);
    expect(second).toMatchObject({ created: 0, updated: 1, errors: [] });
    expect(books.masters.parties).toHaveLength(1);
  });
});

describe('importVouchersCsv', () => {
  it('stages one Inbox proposal per docRef — nothing is posted', async () => {
    const books = await freshCompany();
    const csv =
      'docRef,kind,partyName,partyGstin,partyAddress,date,poNumber,invoiceNumber,dueDate,subtotal,grandTotal,description,code,hsn,qty,unit,rate,amount,gstRate,lineDueDate\n' +
      'INV-1,sales,Acme Ltd,,,2024-05-12,,,,,,Machining charges,,,4,Job,25,,,';
    const r = await importVouchersCsv(books, csv);
    expect(r).toMatchObject({ staged: 1, errors: [] });
    const inbox = await books.inbox();
    expect(inbox.ok && inbox.value).toHaveLength(1);
    expect(books.vouchers).toHaveLength(0);
  });
});
