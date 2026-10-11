import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type StockItem, deterministicUuid } from '@minimalerp/domain';
import { searchEntities } from '@minimalerp/command';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from './books';
import { loadDemoCompany } from './demo';
import { entityDocsOf } from './entities';
import { FORMS, recordToValues, valuesToData } from './forms';
import { createLocalFactory, memoryStore } from './local';
import { itemOptions } from '../vouchers/salesModel';
import { matchOptions } from '../vouchers/layouts/worksheetKit';

const bracketId = deterministicUuid('demo|stockItem|Mounting Bracket');

async function demo(): Promise<Books> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}
const bracket = (books: Books) => books.masters.stockItems.find((i) => i.id === bracketId) as StockItem;
const save = async (books: Books, change: Record<string, string>) => {
  const spec = FORMS.stockItem;
  const values = { ...recordToValues(spec, bracket(books)), ...change };
  const r = await books.execute({ op: 'alter', kind: 'stockItem', id: bracketId, data: valuesToData(spec, values) as never });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
};

describe('an item’s tags', () => {
  it('are two plain text fields on the item form, saved with the item and cleared when emptied', async () => {
    const books = await demo();
    expect(FORMS.stockItem.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['tags1', 'tags2']));
    await save(books, { tags1: 'laser cutting, welding', tags2: 'SS310' });
    expect([bracket(books).tags1, bracket(books).tags2]).toEqual(['laser cutting, welding', 'SS310']);
    await save(books, { tags2: '' });
    expect([bracket(books).tags1, bracket(books).tags2]).toEqual(['laser cutting, welding', undefined]);
  });

  it('a change that says nothing of tags (a CSV import) leaves them as they are', async () => {
    const books = await demo();
    await save(books, { tags1: 'SS310' });
    const { name, code, unitId, groupId, hsn, gstRateId, itemType } = bracket(books);
    const r = await books.execute({ op: 'alter', kind: 'stockItem', id: bracketId, data: { name, code, unitId, groupId, hsn, gstRateId, itemType } as never });
    expect(r.ok).toBe(true);
    expect(bracket(books).tags1).toBe('SS310');
  });

  it('find the item: in Go To and the item list, and in the item cell of a voucher', async () => {
    const books = await demo();
    await save(books, { tags1: 'laser cutting, welding', tags2: 'SS310' });
    const hits = (text: string) => searchEntities(entityDocsOf(books.masters), text, { limit: 5 }).map((h) => h.title);
    expect(hits('ss310')).toContain('Mounting Bracket');
    expect(hits('welding')).toContain('Mounting Bracket');
    expect(matchOptions(itemOptions(books.masters), 'ss310', '').map((o) => o.name)).toEqual(['Mounting Bracket']);
  });
});
