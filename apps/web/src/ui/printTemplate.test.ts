import { parseTemplate, renderTemplate } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import type { InvoiceDoc, LedgerDoc } from './PrintView';
import { BUILT_IN_LAYOUTS, layoutData, layoutFor } from './printTemplate';

const invoice: InvoiceDoc = {
  kind: 'invoice',
  voucherKind: 'purchaseOrder',
  docTitle: 'Purchase Order',
  number: 'PO/7',
  date: '2024-06-01',
  poNo: 'Q-12',
  party: { name: 'Tools Division', gstin: '27AAACT5678D1Z5', billTo: { lines: 'Plot 4, MIDC', stateCode: '27' } },
  lines: [{ desc: 'Hex Bolt <M8>', hsn: '7318', qty: '500 Nos', rate: '4.25', amount: 212500n }],
  subtotal: 212500n,
  grandTotal: 212500n,
};
const payment: LedgerDoc = {
  kind: 'ledger',
  voucherKind: 'payment',
  docTitle: 'Payment',
  number: 'PAY/3',
  date: '2024-06-25',
  lines: [
    { ledger: 'HDFC Bank', side: 'credit', amount: 300000n },
    { ledger: 'Tools Division', side: 'debit', amount: 300000n },
  ],
};
const company = { name: 'Micro Components', gstin: '27AAACM1234C1Z5', invoiceTerms: 'Payment in 30 days\nGoods once sold…' };

describe('which layout a document prints with', () => {
  it('its kind’s own first, else its shape’s, else none (the built-in one)', () => {
    const layouts = { templates: { invoice: 'ALL', 'invoice.purchaseOrder': 'PO', ledger: '  ' }, images: {} };
    expect(layoutFor(layouts, invoice)).toBe('PO');
    expect(layoutFor(layouts, { ...invoice, voucherKind: 'sales' })).toBe('ALL');
    expect(layoutFor(layouts, payment)).toBeUndefined(); // blank = not set
    expect(layoutFor({ templates: {}, images: {} }, invoice)).toBeUndefined();
    expect(layoutFor(undefined, invoice)).toBeUndefined();
  });
});

describe('what a layout’s placeholders read', () => {
  it('the invoice’s figures as the built-in layout prints them', () => {
    const d = layoutData(invoice, company, 'Duplicate', { logo: 'data:image/png;base64,AA==' });
    expect(d).toMatchObject({
      copyLabel: 'Duplicate',
      title: 'Purchase Order',
      number: 'PO/7',
      date: '1-Jun-2024',
      poNo: 'Q-12',
      grandTotal: '2,125.00',
      amountInWords: 'Rupees Two Thousand One Hundred Twenty Five Only',
      hasTerms: true,
      images: { logo: 'data:image/png;base64,AA==' },
      party: { name: 'Tools Division', billTo: { name: 'Tools Division', lines: [{ text: 'Plot 4, MIDC' }, { text: '27' }] } },
      lines: [{ sno: 1, desc: 'Hex Bolt <M8>', qty: '500 Nos', rate: '4.25', amount: '2,125.00' }],
    });
    // the ship-to is the bill-to when none was given
    expect((d['party'] as { shipTo: unknown }).shipTo).toEqual((d['party'] as { billTo: unknown }).billTo);
  });

  it('a payment’s lines Dr / Cr, and its total', () => {
    const d = layoutData(payment, company, 'Original', {});
    expect(d).toMatchObject({ total: '3,000.00', lines: [{ sno: 1, ledger: 'HDFC Bank', side: 'Cr' }, { sno: 2, ledger: 'Tools Division', side: 'Dr' }] });
  });
});

describe('the built-in layouts, written as layouts', () => {
  it('read cleanly, and fill with the document, its values escaped', () => {
    for (const t of Object.values(BUILT_IN_LAYOUTS)) expect(parseTemplate(t).ok).toBe(true);
    const r = renderTemplate(BUILT_IN_LAYOUTS.invoice, layoutData(invoice, company, 'Original', {}));
    expect(r.ok && r.html).toContain('Hex Bolt &lt;M8&gt;');
    expect(r.ok && r.html).toContain('<li>Payment in 30 days</li>');
    expect(r.ok && r.html.match(/<ol>/g)).toHaveLength(1); // the terms are listed once, not once per term
    const p = renderTemplate(BUILT_IN_LAYOUTS.ledger, layoutData(payment, company, 'Original', {}));
    expect(p.ok && p.html).toContain('₹ 3,000.00');
  });
});
