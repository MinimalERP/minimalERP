import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type CompanyId, customerLedgerOf, deterministicUuid, gstinCheckChar, localDate, openBills, seedCompany } from '@minimalerp/domain';
import type { ZohoInvoice, ZohoLine } from './csv';
import { createMasters, planOf, postInvoices, postStock } from './post';
import { type ZohoPaymentRow, createCustomers, groupPayments, planReceipts, postReceipts } from './receipts';

const newId = (name: string) => deterministicUuid(`zoho-receipts-test|${name}`);
const gstin = (prefix: string) => prefix + gstinCheckChar(prefix);
const customerGstin = gstin('27AAACE9659G1Z');

const line = (n: string): ZohoLine => ({
  invoiceId: n, invoiceNumber: n, invoiceDate: '2025-06-10', invoiceStatus: 'Closed', customerId: '9001', customerName: 'Acme Ltd', gstin: customerGstin,
  placeOfSupply: '27-Maharashtra', billingAttention: '', billingAddress: 'Plot 2', billingCity: 'Pune', billingState: 'Maharashtra', billingCode: '412216',
  primaryEmail: '', paymentTermsDays: '30', dueDate: '2025-07-10', purchaseOrder: '', subtotal: '1000.00', total: '1180.00', roundOff: '0.00',
  itemName: '14188-4 - PLT,ORIF', itemDesc: '', quantity: '10.00', usageUnit: 'Nos', itemPrice: '100.00', hsn: '84879000', cgstRate: '9.00', sgstRate: '9.00', igstRate: '0.00',
});

const pay = (over: Partial<ZohoPaymentRow>): ZohoPaymentRow => ({
  paymentId: 'P1', paymentNumber: '25-26/1', date: '2025-07-15', type: 'Invoice Payment', customerName: 'Acme Ltd', gstin: '', amount: '0', unused: '0.000',
  bankCharges: '0.000', reference: '', description: '', depositTo: 'Yes BAnk', invoiceNumber: '', applied: '0', tds: '0.000', ...over,
});

async function booksWithInvoices() {
  let masters = seedCompany({ name: 'Works', fyStart: localDate('2025-04-01'), newId, gstin: gstin('27AABCD1234E1Z'), stateCode: '27' });
  masters = masters.with({ company: { ...masters.company, chargeGst: true } });
  const companyId = masters.company.id as CompanyId;
  const gw = new MemoryBackend(masters);
  const group = (k: string) => masters.groups.all.find((g) => g.reservedKey === k)?.id;
  await gw.execute({ companyId, command: { op: 'create', kind: 'ledger', id: newId('sales'), data: { name: 'Sales', groupId: group('sales-accounts') } } });
  await gw.execute({ companyId, command: { op: 'create', kind: 'ledger', id: newId('bank'), data: { name: 'Yes Bank', groupId: group('bank-accounts') } } });
  const invoices: ZohoInvoice[] = ['25-26/001', '25-26/002'].map((n) => ({ invoiceNumber: n, rows: [line(n)] }));
  const ctx = { companyId, gw, same: new Map<string, string>(), log: () => {} };
  const plan = planOf(invoices, await gw.load(companyId));
  const after = await createMasters(ctx, plan);
  await postStock(ctx, plan, after);
  const posted = await postInvoices(ctx, plan, after);
  return { gw, companyId, numbers: posted.map((p) => p.number) };
}

describe('Zoho payments as Receipts', () => {
  it('settles each invoice for what Zoho applied plus the TDS withheld, puts the unused part on account, and a re-run adds nothing', async () => {
    const { gw, companyId, numbers } = await booksWithInvoices();
    const [first, second] = numbers as [string, string];
    // the bank got 1170 + 500 + 30 unused = 1700; 10 of TDS was withheld on the first invoice, which is settled in full (1180)
    const payments = groupPayments([
      pay({ amount: '1700.000', unused: '30.000', invoiceNumber: '25-26/1', applied: '1170.00', tds: '10.000' }),
      pay({ amount: '1700.000', unused: '30.000', invoiceNumber: '25-26/2', applied: '500.00', tds: '0.000' }),
    ]);
    const ctx = { companyId, gw, bank: 'Yes Bank', log: () => {} };
    const run = async () => {
      const plan = planReceipts(payments, await gw.load(companyId), await gw.list(companyId));
      expect(plan.problems).toEqual([]);
      return postReceipts(ctx, plan, await createCustomers(ctx, plan));
    };
    expect((await run()).filter((p) => !p.skipped)).toHaveLength(1);

    const masters = await gw.load(companyId);
    const party = masters.parties.find((p) => p.name === 'Acme Ltd');
    const open = openBills(await gw.list(companyId), masters, customerLedgerOf(party!.id));
    expect(open.map((b) => [b.ref, String(b.pending)])).toEqual([[second, '68000']]); // 1180 − 500 still open on the second
    expect(open.some((b) => b.ref === first)).toBe(false);

    expect((await run()).filter((p) => !p.skipped)).toEqual([]);
  });

  it('stops on an invoice that is not in the books, and on settling more than is open', async () => {
    const { gw, companyId } = await booksWithInvoices();
    const plan = planReceipts(
      groupPayments([
        pay({ paymentId: 'A', amount: '100.000', invoiceNumber: '24-25/7', applied: '100.00' }),
        pay({ paymentId: 'B', amount: '5000.000', invoiceNumber: '25-26/001', applied: '5000.00' }),
      ]),
      await gw.load(companyId),
      await gw.list(companyId),
    );
    expect(plan.problems).toEqual([
      expect.stringContaining('invoice 24-25/7 is not in the books'),
      expect.stringContaining('settles nothing'),
      expect.stringContaining('only 1180.00 is open on it'),
    ]);
  });

  it('takes the customer from the invoices it settles, whatever name Zoho gives the payment: no second customer is made', async () => {
    const { gw, companyId } = await booksWithInvoices();
    const payments = groupPayments([pay({ customerName: 'ACME LIMITED', amount: '1180.000', invoiceNumber: '25-26/1', applied: '1180.00' })]);
    const plan = planReceipts(payments, await gw.load(companyId), await gw.list(companyId));
    expect(plan.newCustomers).toEqual([]);
    const ctx = { companyId, gw, bank: 'Yes Bank', log: () => {} };
    const posted = await postReceipts(ctx, plan, await createCustomers(ctx, plan));
    expect(posted[0]?.customer).toBe('Acme Ltd');
    expect((await gw.load(companyId)).parties).toHaveLength(1);
  });

  it('creates a customer the books do not have, for an advance', async () => {
    const { gw, companyId } = await booksWithInvoices();
    const payments = groupPayments([pay({ paymentId: 'S', customerName: 'Sunrise Export', type: 'Customer Advance', amount: '350000.000', unused: '350000.000' })]);
    const plan = planReceipts(payments, await gw.load(companyId), await gw.list(companyId));
    expect(plan.newCustomers.map((c) => c.customerName)).toEqual(['Sunrise Export']);
    expect(plan.receipts[0]?.allocations).toEqual([{ kind: 'advance', amount: 35000000n }]);
    const ctx = { companyId, gw, bank: 'Yes Bank', log: () => {} };
    const posted = await postReceipts(ctx, plan, await createCustomers(ctx, plan));
    expect(posted[0]?.customer).toBe('Sunrise Export');
  });
});
