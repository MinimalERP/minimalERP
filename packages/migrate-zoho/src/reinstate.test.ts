import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type CompanyId, deterministicUuid, gstinCheckChar, localDate, seedCompany } from '@minimalerp/domain';
import type { ZohoInvoice, ZohoLine } from './csv';
import { createMasters, planOf, postInvoices, postStock } from './post';
import { reinstate } from './reinstate';

const newId = (name: string) => deterministicUuid(`reinstate-test|${name}`);
const gstin = (prefix: string) => prefix + gstinCheckChar(prefix);
const line = (n: string): ZohoLine => ({
  invoiceId: n, invoiceNumber: n, invoiceDate: '2025-06-10', invoiceStatus: 'Closed', customerId: '9001', customerName: 'Acme Ltd', gstin: gstin('27AAACE9659G1Z'),
  placeOfSupply: '27-Maharashtra', billingAttention: '', billingAddress: 'Plot 2', billingCity: 'Pune', billingState: 'Maharashtra', billingCode: '412216',
  primaryEmail: '', paymentTermsDays: '30', dueDate: '2025-07-10', purchaseOrder: 'PO-9', subtotal: '1000.00', total: '1180.00', roundOff: '0.00',
  itemName: '14188-4 - PLT,ORIF', itemDesc: '', quantity: '10.00', usageUnit: 'Nos', itemPrice: '100.00', hsn: '84879000', cgstRate: '9.00', sgstRate: '9.00', igstRate: '0.00',
});

describe('re-entering an invoice cancelled by mistake', () => {
  it('posts it again exactly as it was, with the same number, under "Sales (Zoho number)"; a second run does nothing', async () => {
    let masters = seedCompany({ name: 'Works', fyStart: localDate('2025-04-01'), newId, gstin: gstin('27AABCD1234E1Z'), stateCode: '27' });
    masters = masters.with({ company: { ...masters.company, chargeGst: true } });
    const companyId = masters.company.id as CompanyId;
    const gw = new MemoryBackend(masters);
    const salesGroup = masters.groups.all.find((g) => g.reservedKey === 'sales-accounts');
    await gw.execute({ companyId, command: { op: 'create', kind: 'ledger', id: newId('sales'), data: { name: 'Sales', groupId: salesGroup?.id } } });
    const ctx = { companyId, gw, same: new Map<string, string>(), log: () => {} };
    const invoices: ZohoInvoice[] = ['25-26/1', '25-26/2'].map((n) => ({ invoiceNumber: n, rows: [line(n)] }));
    const plan = planOf(invoices, await gw.load(companyId));
    const after = await createMasters(ctx, plan);
    await postStock(ctx, plan, after);
    await postInvoices(ctx, plan, after);

    const second = (await gw.list(companyId)).find((v) => v.number.endsWith('0002'))!;
    expect((await gw.cancel({ companyId, voucherId: second.id, expectedVersion: second.version })).ok).toBe(true);

    expect(await reinstate(gw, companyId, '25-26/2', false, () => {})).toBeUndefined(); // dry run writes nothing
    const again = await reinstate(gw, companyId, 'SAL/25-26/0002', true, () => {});
    expect(again?.number).toBe('SAL/25-26/0002');
    expect(again?.status).toBe('posted');
    const m = await gw.load(companyId);
    expect(m.voucherType(again!.voucherTypeId)?.name).toBe('Sales (Zoho number)');
    const content = again!.content as unknown as { partyId: string; reference: string; lines: unknown[] };
    const old = second.content as unknown as { partyId: string; reference: string; lines: unknown[] };
    expect([content.partyId, content.reference, content.lines]).toEqual([old.partyId, old.reference, old.lines]);
    expect((await gw.lines({ companyId })).some((l) => l.voucherId === again!.id)).toBe(true);

    expect((await reinstate(gw, companyId, 'SAL/25-26/0002', true, () => {}))?.id).toBe(again!.id);
    expect((await gw.list(companyId)).filter((v) => v.number === 'SAL/25-26/0002')).toHaveLength(2); // the cancelled one stays, beside the live one
  });
});
