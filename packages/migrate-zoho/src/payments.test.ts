import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type CompanyId, customerLedgerOf, deterministicUuid, gstinCheckChar, localDate, openBills, seedCompany } from '@minimalerp/domain';
import { type ZohoInvoice, type ZohoLine, type ZohoPaymentRow, groupByPayment, parseZohoPaymentsCsv } from './csv';
import { planPayments, postReceipts } from './payments';
import { createMasters, planOf, postInvoices, postStock } from './post';

const newId = (name: string) => deterministicUuid(`zoho-pay-test|${name}`);
const gstin = (prefix: string) => prefix + gstinCheckChar(prefix);
const acme = gstin('27AAACE9659G1Z');

const line = (n: string, date: string): ZohoLine => ({
  invoiceId: n, invoiceNumber: n, invoiceDate: date, invoiceStatus: 'Closed', customerId: '9001', customerName: 'Acme Ltd', gstin: acme,
  placeOfSupply: '27-Maharashtra', billingAttention: '', billingAddress: 'Plot 2', billingCity: 'Pune', billingState: 'Maharashtra',
  billingCode: '412216', primaryEmail: '', paymentTermsDays: '30', dueDate: '', purchaseOrder: '', subtotal: '200.00', total: '236.00',
  roundOff: '0.00', itemName: '14188-4 - PLT,ORIF', itemDesc: '', quantity: '2.00', usageUnit: 'Nos', itemPrice: '100.00', hsn: '84879000',
  cgstRate: '9.00', sgstRate: '9.00', igstRate: '0.00',
});

const pay = (over: Partial<ZohoPaymentRow>): ZohoPaymentRow => ({
  paymentId: 'P1', paymentNumber: '25-26/1', date: '2025-07-01', customerName: 'ACME LTD', gstin: '', amount: '0', unusedAmount: '0.00',
  bankCharges: '0.00', mode: 'Bank Transfer', reference: '', description: '', depositTo: 'Yes BAnk', invoicePaymentId: '', invoiceNumber: '',
  appliedAmount: '', tds: '', ...over,
});

/** A 2025-26 company with two Zoho invoices of ₹236 posted (25-26/001 and 25-26/002), and a "Yes Bank" ledger. */
async function books() {
  let masters = seedCompany({ name: 'Works', fyStart: localDate('2025-04-01'), newId, gstin: gstin('27AABCD1234E1Z'), stateCode: '27' });
  masters = masters.with({ company: { ...masters.company, chargeGst: true } });
  const companyId = masters.company.id as CompanyId;
  const gw = new MemoryBackend(masters);
  const group = (key: string) => masters.groups.all.find((g) => g.reservedKey === key)?.id;
  expect((await gw.execute({ companyId, command: { op: 'create', kind: 'ledger', id: newId('sales'), data: { name: 'Sales', groupId: group('sales-accounts') } } })).ok).toBe(true);
  expect((await gw.execute({ companyId, command: { op: 'create', kind: 'ledger', id: newId('bank'), data: { name: 'Yes Bank', groupId: group('bank-accounts') } } })).ok).toBe(true);
  const invoices: ZohoInvoice[] = ['25-26/001', '25-26/002'].map((n, i) => ({ invoiceNumber: n, rows: [line(n, `2025-06-1${i}`)] }));
  const ctx = { companyId, gw, same: new Map<string, string>(), log: () => {} };
  const plan = planOf(invoices, await gw.load(companyId));
  const after = await createMasters(ctx, plan);
  await postStock(ctx, plan, after);
  await postInvoices(ctx, plan, after);
  return { companyId, gw };
}

describe('Zoho customer payments', () => {
  it('reads the export: one payment per payment ID, a row repeated in two files read once', () => {
    const header = 'Payment Number,CustomerPayment ID,Customer Name,Amount,Unused Amount,Date,Deposit To,InvoicePayment ID,Amount Applied to Invoice,Withholding Tax Amount,Invoice Number';
    const csv = `${header}\n25-26/1,P1,Acme Ltd,400.00,0.00,2025-07-01,Yes BAnk,IP1,200.00,20.00,25-26/001\n25-26/1,P1,Acme Ltd,400.00,0.00,2025-07-01,Yes BAnk,IP2,200.00,,25-26/002\n`;
    const rows = parseZohoPaymentsCsv(csv);
    expect(rows[0]).toMatchObject({ paymentNumber: '25-26/1', amount: '400.00', appliedAmount: '200.00', tds: '20.00', invoiceNumber: '25-26/001', depositTo: 'Yes BAnk' });
    const payments = groupByPayment([...rows, ...rows]);
    expect(payments).toHaveLength(1);
    expect(payments[0]?.rows).toHaveLength(2);
  });

  it('posts each payment as a Receipt set against the invoices it paid, TDS settling the bill too, and money left over on account', async () => {
    const { companyId, gw } = await books();
    const payments = groupByPayment([
      // ₹216 to the bank for invoice 1, with ₹20 TDS deducted: the bill is settled in full
      pay({ paymentId: 'P1', paymentNumber: '25-26/1', amount: '216.00', invoicePaymentId: 'IP1', invoiceNumber: '25-26/1', appliedAmount: '216.00', tds: '20.00' }),
      // ₹300 for invoice 2 (written unpadded, as Zoho sometimes does): ₹100 of it unapplied, an advance
      pay({ paymentId: 'P2', paymentNumber: '25-26/2', date: '2025-07-05', amount: '300.00', unusedAmount: '100.00', invoicePaymentId: 'IP2', invoiceNumber: '25-26/002', appliedAmount: '200.00' }),
    ]);
    const masters = await gw.load(companyId);
    const plan = planPayments(payments, masters, await gw.list(companyId));
    expect(plan.problems).toEqual([]);
    const posted = await postReceipts(companyId, gw, plan, masters);
    expect(posted.map((p) => [p.zoho, p.received, p.against, p.onAccount])).toEqual([
      ['25-26/1', '216.00', ['SAL/25-26/0001'], '0.00'],
      ['25-26/2', '300.00', ['SAL/25-26/0002'], '100.00'],
    ]);

    // invoice 1 is settled; invoice 2 has ₹36 still to come
    const open = openBills(await gw.list(companyId), masters, customerLedgerOf(plan.receipts[0]!.party.id));
    expect(open.map((b) => [b.ref, String(b.pending)])).toEqual([['SAL/25-26/0002', '3600']]);
    // the bank got what was paid, TDS Receivable the ₹20
    const lines = await gw.lines({ companyId });
    const bank = masters.ledgers.find((l) => l.name === 'Yes Bank')!;
    expect(lines.filter((l) => l.ledgerId === bank.id).reduce((s, l) => s + BigInt(l.amount), 0n)).toBe(51600n);
    expect(lines.some((l) => l.ledgerId === masters.systemLedger('tds-receivable')?.id && BigInt(l.amount) === 2000n)).toBe(true);

    // a re-run posts nothing again
    const again = planPayments(payments, masters, await gw.list(companyId));
    expect(again.skipped).toEqual(['25-26/1', '25-26/2']);
    expect(await postReceipts(companyId, gw, again, masters)).toEqual([]);
  });

  it('stops on a payment for an invoice that is not an open bill, one settling more than is pending, or an unknown bank', async () => {
    const { companyId, gw } = await books();
    const payments = groupByPayment([
      pay({ paymentId: 'P1', paymentNumber: '25-26/1', amount: '236.00', invoiceNumber: '25-26/009', appliedAmount: '236.00' }),
      pay({ paymentId: 'P2', paymentNumber: '25-26/2', amount: '300.00', invoiceNumber: '25-26/001', appliedAmount: '300.00' }),
      pay({ paymentId: 'P3', paymentNumber: '25-26/3', amount: '236.00', invoiceNumber: '25-26/002', appliedAmount: '236.00', depositTo: 'Petty Cash' }),
      pay({ paymentId: 'P4', paymentNumber: '25-26/4', amount: '236.00', invoiceNumber: '25-26/002', appliedAmount: '200.00' }),
    ]);
    const plan = planPayments(payments, await gw.load(companyId), await gw.list(companyId));
    expect(plan.receipts).toEqual([]);
    expect(plan.problems).toHaveLength(4);
    expect(plan.problems[0]).toMatch(/25-26\/009 is not an open bill/);
    expect(plan.problems[1]).toMatch(/only 236\.00 pending/);
    expect(plan.problems[2]).toMatch(/"Petty Cash", which is no cash or bank ledger/);
    expect(plan.problems[3]).toMatch(/does not come to the 236\.00 paid/);

    // --deposit maps a Zoho account onto a ledger with another name
    const mapped = planPayments(groupByPayment([payments[2]!.rows[0]!]), await gw.load(companyId), await gw.list(companyId), new Map([['petty cash', 'Cash']]));
    expect(mapped.problems).toEqual([]);
    expect(mapped.receipts[0]?.bank.name).toBe('Cash');
  });
});
