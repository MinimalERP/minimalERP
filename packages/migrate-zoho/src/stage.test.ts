import { describe, expect, it } from 'vitest';
import { buildExtraction } from './stage';
import type { ZohoInvoice, ZohoLine } from './csv';

const line = (over: Partial<ZohoLine> = {}): ZohoLine => ({
  invoiceId: '1001',
  invoiceNumber: '26-27/001',
  invoiceDate: '2026-04-03',
  invoiceStatus: 'Closed',
  customerId: '9001',
  customerName: 'Acme Ltd',
  gstin: '27AAACE9659G1ZB',
  placeOfSupply: '27-Maharashtra',
  billingAttention: '',
  billingAddress: 'Plot 2',
  billingCity: 'Pune',
  billingState: 'Maharashtra',
  billingCode: '412216',
  primaryEmail: '',
  paymentTermsDays: '45',
  dueDate: '2026-05-18',
  purchaseOrder: 'PO-778',
  subtotal: '2160.00',
  total: '2549.00',
  roundOff: '0.00',
  itemName: 'KS35449073- ORIF,BR 125/140,DIA 18MM',
  itemDesc: '',
  quantity: '12.00',
  usageUnit: 'Nos',
  itemPrice: '180.00',
  hsn: '84879000',
  cgstRate: '9.00',
  sgstRate: '9.00',
  igstRate: '0.00',
  ...over,
});

describe('buildExtraction', () => {
  it('maps the invoice header, joining the billing address into one line', () => {
    const invoice: ZohoInvoice = { invoiceNumber: '26-27/001', rows: [line()] };
    const x = buildExtraction(invoice);
    expect(x.partyName).toBe('Acme Ltd');
    expect(x.partyGstin).toBe('27AAACE9659G1ZB');
    expect(x.partyAddress).toBe('Plot 2, Pune, Maharashtra, 412216');
    expect(x.date).toBe('2026-04-03');
    expect(x.dueDate).toBe('2026-05-18');
    expect(x.poNumber).toBe('PO-778');
    expect(x.subtotal).toBe('2160.00');
    expect(x.grandTotal).toBe('2549.00');
  });

  it('combines CGST+SGST into one line GST rate; an IGST-only line uses that instead', () => {
    const invoice: ZohoInvoice = {
      invoiceNumber: '26-27/001',
      rows: [line({ cgstRate: '9.00', sgstRate: '9.00', igstRate: '0.00' }), line({ cgstRate: '0.00', sgstRate: '0.00', igstRate: '18.00' })],
    };
    const x = buildExtraction(invoice);
    expect(x.lines[0]?.gstRate).toBe('18');
    expect(x.lines[1]?.gstRate).toBe('18');
  });

  it('an untaxed line (all three rates zero) has no gstRate', () => {
    const invoice: ZohoInvoice = { invoiceNumber: '26-27/002', rows: [line({ cgstRate: '0', sgstRate: '0', igstRate: '0' })] };
    expect(buildExtraction(invoice).lines[0]?.gstRate).toBeUndefined();
  });

  it('splits the "<code> - <description>" item-name convention into its own code and description', () => {
    const invoice: ZohoInvoice = { invoiceNumber: '26-27/001', rows: [line({ itemName: 'KS35449073- ORIF,BR 125/140,DIA 18MM', itemDesc: '' })] };
    const l = buildExtraction(invoice).lines[0];
    expect(l?.code).toBe('KS35449073');
    expect(l?.description).toBe('ORIF,BR 125/140,DIA 18MM');
    expect(l?.qty).toBe('12.00');
    expect(l?.rate).toBe('180.00');
    expect(l?.unit).toBe('Nos');
    expect(l?.hsn).toBe('84879000');
  });

  it('a name with no dash (a one-time charge, say) has no code, just its own text as the description', () => {
    const invoice: ZohoInvoice = { invoiceNumber: '26-27/002', rows: [line({ itemName: 'Freight', itemDesc: '' })] };
    const l = buildExtraction(invoice).lines[0];
    expect(l?.code).toBeUndefined();
    expect(l?.description).toBe('Freight');
  });

  it('a non-empty Item Desc wins over the name’s own parsed description, but the code still comes from the name', () => {
    const invoice: ZohoInvoice = { invoiceNumber: '26-27/001', rows: [line({ itemName: 'KS35449073- ORIF,BR 125/140,DIA 18MM', itemDesc: 'Custom description' })] };
    const l = buildExtraction(invoice).lines[0];
    expect(l?.code).toBe('KS35449073');
    expect(l?.description).toBe('Custom description');
  });
});
