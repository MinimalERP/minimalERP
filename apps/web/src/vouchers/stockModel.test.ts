import { MemoryBackend } from '@minimalerp/adapter-memory';
import { IssueCode, deterministicUuid, formatMoney } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import {
  type StockForm,
  type StockLineForm,
  blankStockForm,
  blankStockLine,
  defaultWarehouse,
  fieldOfStockPath,
  formToStockDraft,
  isBlankStock,
  previewStock,
  stockFormFromVoucher,
  trimPlaces,
} from './stockModel';

const item = (name: string) => deterministicUuid(`demo|stockItem|${name}`);

async function demo(): Promise<Books> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

describe('the Stock Journal form', () => {
  it('starts with one Out line in the main godown, and a blank form is one with nothing entered (a default godown is not "entered")', async () => {
    const books = await demo();
    const main = defaultWarehouse(books.masters);
    const form = blankStockForm('v1', 'type', '2026-05-01', main);
    expect(form.lines).toHaveLength(1);
    expect(form.lines[0]).toMatchObject({ direction: 'out', warehouseLabel: 'Main Location' });
    expect(isBlankStock(form)).toBe(true);
    expect(isBlankStock({ ...form, narration: 'x' })).toBe(false);
    expect(isBlankStock({ ...form, lines: [{ ...(form.lines[0] as StockLineForm), qty: '1' }] })).toBe(false);
  });

  it('builds the draft: empty lines are left out, an In carries its rate, an Out none', () => {
    const form: StockForm = {
      id: 'v1',
      typeId: 't',
      date: '2026-05-01',
      narration: ' moved ',
      lines: [
        { ...blankStockLine('out', { id: 'w1', label: 'Main' }), itemId: 'i1', itemLabel: 'Bolt', qty: ' 5 ', rate: '9' }, // a stray rate on an Out is not sent
        blankStockLine('in', { id: 'w1', label: 'Main' }), // empty: left out
        { ...blankStockLine('in', { id: 'w2', label: 'Yard' }), itemId: 'i1', itemLabel: 'Bolt', qty: '5', rate: '9.5' },
      ],
    };
    const { draft, kept } = formToStockDraft(form);
    expect(kept).toEqual([0, 2]);
    expect(draft).toEqual({
      id: 'v1',
      voucherTypeId: 't',
      date: '2026-05-01',
      narration: 'moved',
      entries: [
        { itemId: 'i1', warehouseId: 'w1', direction: 'out', qty: '5' },
        { itemId: 'i1', warehouseId: 'w2', direction: 'in', qty: '5', rate: '9.5' },
      ],
    });
  });

  it('puts a problem on the cell it belongs to, counting only the lines actually sent', () => {
    expect(fieldOfStockPath('entries.1.qty', [0, 2])).toBe('line.2.qty');
    expect(fieldOfStockPath('entries.0.itemId', [3])).toBe('line.3.item');
    expect(fieldOfStockPath('entries.0.warehouseId', [0])).toBe('line.0.wh');
    expect(fieldOfStockPath('entries.0.rate', [0])).toBe('line.0.rate');
    expect(fieldOfStockPath('date', [])).toBe('date');
    expect(fieldOfStockPath('entries', [0])).toBe('general');
    expect(fieldOfStockPath(undefined, [])).toBe('general');
  });

  it('says what is missing on the cell, before asking the engine', async () => {
    const books = await demo();
    const form: StockForm = {
      ...blankStockForm('v1', 'type', '2026-05-01', defaultWarehouse(books.masters)),
      lines: [{ ...blankStockLine('in', defaultWarehouse(books.masters)), itemId: item('MS Sheet 2mm'), itemLabel: 'MS Sheet 2mm', qty: '5' }],
    };
    const p = previewStock(form, books.masters, books.stock);
    expect(p.ok).toBe(false);
    expect(p.issues).toEqual([{ field: 'line.0.rate', message: 'Enter the rate (0 for a free issue)' }]);
    expect(previewStock({ ...form, lines: [] }, books.masters, books.stock).issues[0]).toMatchObject({ field: 'general' });
  });

  it('previews with the SAME engine: an Out beyond the stock is refused on its quantity cell, with the item and godown named', async () => {
    const books = await demo();
    const typeId = books.masters.voucherTypes.find((t) => t.baseKind === 'stockJournal')?.id as string;
    const finished = books.masters.warehouses.find((w) => w.name === 'Finished Goods Store');
    const form: StockForm = {
      ...blankStockForm('v1', typeId, '2027-03-01', defaultWarehouse(books.masters)),
      lines: [{ ...blankStockLine('out', { id: finished?.id as string, label: 'Finished Goods Store' }), itemId: item('Fabricated Frame'), itemLabel: 'Fabricated Frame', qty: '61' }],
    };
    // (the demo's financial year is the one we are in; use a date inside it)
    const dated = { ...form, date: books.masters.financialYears[0]?.end as string };
    const p = previewStock(dated, books.masters, books.stock);
    expect(p.ok).toBe(false);
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0]).toMatchObject({ field: 'line.0.qty', code: IssueCode.StockNegative });
    expect(p.issues[0]?.message).toMatch(/Fabricated Frame/);
    expect(p.issues[0]?.message).toMatch(/Finished Goods Store/);
  });

  it('reads an Out’s value from the stock: a transfer keeps the item’s value, and the totals show it', async () => {
    const books = await demo();
    const typeId = books.masters.voucherTypes.find((t) => t.baseKind === 'stockJournal')?.id as string;
    const from = books.masters.warehouses.find((w) => w.name === 'Finished Goods Store');
    const to = books.masters.warehouses.find((w) => w.name === 'Scrap Yard');
    const date = books.masters.financialYears[0]?.end as string;
    const form: StockForm = {
      id: 'v1',
      typeId,
      date,
      narration: '',
      lines: [
        { ...blankStockLine('out', { id: from?.id as string, label: 'FGS' }), itemId: item('Mounting Bracket'), itemLabel: 'Mounting Bracket', qty: '100' },
        { ...blankStockLine('in', { id: to?.id as string, label: 'Yard' }), itemId: item('Mounting Bracket'), itemLabel: 'Mounting Bracket', qty: '100', rate: '38' },
      ],
    };
    const p = previewStock(form, books.masters, books.stock);
    expect(p.issues).toEqual([]);
    expect(p.ok).toBe(true);
    expect(formatMoney(p.values.get(0)?.value as never)).toBe('3800.00'); // 100 × the average 38.00
    expect(formatMoney(p.values.get(1)?.value as never)).toBe('3800.00');
    expect(p.valueOut).toBe(380000n);
    expect(p.valueIn).toBe(380000n);
  });

  it('reads a posted stock journal back into the form, quantities as a person typed them', async () => {
    const books = await demo();
    const posted = books.vouchers.find((v) => (v.content as { narration?: string }).narration === 'Frames fabricated from sheet and rod');
    expect(posted).toBeDefined();
    const form = stockFormFromVoucher(posted as never, books.masters);
    expect(form.lines.map((l) => [l.direction, l.itemLabel, l.warehouseLabel, l.qty, l.rate])).toEqual([
      ['out', 'MS Sheet 2mm', 'Main Location', '300', ''],
      ['out', 'MS Rod 12mm', 'Main Location', '100', ''],
      ['in', 'Fabricated Frame', 'Finished Goods Store', '60', '950'],
    ]);
    // altering it unchanged is a no-op for the engine
    expect(previewStock(form, books.masters, books.stock).ok).toBe(true);
  });

  it('trims the places the wire keeps', () => {
    expect(trimPlaces('10.0000')).toBe('10');
    expect(trimPlaces('2.5000')).toBe('2.5');
    expect(trimPlaces('58.2500')).toBe('58.25');
    expect(trimPlaces('100')).toBe('100');
  });
});
