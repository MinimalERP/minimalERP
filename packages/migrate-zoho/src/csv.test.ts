import { csvOf } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { groupByInvoice, invoiceFilterOf, parseZohoCsv } from './csv';

const headerCols = [
  'Invoice Date',
  'Invoice ID',
  'Invoice Number',
  'Invoice Status',
  'Customer ID',
  'Customer Name',
  'GST Identification Number (GSTIN)',
  'Place of Supply(With State Code)',
  'Billing Attention',
  'Billing Address',
  'Billing City',
  'Billing State',
  'Billing Code',
  'Primary Contact EmailID',
  'Payment Terms',
  'Due Date',
  'PurchaseOrder',
  'SubTotal',
  'Total',
  'Round Off',
  'Item Name',
  'Item Desc',
  'Quantity',
  'Usage unit',
  'Item Price',
  'HSN/SAC',
  'CGST Rate %',
  'SGST Rate %',
  'IGST Rate %',
];
const header = csvOf([headerCols]);

// properly CSV-escaped (via csvOf), unlike a naive join — real exports quote fields with embedded commas/quotes
const row = (fields: Record<string, string>): string => csvOf([headerCols.map((h) => fields[h] ?? '')]);

const sampleCsv = [
  header,
  row({
    'Invoice Date': '2026-04-03',
    'Invoice ID': '1001',
    'Invoice Number': '26-27/001',
    'Invoice Status': 'Closed',
    'Customer Name': 'Acme Ltd',
    'GST Identification Number (GSTIN)': '27AAACE9659G1ZB',
    SubTotal: '2160.00',
    Total: '2549.00',
    'Item Name': 'KS35449073- ORIF,BR 125/140,DIA 18MM',
    Quantity: '12.00',
    'Usage unit': 'Nos',
    'Item Price': '180.00',
    'HSN/SAC': '84879000',
    'CGST Rate %': '9.00',
    'SGST Rate %': '9.00',
  }),
  row({
    'Invoice Date': '2026-04-03',
    'Invoice ID': '1001',
    'Invoice Number': '26-27/001',
    'Invoice Status': 'Closed',
    'Customer Name': 'Acme Ltd',
    'GST Identification Number (GSTIN)': '27AAACE9659G1ZB',
    SubTotal: '2160.00',
    Total: '2549.00',
    'Item Name': 'MX40705 - 1/4-20X1.25" SOC SET SCR',
    Quantity: '250.00',
    'Usage unit': 'Nos',
    'Item Price': '22.50',
    'HSN/SAC': '73181500',
    'IGST Rate %': '18.00',
  }),
  row({
    'Invoice Date': '2026-04-05',
    'Invoice ID': '1002',
    'Invoice Number': '26-27/002',
    'Invoice Status': 'Open',
    'Customer Name': 'Beta Ltd',
    SubTotal: '500.00',
    Total: '500.00',
    'Item Name': 'Freight',
    Quantity: '1',
    'Item Price': '500.00',
  }),
].join('\n');

describe('parseZohoCsv + groupByInvoice', () => {
  it('groups rows by Invoice Number, keeping the file order of both invoices and their lines', () => {
    const invoices = groupByInvoice(parseZohoCsv(sampleCsv));
    expect(invoices.map((i) => i.invoiceNumber)).toEqual(['26-27/001', '26-27/002']);
    expect(invoices[0]?.rows).toHaveLength(2);
    expect(invoices[0]?.rows.map((r) => r.itemName)).toEqual(['KS35449073- ORIF,BR 125/140,DIA 18MM', 'MX40705 - 1/4-20X1.25" SOC SET SCR']);
    expect(invoices[1]?.rows).toHaveLength(1);
  });

  it('reads GSTIN, totals and per-line GST rate columns', () => {
    const invoices = groupByInvoice(parseZohoCsv(sampleCsv));
    const first = invoices[0]?.rows[0];
    expect(first?.gstin).toBe('27AAACE9659G1ZB');
    expect(first?.subtotal).toBe('2160.00');
    expect(first?.total).toBe('2549.00');
    expect(first?.cgstRate).toBe('9.00');
    expect(first?.sgstRate).toBe('9.00');
  });
});

describe('invoiceFilterOf', () => {
  it('undefined means everything', () => {
    expect(invoiceFilterOf(undefined)).toBeUndefined();
  });
  it('a range compares the numeric part after the last slash', () => {
    const f = invoiceFilterOf('26-27/001..26-27/090');
    expect(f?.('26-27/001')).toBe(true);
    expect(f?.('26-27/090')).toBe(true);
    expect(f?.('26-27/045')).toBe(true);
    expect(f?.('26-27/091')).toBe(false);
  });
  it('a comma list matches exact invoice numbers only', () => {
    const f = invoiceFilterOf('26-27/001, 26-27/003');
    expect(f?.('26-27/001')).toBe(true);
    expect(f?.('26-27/002')).toBe(false);
    expect(f?.('26-27/003')).toBe(true);
  });
});
