import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { IssueCode } from '../errors';
import { type LedgerId, asCompanyId, deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { gstinCheckChar } from '../masters/rules';
import { seedCompany } from '../masters/seed';
import { orderBookOf } from '../orders/orderBook';
import { prepareVoucher } from '../posting/engine';
import type { PostingPlan } from '../posting/plan';
import { StockBook } from '../stock/book';
import { vendorLedgerOf } from '../vouchers/kinds/documents';
import { defaultVoucherKinds } from '../vouchers/registry';
import type { Voucher } from '../vouchers/voucher';
import { outgoingOf } from './exchange';
import { proposeFromExtraction } from './propose';
import { proposalSchema } from './proposal';

const kinds = defaultVoucherKinds();
const gstin = (first14: string) => first14 + gstinCheckChar(first14);
const MICRO = gstin('27AAACM1234C1Z');
const TOOLS = gstin('27AAACT5678D1Z');

/** One of the owner's companies: its own masters, with the other company kept as a party by hand (the ERP never makes one). */
class Books {
  masters: Masters;
  vouchers: Voucher[] = [];
  private plans = new Map<string, PostingPlan>();
  readonly id: (n: string) => string;

  constructor(name: string, own: string | undefined, other: { name: string; gstin: string | undefined; roles: string[] }, items: { name: string; code: string }[]) {
    this.id = (n) => deterministicUuid(`exchange|${name}|${n}`);
    let masters = seedCompany({ name, fyStart: localDate('2024-04-01'), gstin: own, newId: this.id });
    const run = (kind: string, id: string, data: unknown) => {
      const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      masters = r.value.masters;
    };
    const nos = masters.units.find((u) => u.symbol === 'Nos')?.id as string;
    for (const it of items) run('stockItem', this.id(`item:${it.code}`), { name: it.name, code: it.code, unitId: nos, itemType: 'finished', hsn: '7318' });
    run('party', this.id('other'), { name: other.name, roles: other.roles, ...(other.gstin ? { gstin: other.gstin } : {}) });
    run('party', this.id('stranger'), { name: 'Somebody Else', roles: ['vendor'] });
    run('ledger', this.id('sales-ledger'), { name: 'Domestic Sales', groupId: this.id('group:sales-accounts') });
    run('ledger', this.id('purchases'), { name: 'Purchases', groupId: this.id('group:purchase-accounts') });
    run('ledger', this.id('bank'), { name: 'HDFC Bank', groupId: this.id('group:bank-accounts') });
    this.masters = masters;
  }

  typeId = (base: string) => this.masters.voucherTypes.find((t) => t.baseKind === base)?.id as string;

  post(raw: Record<string, unknown>): Voucher {
    // a document carries its party's details, as the voucher window fills them
    const party = typeof raw['partyId'] === 'string' ? this.masters.party(raw['partyId'] as never) : undefined;
    const input = party && !raw['partyDetails'] ? { ...raw, partyDetails: { partyId: party.id, mailingName: party.name, ...(party.gstin ? { gstin: party.gstin } : {}) } } : raw;
    const orders = orderBookOf(this.vouchers, this.masters);
    const stock = new StockBook(this.vouchers.flatMap((v) => this.plans.get(v.id)?.stock ?? []));
    const r = prepareVoucher(input, this.masters, kinds, stock, orders);
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

  /** What arrives here from the other company, matched against THESE books. */
  receive(from: Books, voucher: Voucher) {
    const out = outgoingOf(voucher, from.masters);
    if (!out.ok) throw new Error(JSON.stringify(out.issues));
    const p = proposeFromExtraction(out.value.toKind, out.value.extraction, {
      masters: this.masters,
      vouchers: this.vouchers,
      orders: orderBookOf(this.vouchers, this.masters),
      today: localDate('2024-06-30'),
    });
    expect(proposalSchema.parse(p)).toEqual(p);
    return { out: out.value, proposal: p };
  }
}

const micro = () => new Books('Micro Components', MICRO, { name: 'Tools Division', gstin: TOOLS, roles: ['customer', 'vendor'] }, [{ name: 'Hex Bolt M8', code: 'BLT-M8' }]);
// The other company names the same bolt its own way; the code is what they share. It does not have the washer at all.
const tools = () => new Books('Tools Division', TOOLS, { name: 'Micro Components Pvt Ltd', gstin: MICRO, roles: ['customer', 'vendor'] }, [{ name: 'Bolt, hex, M8', code: 'BLT-M8' }]);

describe('a purchase order sent to the company it is addressed to', () => {
  it('arrives as their sales order: we are their customer (by our GSTIN), our PO number is their customer PO, items matched by code', () => {
    const a = micro();
    const b = tools();
    const po = a.post({
      id: a.id('po1'),
      voucherTypeId: a.typeId('purchaseOrder'),
      date: '2024-06-01',
      partyId: a.id('other'),
      lines: [
        { id: 'l1', itemId: a.id('item:BLT-M8'), qty: '500', rate: '4.25', dueDate: '2024-06-20' },
      ],
    });
    const { out, proposal } = b.receive(a, po);
    expect(out.toKind).toBe('salesOrder');
    expect(out.party.gstin).toBe(TOOLS);
    expect(proposal.party.partyId).toBe(b.id('other'));
    expect(proposal.reference).toBe(po.number);
    expect(proposal.lines).toEqual([{ itemId: b.id('item:BLT-M8'), text: 'BLT-M8 - Hex Bolt M8', qty: '500', rate: '4.25', unit: 'Nos', hsn: '7318', dueDate: '2024-06-20' }]);
    expect(proposal.notes).toEqual([]);
  });

  it('never guesses: an item they do not have stays our text for their person to choose (or create)', () => {
    const a = new Books('Micro Components', MICRO, { name: 'Tools Division', gstin: TOOLS, roles: ['vendor'] }, [{ name: 'Spring Washer M8', code: 'WSH-M8' }]);
    const b = tools();
    const po = a.post({ id: a.id('po2'), voucherTypeId: a.typeId('purchaseOrder'), date: '2024-06-01', partyId: a.id('other'), lines: [{ id: 'l1', itemId: a.id('item:WSH-M8'), qty: '10', rate: '1', dueDate: '2024-06-20' }] });
    const { proposal } = b.receive(a, po);
    expect(proposal.lines[0]?.itemId).toBeUndefined();
    expect(proposal.lines[0]?.text).toBe('WSH-M8 - Spring Washer M8');
    expect(proposal.notes.map((n) => n.code)).toEqual(['ITEM_UNMATCHED']);
  });

  it('when they keep no party with our GSTIN, the party is left for them to pick — nothing is created in their books', () => {
    const a = micro();
    const b = new Books('Tools Division', TOOLS, { name: 'Someone', gstin: undefined, roles: ['customer'] }, [{ name: 'Bolt', code: 'BLT-M8' }]);
    const po = a.post({ id: a.id('po3'), voucherTypeId: a.typeId('purchaseOrder'), date: '2024-06-01', partyId: a.id('other'), lines: [{ id: 'l1', itemId: a.id('item:BLT-M8'), qty: '1', rate: '1', dueDate: '2024-06-20' }] });
    const { proposal } = b.receive(a, po);
    expect(proposal.party.partyId).toBeUndefined();
    expect(proposal.party.gstin).toBe(MICRO);
    expect(proposal.notes.map((n) => n.code)).toContain('PARTY_UNMATCHED');
    expect(b.masters.parties.map((p) => p.name).sort()).toEqual(['Somebody Else', 'Someone']);
  });
});

describe('a sales invoice and a payment', () => {
  it('our invoice arrives as their purchase, our number as their supplier’s invoice number', () => {
    const a = micro();
    const b = tools();
    const inv = a.post({
      id: a.id('inv1'),
      voucherTypeId: a.typeId('sales'),
      date: '2024-06-05',
      partyId: a.id('other'),
      salesLedgerId: a.id('sales-ledger'),
      dueDate: '2024-07-05',
      lines: [{ description: 'Machining charges', unit: 'Nos', qty: '2', rate: '1500' }],
    });
    const { out, proposal } = b.receive(a, inv);
    expect(out.toKind).toBe('purchase');
    expect(proposal.kind).toBe('purchase');
    expect(proposal.party.partyId).toBe(b.id('other'));
    expect(proposal.billNo).toBe(inv.number);
    expect(proposal.dueDate).toBe('2024-07-05');
    expect(proposal.lines).toMatchObject([{ text: 'Machining charges', qty: '2', rate: '1500' }]);
  });

  it('our payment arrives as their receipt, against the invoices it settles (named by their numbers)', () => {
    const a = micro();
    const b = tools();
    // Their invoice SALES/7 is a bill in our books under that number (we entered it as a purchase from them).
    a.post({
      id: a.id('bill'),
      voucherTypeId: a.typeId('purchase'),
      date: '2024-06-05',
      partyId: a.id('other'),
      purchaseLedgerId: a.id('purchases'),
      billNo: 'SALES/7',
      dueDate: '2024-07-05',
      lines: [{ description: 'Machining charges', unit: 'Nos', qty: '2', rate: '1500' }],
    });
    const pay = a.post({
      id: a.id('pay'),
      voucherTypeId: a.typeId('payment'),
      date: '2024-06-25',
      accountLedgerId: a.id('bank'),
      lines: [{ ledgerId: vendorLedgerOf(a.id('other') as never), amount: '3000', allocations: [{ kind: 'against', ref: 'SALES/7', amount: '3000' }] }],
    });
    const { out, proposal } = b.receive(a, pay);
    expect(out.toKind).toBe('receipt');
    expect(proposal.party.partyId).toBe(b.id('other'));
    expect(proposal.amount).toBe('3000.00');
    expect(proposal.bills).toEqual([{ ref: 'SALES/7', amount: '3000.00', open: false }]);
    expect(proposal.accountLedgerId).toBe(b.id('bank'));
  });
});

describe('what cannot be sent, and why', () => {
  const refusal = (r: ReturnType<typeof outgoingOf>) => (r.ok ? '' : `${r.issues[0]?.code}: ${r.issues[0]?.message}`);

  it('a voucher kind that does not travel', () => {
    const a = micro();
    const j = a.post({
      id: a.id('j'),
      voucherTypeId: a.typeId('journal'),
      date: '2024-06-01',
      entries: [
        { ledgerId: a.id('purchases') as LedgerId, side: 'debit', amount: '1' },
        { ledgerId: a.id('sales-ledger') as LedgerId, side: 'credit', amount: '1' },
      ],
    });
    expect(refusal(outgoingOf(j, a.masters))).toMatch(new RegExp(`^${IssueCode.ExchangeNotPossible}: Only a Purchase Order`));
  });

  it('a party without a GSTIN, and a company without one of its own', () => {
    const a = micro();
    const po = a.post({ id: a.id('po'), voucherTypeId: a.typeId('purchaseOrder'), date: '2024-06-01', partyId: a.id('stranger'), lines: [{ id: 'l1', itemId: a.id('item:BLT-M8'), qty: '1', rate: '1', dueDate: '2024-06-20' }] });
    expect(refusal(outgoingOf(po, a.masters))).toMatch(/Somebody Else has no GSTIN/);

    const noGstin = new Books('No GSTIN Co', undefined, { name: 'Tools Division', gstin: TOOLS, roles: ['vendor'] }, [{ name: 'Bolt', code: 'BLT-M8' }]);
    const po2 = noGstin.post({ id: noGstin.id('po'), voucherTypeId: noGstin.typeId('purchaseOrder'), date: '2024-06-01', partyId: noGstin.id('other'), lines: [{ id: 'l1', itemId: noGstin.id('item:BLT-M8'), qty: '1', rate: '1', dueDate: '2024-06-20' }] });
    expect(refusal(outgoingOf(po2, noGstin.masters))).toMatch(/No GSTIN Co has no GSTIN/);
  });

  it('a payment to several suppliers, and a cancelled voucher', () => {
    const a = micro();
    const pay = a.post({
      id: a.id('pay2'),
      voucherTypeId: a.typeId('payment'),
      date: '2024-06-25',
      accountLedgerId: a.id('bank'),
      lines: [
        { ledgerId: vendorLedgerOf(a.id('other') as never), amount: '10' },
        { ledgerId: vendorLedgerOf(a.id('stranger') as never), amount: '10' },
      ],
    });
    expect(refusal(outgoingOf(pay, a.masters))).toMatch(/several suppliers/);
    expect(refusal(outgoingOf({ ...pay, status: 'cancelled' }, a.masters))).toMatch(/cancelled/);
  });
});
