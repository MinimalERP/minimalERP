import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { type LedgerId, type StockItemId, type WarehouseId, asCompanyId, deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { gstinCheckChar } from '../masters/rules';
import { seedCompany } from '../masters/seed';
import { orderBookOf } from '../orders/orderBook';
import { prepareVoucher } from '../posting/engine';
import { type PostingPlan } from '../posting/plan';
import { StockBook } from '../stock/book';
import { customerLedgerOf } from '../vouchers/kinds/documents';
import { defaultVoucherKinds } from '../vouchers/registry';
import type { Voucher } from '../vouchers/voucher';
import { type Extraction, type IntakeKind, dateText, decimalText, extractionSchema } from './extraction';
import { similarity } from './match';
import { proposeFromExtraction } from './propose';
import { proposalSchema } from './proposal';

const newId = (n: string) => deterministicUuid(`intake|${n}`);
const kinds = defaultVoucherKinds();
const gstin = (first14: string) => first14 + gstinCheckChar(first14);
const ACME_GSTIN = gstin('27AAPFA1234C1Z');

class Env {
  masters: Masters;
  vouchers: Voucher[] = [];
  private plans = new Map<string, PostingPlan>();
  readonly bolt = newId('bolt') as StockItemId;
  readonly sheet = newId('sheet') as StockItemId;
  readonly acme = newId('acme');
  readonly steel = newId('steel');
  readonly salesLedger = newId('sales-ledger');
  readonly purchases = newId('purchases') as LedgerId;
  readonly bank = newId('hdfc') as LedgerId;
  readonly main: WarehouseId;

  constructor() {
    let masters = seedCompany({ name: 'Padekar Engineering Pvt Ltd', fyStart: localDate('2024-04-01'), newId });
    const run = (kind: string, id: string, data: unknown) => {
      const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      masters = r.value.masters;
    };
    const nos = masters.units.find((u) => u.symbol === 'Nos')?.id as string;
    const kg = masters.units.find((u) => u.symbol === 'Kg')?.id as string;
    run('stockItem', this.bolt, { name: 'Hex Bolt M8 x 30', code: 'BLT-M8', unitId: nos, itemType: 'finished', hsn: '7318' });
    run('stockItem', this.sheet, { name: 'MS Sheet 2mm', unitId: kg, itemType: 'raw', hsn: '7208' });
    run('party', this.acme, { name: 'Acme Ltd', roles: ['customer'], gstin: ACME_GSTIN });
    run('party', this.steel, { name: 'Steel Supplier', roles: ['vendor'], creditDays: 30 });
    const group = (key: string) => newId(`group:${key}`);
    run('ledger', this.salesLedger, { name: 'Domestic Sales', groupId: group('sales-accounts') });
    run('ledger', this.purchases, { name: 'Purchases', groupId: group('purchase-accounts') });
    run('ledger', this.bank, { name: 'HDFC Bank 004411', groupId: group('bank-accounts') });
    this.masters = masters;
    this.main = masters.warehouses[0]?.id as WarehouseId;
  }

  typeId = (base: string) => this.masters.voucherTypes.find((t) => t.baseKind === base)?.id as string;
  stock = () => new StockBook(this.vouchers.flatMap((v) => this.plans.get(v.id)?.stock ?? []));
  orders = () => orderBookOf(this.vouchers, this.masters);

  post(input: Record<string, unknown>): Voucher {
    const r = prepareVoucher(input, this.masters, kinds, this.stock(), this.orders());
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const type = r.value.voucherType;
    const v: Voucher = {
      id: r.value.draft.id,
      companyId: asCompanyId('c'),
      voucherTypeId: type.id,
      financialYearId: r.value.financialYear.id,
      number: `${type.baseKind.toUpperCase()}/${this.vouchers.length + 1}`,
      date: r.value.draft.date,
      status: 'posted',
      version: 1,
      revision: 0,
      content: r.value.draft,
    };
    this.vouchers.push(v);
    this.plans.set(v.id, r.value.plan);
    return v;
  }

  propose(kind: IntakeKind, raw: Record<string, unknown>) {
    const p = proposeFromExtraction(kind, extractionSchema.parse(raw), {
      masters: this.masters,
      vouchers: this.vouchers,
      orders: this.orders(),
      today: localDate('2024-06-30'),
    });
    // whatever it makes must be storable as it is
    expect(proposalSchema.parse(p)).toEqual(p);
    return p;
  }
}

const codes = (p: { notes: readonly { code: string }[] }) => p.notes.map((n) => n.code);

describe('reading what the model returns', () => {
  it('takes numbers however they are printed', () => {
    expect(decimalText('1,23,456.50')).toBe('123456.50');
    expect(decimalText('₹ 1200')).toBe('1200');
    expect(decimalText('Rs. 99.5')).toBe('99.5');
    expect(decimalText(42)).toBe('42');
    expect(decimalText('-5')).toBeUndefined();
    expect(decimalText('about ten')).toBeUndefined();
  });

  it('reads Indian dates day first', () => {
    expect(dateText('2024-05-01')).toBe('2024-05-01');
    expect(dateText('01/05/2024')).toBe('2024-05-01');
    expect(dateText('1.5.2024')).toBe('2024-05-01');
    expect(dateText('31/02/2024')).toBeUndefined();
  });

  it('never fails on a messy reading: what cannot be read is simply absent', () => {
    const x: Extraction = extractionSchema.parse({ partyName: '  Acme   Ltd ', lines: 'oops', subtotal: 'n/a', date: 'yesterday' });
    expect(x.partyName).toBe('Acme Ltd');
    expect(x.lines).toEqual([]);
    expect(x.subtotal).toBeUndefined();
    expect(x.date).toBeUndefined();
  });

  it('scores names by how alike they are', () => {
    expect(similarity('Hex Bolt M8 x 30', 'HEX BOLT M8X30')).toBeGreaterThan(0.9);
    expect(similarity('Hex Bolt M8 x 30', 'MS Sheet 2mm')).toBeLessThan(0.3);
  });
});

describe('a customer PO → a Sales Order proposal', () => {
  it('matches the customer by GSTIN and items by code or name; keeps the PO number and line dates', () => {
    const e = new Env();
    const p = e.propose('salesOrder', {
      partyName: 'ACME LIMITED (Pune)',
      partyGstin: ACME_GSTIN,
      date: '10/05/2024',
      poNumber: 'PO-7781',
      dueDate: '2024-05-31',
      lines: [
        { description: 'Hex bolt', code: 'BLT-M8', qty: '500', rate: '4.50' },
        { description: 'MS SHEET 2MM', qty: '120.5', rate: '78', dueDate: '2024-05-20' },
      ],
      subtotal: '11649',
    });
    expect(p.party.partyId).toBe(e.acme);
    expect(p.date).toBe('2024-05-10');
    expect(p.reference).toBe('PO-7781');
    expect(p.lines.map((l) => [l.itemId, l.qty, l.rate, l.dueDate])).toEqual([
      [e.bolt, '500', '4.50', '2024-05-31'],
      [e.sheet, '120.5', '78', '2024-05-20'],
    ]);
    expect(p.notes).toEqual([]);
  });

  it('matches a customer by name when the GSTIN is missing, ignoring "Ltd" / "Limited"', () => {
    const e = new Env();
    expect(e.propose('salesOrder', { partyName: 'M/s. ACME LIMITED', lines: [] }).party.partyId).toBe(e.acme);
  });

  it('keeps an item it does not know as the document text — no item, never a guess', () => {
    const e = new Env();
    const p = e.propose('salesOrder', {
      partyName: 'Acme Ltd',
      date: '2024-05-10',
      lines: [{ description: 'SS 304 Washer M8 – as per drawing DRG-221 rev B, passivated and packed in 100s', qty: '1000', rate: '1.2' }],
    });
    const line = p.lines[0];
    expect(line?.itemId).toBeUndefined();
    expect(line?.text).toBe('SS 304 Washer M8 – as per drawing DRG-221 rev B, passivated and packed in 100s'.slice(0, 80));
    expect(line?.qty).toBe('1000');
    expect(codes(p)).toEqual(['ITEM_UNMATCHED']);
    expect(p.notes[0]?.path).toBe('lines.0.item');
  });

  it("matches an item whose whole name is inside the line, and only when one item's name is", () => {
    const e = new Env();
    const p = e.propose('salesOrder', { partyName: 'Acme Ltd', date: '2024-05-10', lines: [{ description: 'MS Sheet 2mm, cut to 1250x2500', qty: '500', rate: '62' }] });
    expect(p.lines[0]?.itemId).toBe(e.sheet);
    // a second item whose name is also in the line: no guess
    const r = prepareMasterCommand({ op: 'create', kind: 'stockItem', id: newId('sheet3'), data: { name: 'Cut to 1250x2500 blank', unitId: e.masters.units[0]?.id, itemType: 'raw' } }, e.masters);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    e.masters = r.value.masters;
    const both = e.propose('salesOrder', { partyName: 'Acme Ltd', date: '2024-05-10', lines: [{ description: 'MS Sheet 2mm cut to 1250x2500 blank', qty: '1', rate: '1' }] });
    expect(both.lines[0]?.itemId).toBeUndefined();
  });

  it('leaves an unknown customer to the person, with the name and GSTIN to create it from', () => {
    const e = new Env();
    const other = gstin('29AABCZ9999Q1Z');
    const p = e.propose('salesOrder', { partyName: 'Zenith Motors', partyGstin: other, partyAddress: 'Plot 4, Hosur Road', date: '2024-05-10', lines: [] });
    expect(p.party).toEqual({ name: 'Zenith Motors', gstin: other, address: 'Plot 4, Hosur Road' });
    expect(codes(p)).toEqual(['PARTY_UNMATCHED', 'NO_LINES']);
  });

  it('does not make a supplier the customer of an order', () => {
    const e = new Env();
    const p = e.propose('salesOrder', { partyName: 'Steel Supplier', date: '2024-05-10', lines: [] });
    expect(p.party.partyId).toBeUndefined();
    expect(codes(p)).toContain('PARTY_ROLE_MISSING');
  });

  it('warns when the same PO is already an order of that customer', () => {
    const e = new Env();
    e.post({
      id: newId('so1'),
      voucherTypeId: e.typeId('salesOrder'),
      date: '2024-05-01',
      partyId: e.acme,
      partyDetails: { partyId: e.acme, mailingName: 'Acme Ltd' },
      reference: 'PO-7781',
      lines: [{ id: 'a', itemId: e.bolt, qty: '10', rate: '5', dueDate: '2024-05-20' }],
    });
    const p = e.propose('salesOrder', { partyName: 'Acme Ltd', poNumber: 'po-7781', date: '2024-05-10', lines: [{ code: 'BLT-M8', qty: '1', rate: '5' }] });
    expect(codes(p)).toEqual(['DUPLICATE_PO']);
    // …and an invoice mail quoting that PO delivers against the order
    expect(e.propose('sales', { partyName: 'Acme Ltd', poNumber: 'PO-7781', date: '2024-05-12' }).fromOrderId).toBe(newId('so1'));
  });

  it('finds the rate from the amount when only quantity and amount are printed, and checks the total', () => {
    const e = new Env();
    const p = e.propose('salesOrder', { partyName: 'Acme Ltd', date: '2024-05-10', lines: [{ code: 'BLT-M8', qty: '400', amount: '1800' }], subtotal: '2500' });
    expect(p.lines[0]?.rate).toBe('4.5');
    expect(codes(p)).toEqual(['TOTAL_MISMATCH']);
  });

  it('proposes today and says so when the document has no date', () => {
    const e = new Env();
    const p = e.propose('salesOrder', { partyName: 'Acme Ltd', lines: [{ code: 'BLT-M8', qty: '1', rate: '5' }] });
    expect(p.date).toBe('2024-06-30');
    expect(codes(p)).toEqual(['DATE_MISSING']);
  });
});

describe("a supplier's bill → a Purchase Invoice proposal", () => {
  it("takes the supplier's invoice number, and warns when it is already a bill of theirs", () => {
    const e = new Env();
    const bill = { partyName: 'Steel Supplier', date: '2024-05-12', invoiceNumber: 'SS/889', lines: [{ description: 'MS Sheet 2mm', qty: '100', rate: '80' }] };
    const first = e.propose('purchase', bill);
    expect(first.billNo).toBe('SS/889');
    expect(first.party.partyId).toBe(e.steel);
    expect(first.notes).toEqual([]);
    e.post({
      id: newId('pur1'),
      voucherTypeId: e.typeId('purchase'),
      date: '2024-05-12',
      partyId: e.steel,
      partyDetails: { partyId: e.steel, mailingName: 'Steel Supplier' },
      purchaseLedgerId: e.purchases,
      billNo: 'SS/889',
      dueDate: '2024-06-11',
      lines: [{ itemId: e.sheet, warehouseId: e.main, qty: '100', rate: '80' }],
    });
    expect(codes(e.propose('purchase', bill))).toEqual(['DUPLICATE_BILL']);
  });

  it('asks for the invoice number when it was not read', () => {
    const e = new Env();
    expect(codes(e.propose('purchase', { partyName: 'Steel Supplier', date: '2024-05-12', lines: [{ description: 'MS Sheet 2mm', qty: '1', rate: '80' }] }))).toEqual([
      'BILL_NO_MISSING',
    ]);
  });
});

describe('a payment advice → a Receipt proposal', () => {
  const withInvoice = () => {
    const e = new Env();
    e.post({
      id: newId('pur0'),
      voucherTypeId: e.typeId('purchase'),
      date: '2024-05-01',
      partyId: e.steel,
      partyDetails: { partyId: e.steel, mailingName: 'Steel Supplier' },
      purchaseLedgerId: e.purchases,
      billNo: 'SS/1',
      dueDate: '2024-05-31',
      lines: [{ itemId: e.bolt, warehouseId: e.main, qty: '1000', rate: '4' }],
    });
    const inv = e.post({
      id: newId('inv1'),
      voucherTypeId: e.typeId('sales'),
      date: '2024-05-10',
      partyId: e.acme,
      partyDetails: { partyId: e.acme, mailingName: 'Acme Ltd' },
      salesLedgerId: e.salesLedger,
      dueDate: '2024-06-09',
      lines: [{ itemId: e.bolt, warehouseId: e.main, qty: '200', rate: '50' }],
    });
    return { e, inv };
  };

  it('settles the open bill it names, TDS included, through the only bank', () => {
    const { e, inv } = withInvoice();
    const p = e.propose('receipt', { partyName: 'Acme Ltd', date: '2024-06-05', amount: '9900', instrument: 'UTR N123456789', bills: [{ ref: inv.number, amount: '10000', tds: '100' }] });
    expect(p.party.partyId).toBe(e.acme);
    expect(p.accountLedgerId).toBe(e.bank);
    expect(p.amount).toBe('9900.00');
    expect(p.bills).toEqual([{ ref: inv.number, amount: '10000.00', tds: '100.00', open: true }]);
    expect(p.notes).toEqual([]);
  });

  it('picks the bank by the account digits the advice gives, and asks when there is more than one bank', () => {
    const { e } = withInvoice();
    const sbi = newId('sbi');
    const r = prepareMasterCommand({ op: 'create', kind: 'ledger', id: sbi, data: { name: 'SBI Current 7702', groupId: newId('group:bank-accounts') } }, e.masters);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    e.masters = r.value.masters;
    expect(e.propose('receipt', { partyName: 'Acme Ltd', date: '2024-06-05', amount: '5', bankAccount: 'XXXXXXXX7702' }).accountLedgerId).toBe(sbi);
    expect(e.propose('receipt', { partyName: 'Acme Ltd', date: '2024-06-05', amount: '5', bankAccount: 'A/c 50100004411' }).accountLedgerId).toBe(e.bank);
    expect(codes(e.propose('receipt', { partyName: 'Acme Ltd', date: '2024-06-05', amount: '5' }))).toEqual(['BANK_UNMATCHED']);
  });

  it('says what is left over and which bills are not open', () => {
    const { e, inv } = withInvoice();
    const p = e.propose('receipt', { partyName: 'Acme Ltd', date: '2024-06-05', amount: '12000', bills: [{ ref: inv.number, amount: '10000' }, { ref: 'INV-OLD-9', amount: '500' }] });
    expect(codes(p)).toEqual(['BILL_NOT_OPEN', 'UNALLOCATED']);
    expect(p.notes[1]?.message).toContain('1500.00');
  });

  it('warns when the same UTR is already in a receipt', () => {
    const { e, inv } = withInvoice();
    e.post({
      id: newId('rc1'),
      voucherTypeId: e.typeId('receipt'),
      date: '2024-06-05',
      narration: 'NEFT UTR N123456789',
      accountLedgerId: e.bank,
      lines: [{ ledgerId: customerLedgerOf(e.acme as never), amount: '10000', allocations: [{ kind: 'against', ref: inv.number, amount: '10000' }] }],
    });
    const p = e.propose('receipt', { partyName: 'Acme Ltd', date: '2024-06-05', amount: '10000', instrument: 'N123456789', bills: [{ ref: inv.number, amount: '10000' }] });
    expect(codes(p)).toEqual(['DUPLICATE_UTR', 'BILL_NOT_OPEN']);
  });
});
