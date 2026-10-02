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
});
