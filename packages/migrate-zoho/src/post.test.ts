import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type CompanyId, deterministicUuid, gstinCheckChar, localDate, seedCompany } from '@minimalerp/domain';
import type { ZohoInvoice, ZohoLine } from './csv';
import { createMasters, gstRateOf, planOf, postInvoices, postStock } from './post';

const newId = (name: string) => deterministicUuid(`zoho-test|${name}`);
const gstin = (prefix: string) => prefix + gstinCheckChar(prefix);

const line = (over: Partial<ZohoLine> = {}): ZohoLine => ({
  invoiceId: '5001',
  invoiceNumber: '25-26/001',
  invoiceDate: '2025-06-10',
  invoiceStatus: 'Closed',
  customerId: '9001',
  customerName: 'Acme Ltd',
  gstin: gstin('27AAACE9659G1Z'),
  placeOfSupply: '27-Maharashtra',
  billingAttention: '',
  billingAddress: 'Plot 2',
  billingCity: 'Pune',
  billingState: 'Maharashtra',
  billingCode: '412216',
  primaryEmail: '',
  paymentTermsDays: '30',
  dueDate: '2025-07-10',
  purchaseOrder: '',
  subtotal: '300.00',
  total: '341.00',
  roundOff: '0.00',
  itemName: '14188-4 - PLT,ORIF',
  itemDesc: '',
  quantity: '2.00',
  usageUnit: 'Nos',
  itemPrice: '100.00',
  hsn: '84879000',
  cgstRate: '9.00',
  sgstRate: '9.00',
  igstRate: '0.00',
  ...over,
});

describe('gstRateOf', () => {
  it('reads the rate Zoho charged: CGST + SGST, or IGST, or 0 for an untaxed line', () => {
    expect(gstRateOf(line())).toBe('18');
    expect(gstRateOf(line({ cgstRate: '2.50', sgstRate: '2.50' }))).toBe('5');
    expect(gstRateOf(line({ cgstRate: '0.00', sgstRate: '0.00', igstRate: '12.00' }))).toBe('12');
    expect(gstRateOf(line({ cgstRate: '', sgstRate: '', igstRate: '' }))).toBe('0');
  });
});

describe('a previous year’s Zoho invoices, rehearsed in memory', () => {
  it('posts into a financial year added BEFORE the company’s first one, each line at its own GST rate, with Zoho’s number', async () => {
    // a company that began in 2026-27, with GST on
    let masters = seedCompany({ name: 'Works', fyStart: localDate('2026-04-01'), newId, gstin: gstin('27AABCD1234E1Z'), stateCode: '27' });
    masters = masters.with({ company: { ...masters.company, chargeGst: true } });
    const companyId = masters.company.id as CompanyId;
    const gw = new MemoryBackend(masters);
    const salesGroup = masters.groups.all.find((g) => g.reservedKey === 'sales-accounts');
    expect((await gw.execute({ companyId, command: { op: 'create', kind: 'ledger', id: newId('ledger:sales'), data: { name: 'Sales', groupId: salesGroup?.id } } })).ok).toBe(true);

    // the step this import needs first: 2025-26, which brings its own Sales series
    const added = await gw.execute({ companyId, command: { op: 'create', kind: 'financialYear', id: newId('fy:2025-26'), data: { start: '2025-04-01' } } });
    expect(added.ok).toBe(true);

    const invoice: ZohoInvoice = {
      invoiceNumber: '25-26/001',
      rows: [line(), line({ itemName: '52402-R1 - Contact Ring', quantity: '1.00', cgstRate: '2.50', sgstRate: '2.50', hsn: '84879000' })],
    };
    const ctx = { companyId, gw, same: new Map<string, string>(), log: () => {} };
    const plan = planOf([invoice], await gw.load(companyId));
    expect(plan.problems).toEqual([]);
    const after = await createMasters(ctx, plan);
    await postStock(ctx, plan, after);
    const posted = await postInvoices(ctx, plan, after);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ zoho: '25-26/001', date: '2025-06-10', total: '341.00' });
    expect(posted[0]?.number).toMatch(/25-26\/0*1$/);
  });

  it('posts a Zoho number missing from the export (deleted or voided in Zoho) as a CANCELLED invoice, so every number is kept', async () => {
    let masters = seedCompany({ name: 'Works', fyStart: localDate('2025-04-01'), newId, gstin: gstin('27AABCD1234E1Z'), stateCode: '27' });
    masters = masters.with({ company: { ...masters.company, chargeGst: true } });
    const companyId = masters.company.id as CompanyId;
    const gw = new MemoryBackend(masters);
    const salesGroup = masters.groups.all.find((g) => g.reservedKey === 'sales-accounts');
    expect((await gw.execute({ companyId, command: { op: 'create', kind: 'ledger', id: newId('ledger:sales'), data: { name: 'Sales', groupId: salesGroup?.id } } })).ok).toBe(true);

    const one = (n: string, date: string): ZohoInvoice => ({ invoiceNumber: n, rows: [line({ invoiceId: n, invoiceNumber: n, invoiceDate: date, subtotal: '200.00', total: '236.00' })] });
    const invoices = [one('25-26/001', '2025-06-10'), one('25-26/004', '2025-06-20')];
    const ctx = { companyId, gw, same: new Map<string, string>(), log: () => {} };
    const plan = planOf(invoices, await gw.load(companyId));
    expect(plan.problems).toEqual([]);
    expect(plan.gaps).toEqual([2, 3]);
    const after = await createMasters(ctx, plan);
    await postStock(ctx, plan, after);
    const posted = await postInvoices(ctx, plan, after);

    expect(posted.map((p) => [p.zoho, p.cancelled === true])).toEqual([
      ['25-26/001', false],
      ['25-26/002', true],
      ['25-26/003', true],
      ['25-26/004', false],
    ]);
    const sales = (await gw.list(companyId)).filter((v) => v.content.voucherTypeId === after.voucherTypes.find((t) => t.baseKind === 'sales')?.id);
    expect(sales.map((v) => [v.number.slice(-1), v.status])).toEqual([['1', 'posted'], ['2', 'cancelled'], ['3', 'cancelled'], ['4', 'posted']]);
    // the placeholders are dated like the invoice before them and count for nothing: the books hold the two real invoices only
    expect(posted[1]?.date).toBe('2025-06-10');
    const lines = await gw.lines({ companyId });
    const cancelledIds = new Set(sales.filter((v) => v.status === 'cancelled').map((v) => v.id));
    expect(lines.some((l) => cancelledIds.has(l.voucherId))).toBe(false);

    // a re-run changes nothing
    const again = await postInvoices(ctx, plan, after);
    expect(again.filter((p) => p.skipped)).toHaveLength(2);
    expect((await gw.list(companyId)).filter((v) => cancelledIds.has(v.id) && v.status === 'cancelled')).toHaveLength(2);
  });
});
