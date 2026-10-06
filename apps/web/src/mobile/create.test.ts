import { MemoryBackend } from '@minimalerp/adapter-memory';
import { gstinCheckChar } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { previewSales } from '../vouchers/salesModel';
import { blankCustomer, blankItem, createProblems, customerCommand, itemCommand, withGstin } from './create';
import { lineFor, newForm, withParty } from './entry';

async function demo(): Promise<Books> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

describe('a stock item or customer made on the phone is the desktop’s own master', () => {
  it('a new item starts in Nos as finished goods; the rules judge it before it is sent, and it can be quoted at once', async () => {
    const books = await demo();
    const fields = blankItem(books, 'Gasket Kit');
    expect(books.masters.unit(fields.unitId as never)?.symbol).toBe('Nos');
    expect(fields.itemType).toBe('finished');
    const id = crypto.randomUUID();
    expect(createProblems(books, itemCommand(id, fields))).toEqual({});
    expect(createProblems(books, itemCommand(id, { ...fields, name: ' ' }))['name']).toBeDefined();
    expect(createProblems(books, itemCommand(id, { ...fields, name: 'machine oil' }))['name']).toBeDefined(); // the name is taken
    expect((await books.execute(itemCommand(id, { ...fields, hsn: '8484' }))).ok).toBe(true);
    expect(books.masters.stockItem(id as never)).toMatchObject({ name: 'Gasket Kit', hsn: '8484', isActive: true });

    const quote = withParty(newForm(books, 'quotation')!, 'quotation', books, books.masters.parties[0]!.id);
    const line = { ...lineFor(books, 'quotation', quote, id), rate: '120' };
    expect(line.itemLabel).toBe('Gasket Kit');
    expect(previewSales({ ...quote, lines: [line] }, 'quotation', books.masters, books.stock, books.orders, undefined, books.vouchers).ok).toBe(true);
  });

  it('a new customer is a party with the Customer role and its receivable ledger; a GSTIN sets its state, a bad one is refused', async () => {
    const books = await demo();
    const blank = blankCustomer(books, 'Zenith Motors');
    const gstin = `07AAACZ1234F1Z${gstinCheckChar('07AAACZ1234F1Z')}`;
    const fields = withGstin({ ...blank, phone: '9876543210' }, gstin.toLowerCase());
    expect(fields.gstin).toBe(gstin);
    expect(fields.stateCode).toBe('07');
    const id = crypto.randomUUID();
    expect(createProblems(books, customerCommand(id, fields))).toEqual({});
    expect(createProblems(books, customerCommand(id, { ...fields, gstin: '07AAACZ1234F1Z0' }))['gstin']).toBeDefined();
    expect(createProblems(books, customerCommand(id, { ...blank, name: '' }))['name']).toBeDefined();
    expect((await books.execute(customerCommand(id, fields))).ok).toBe(true);
    const party = books.masters.party(id as never)!;
    expect(party).toMatchObject({ name: 'Zenith Motors', roles: ['customer'], phone: '9876543210', gstin, stateCode: '07' });
    expect(books.masters.ledgers.some((l) => l.partyId === party.id && l.partyRole === 'customer')).toBe(true);
    // and it can be invoiced straight away
    const form = withParty(newForm(books, 'sales')!, 'sales', books, id);
    expect(form.partyLabel).toBe('Zenith Motors');
    expect(form.partyDetails?.gstin).toBe(gstin);
  });
});
