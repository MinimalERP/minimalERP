import { type TemplateData, renderTemplate } from '@minimalerp/domain';
import type { PrintLayouts } from '@minimalerp/ports';
import { formatAmount, formatDate } from '../vouchers/format';
import type { InvoiceDoc, LedgerDoc, PrintAddress, PrintCompany, PrintDoc } from './printDocs';
import { amountInWords } from './words';

/**
 * A company's own print layouts (ADR-0025, step 4): which one a document prints with, the data its placeholders read, and the cleaning
 * the filled HTML gets before it is shown. The figures are the ones the screen already computed (the `PrintDoc`), formatted as the
 * built-in layout prints them; a layout only arranges them.
 */

/** The documents a company may lay out itself, and the voucher kinds each can be narrowed to. */
export const LAYOUT_SHAPES = {
  invoice: { name: 'Invoices and orders', kinds: { sales: 'Sales Invoice', salesOrder: 'Sales Order', quotation: 'Quotation', purchase: 'Purchase Invoice', purchaseOrder: 'Purchase Order' } },
  ledger: { name: 'Payment, Receipt, Contra, Journal', kinds: { payment: 'Payment', receipt: 'Receipt', contra: 'Contra', journal: 'Journal' } },
} as const;
export type LayoutShape = keyof typeof LAYOUT_SHAPES;

/** The layout a document prints with: its kind's own, else its shape's, else none (the built-in layout). */
export function layoutFor(layouts: PrintLayouts | undefined, doc: PrintDoc): string | undefined {
  if (!layouts || (doc.kind !== 'invoice' && doc.kind !== 'ledger')) return undefined;
  const own = doc.voucherKind ? layouts.templates[`${doc.kind}.${doc.voucherKind}`] : undefined;
  const t = own ?? layouts.templates[doc.kind];
  return t && t.trim() !== '' ? t : undefined;
}

const addressLines = (a: PrintAddress | undefined): string[] =>
  a ? [a.lines, [a.stateCode, a.pincode].filter(Boolean).join(' – '), a.country].filter((s): s is string => !!s && s.trim() !== '') : [];

/** What a layout's placeholders read, for one document and one copy. */
export function layoutData(doc: InvoiceDoc | LedgerDoc, company: PrintCompany, copyLabel: string | undefined, images: Readonly<Record<string, string>>): TemplateData {
  const terms = company.invoiceTerms?.split('\n').filter((t) => t.trim() !== '') ?? [];
  const common = {
    company: { ...company, terms: terms.map((text) => ({ text })) },
    images: { logo: images['logo'], signature: images['signature'] },
    hasTerms: terms.length > 0,
    copyLabel,
    title: doc.docTitle,
    number: doc.number,
    date: formatDate(doc.date),
    narration: doc.narration,
    kind: doc.voucherKind,
  };
  if (doc.kind === 'ledger') {
    const total = doc.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0n);
    return {
      ...common,
      numberLabel: 'No.',
      lines: doc.lines.map((l, i) => ({ sno: i + 1, ledger: l.ledger, side: l.side === 'debit' ? 'Dr' : 'Cr', amount: formatAmount(l.amount) })),
      total: formatAmount(total),
      amountInWords: amountInWords(total),
    };
  }
  const billTo = { name: doc.party.name, lines: addressLines(doc.party.billTo).map((text) => ({ text })) };
  return {
    ...common,
    numberLabel: doc.numberLabel ?? 'No.',
    poNo: doc.poNo,
    ewayBillNo: doc.ewayBillNo,
    placeOfSupply: doc.placeOfSupply,
    party: {
      name: doc.party.name,
      gstin: doc.party.gstin,
      billTo,
      shipTo: doc.party.shipTo ? { name: doc.party.shipTo.name ?? doc.party.name, lines: addressLines(doc.party.shipTo).map((text) => ({ text })) } : billTo,
    },
    lines: doc.lines.map((l, i) => ({ sno: i + 1, desc: l.desc, hsn: l.hsn, qty: l.qty, rate: l.rate, gstRate: l.gstRate ? `${l.gstRate}%` : '', amount: formatAmount(l.amount) })),
    gst: doc.gst ? { cgst: doc.gst.cgst ? formatAmount(doc.gst.cgst) : '', sgst: doc.gst.sgst ? formatAmount(doc.gst.sgst) : '', igst: doc.gst.igst ? formatAmount(doc.gst.igst) : '' } : undefined,
    subtotal: formatAmount(doc.subtotal),
    roundOff: doc.roundOff ? formatAmount(doc.roundOff) : '',
    grandTotal: formatAmount(doc.grandTotal),
    amountInWords: amountInWords(doc.grandTotal),
  };
}

/** Everything a layout can use, for the editor's list (the same names `layoutData` fills). */
export const LAYOUT_PLACEHOLDERS: Readonly<Record<LayoutShape, readonly string[]>> = {
  invoice: [
    'company.name', 'company.address', 'company.gstin', 'company.phone', 'company.email', 'company.bankName', 'company.bankAccountNo', 'company.bankIfsc',
    'company.bankBranch', 'company.invoiceNote', '#hasTerms', '#company.terms … text … /company.terms', 'images.logo', 'images.signature', 'copyLabel', 'title',
    'numberLabel', 'number', 'date', 'poNo', 'ewayBillNo', 'placeOfSupply', 'party.name', 'party.gstin', '#party.billTo.lines … text …',
    '#party.shipTo.lines … text …', '#lines … sno desc hsn qty rate gstRate amount … /lines', 'subtotal', '#gst … cgst sgst igst … /gst', 'roundOff',
    'grandTotal', 'amountInWords', 'narration',
  ],
  ledger: [
    'company.name', 'company.address', 'company.gstin', 'company.phone', 'company.email', 'images.logo', 'images.signature', 'copyLabel', 'title',
    'number', 'date', '#lines … sno ledger side amount … /lines', 'total', 'amountInWords', 'narration',
  ],
};

const DROP = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'FRAME', 'FRAMESET']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'background', 'poster']);

/**
 * The filled layout, safe to show: no scripts, frames or forms, no `on…` handlers, no links or pictures from anywhere but the layout's own
 * pictures (data: images), and no `@import` / `url()` reaching out from its styles. A layout is a printed page, never a program.
 */
export function cleanLayoutHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      if (DROP.has(child.tagName.toUpperCase())) {
        child.remove();
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc') child.removeAttribute(attr.name);
        else if (URL_ATTRS.has(name) && !/^data:image\/(png|jpeg|gif|webp);base64,/.test(value)) child.removeAttribute(attr.name);
        else if (name === 'style' && /url\s*\(|expression\s*\(|@import/i.test(attr.value)) child.removeAttribute(attr.name);
      }
      if (child.tagName.toUpperCase() === 'STYLE') child.textContent = (child.textContent ?? '').replace(/@import[^;]*;?/gi, '').replace(/url\s*\([^)]*\)/gi, 'none');
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/** A document filled into the company's layout and cleaned, or why the layout cannot be used (then the built-in layout prints). */
export function renderLayout(template: string, doc: InvoiceDoc | LedgerDoc, company: PrintCompany, copyLabel: string | undefined, images: Readonly<Record<string, string>>) {
  const r = renderTemplate(template, layoutData(doc, company, copyLabel, images));
  return r.ok ? { ok: true as const, html: cleanLayoutHtml(r.html) } : r;
}

// ---- the built-in layouts, as layouts: where a company's own starts from ------------------------------------------------------

const STYLE = `<style>
  .page { font-family: Consolas, 'Courier New', monospace; font-size: 12px; color: #000; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding-bottom: 8px; margin-bottom: 10px; }
  .head .name { font-size: 22px; font-weight: bold; margin-bottom: 2px; }
  .head .logo { max-height: 60px; max-width: 180px; margin-bottom: 4px; }
  .doc { text-align: right; }
  .doc .title { font-size: 14px; font-weight: bold; letter-spacing: 0.05em; }
  .doc .copy { margin-top: 6px; font-weight: bold; text-transform: uppercase; border: 1px solid #000; padding: 2px 8px; display: inline-block; }
  .doc table { margin: 8px 0 0 auto; border-collapse: collapse; }
  .doc td { padding: 1px 4px; text-align: right; }
  .doc td:first-child { text-align: left; padding-right: 8px; color: #333; }
  .parties { display: flex; border: 1px solid #000; margin-bottom: 10px; }
  .parties > div { flex: 1; padding: 6px 10px; }
  .parties > div:first-child { border-right: 1px solid #000; }
  .label { font-size: 10px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.04em; color: #333; margin-bottom: 3px; }
  table.items { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  table.items th, table.items td { border: 1px solid #000; padding: 4px 6px; }
  table.items th { font-size: 10.5px; text-transform: uppercase; text-align: left; }
  table.items thead { display: table-header-group; }
  table.items tr { break-inside: avoid; }
  .num { text-align: right !important; }
  .center { text-align: center; }
  .totals { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 12px; }
  .totals table { border-collapse: collapse; min-width: 260px; }
  .totals td { padding: 2px 6px; text-align: right; }
  .totals td:first-child { text-align: left; padding-right: 16px; }
  .totals tr.grand td { border-top: 1px solid #000; font-weight: bold; font-size: 13px; }
  .foot { display: flex; justify-content: space-between; gap: 16px; border-top: 1px solid #000; padding-top: 8px; }
  .sign { display: flex; justify-content: flex-end; margin-top: 18px; text-align: center; }
  .sign .for { margin-bottom: 8px; }
  .sign img { max-height: 50px; display: block; margin: 0 auto 4px; }
  .sign .line { border-top: 1px solid #000; padding-top: 3px; min-width: 170px; margin-top: 38px; }
  .sign img + .line { margin-top: 0; }
</style>`;

const HEAD = `<div class="head">
  <div>
    {{#images.logo}}<img class="logo" src="{{images.logo}}" alt="">{{/images.logo}}
    <div class="name">{{company.name}}</div>
    {{#company.address}}<div>{{company.address}}</div>{{/company.address}}
    {{#company.gstin}}<div>GSTIN: {{company.gstin}}</div>{{/company.gstin}}
    <div>{{company.phone}} {{company.email}}</div>
  </div>
  <div class="doc">
    <div class="title">{{title}}</div>
    {{#copyLabel}}<div class="copy">{{copyLabel}}</div>{{/copyLabel}}
    <table>
      <tr><td>{{numberLabel}}</td><td>{{number}}</td></tr>
      <tr><td>Date</td><td>{{date}}</td></tr>
      {{#poNo}}<tr><td>PO No.</td><td>{{poNo}}</td></tr>{{/poNo}}
      {{#ewayBillNo}}<tr><td>E-way Bill No.</td><td>{{ewayBillNo}}</td></tr>{{/ewayBillNo}}
    </table>
  </div>
</div>`;

const FOOT = `<div class="foot">
  <div>
    {{#company.bankName}}<div class="label">Bank details</div><div>{{company.bankName}}</div><div>A/c No. {{company.bankAccountNo}}</div><div>IFSC {{company.bankIfsc}}</div><div>{{company.bankBranch}}</div>{{/company.bankName}}
    {{#company.invoiceNote}}<div><i>{{company.invoiceNote}}</i></div>{{/company.invoiceNote}}
  </div>
  {{#hasTerms}}<div><div class="label">Terms</div><ol>{{#company.terms}}<li>{{text}}</li>{{/company.terms}}</ol></div>{{/hasTerms}}
</div>
<div class="sign"><div>
  <div class="for">For {{company.name}}</div>
  {{#images.signature}}<img src="{{images.signature}}" alt="">{{/images.signature}}
  <div class="line">Authorised Signatory</div>
</div></div>`;

/** The built-in invoice layout, written as a layout (what "Start from the built-in layout" loads). */
export const BUILT_IN_LAYOUTS: Readonly<Record<LayoutShape, string>> = {
  invoice: `${STYLE}
<div class="page">
${HEAD}
<div class="parties">
  <div><div class="label">Bill To</div><b>{{party.billTo.name}}</b>{{#party.billTo.lines}}<div>{{text}}</div>{{/party.billTo.lines}}{{#party.gstin}}<div>GSTIN: {{party.gstin}}</div>{{/party.gstin}}</div>
  <div><div class="label">Ship To</div><b>{{party.shipTo.name}}</b>{{#party.shipTo.lines}}<div>{{text}}</div>{{/party.shipTo.lines}}</div>
</div>
{{#placeOfSupply}}<div><b>Place of Supply:</b> {{placeOfSupply}}</div>{{/placeOfSupply}}
<table class="items">
  <thead><tr><th class="center">S.No.</th><th>Description</th><th class="center">HSN</th><th class="num">Qty</th><th class="num">Rate</th>{{#gst}}<th class="num">GST%</th>{{/gst}}<th class="num">Amount</th></tr></thead>
  <tbody>
  {{#lines}}<tr><td class="center">{{sno}}</td><td>{{desc}}</td><td class="center">{{hsn}}</td><td class="num">{{qty}}</td><td class="num">{{rate}}</td>{{#gst}}<td class="num">{{gstRate}}</td>{{/gst}}<td class="num">{{amount}}</td></tr>{{/lines}}
  </tbody>
</table>
<div class="totals">
  <div><div class="label">Amount in Words</div>{{amountInWords}}</div>
  <table>
    <tr><td>Subtotal</td><td>{{subtotal}}</td></tr>
    {{#gst}}{{#cgst}}<tr><td>CGST</td><td>{{cgst}}</td></tr>{{/cgst}}{{#sgst}}<tr><td>SGST</td><td>{{sgst}}</td></tr>{{/sgst}}{{#igst}}<tr><td>IGST</td><td>{{igst}}</td></tr>{{/igst}}{{/gst}}
    {{#roundOff}}<tr><td>Round Off</td><td>{{roundOff}}</td></tr>{{/roundOff}}
    <tr class="grand"><td>Total</td><td>₹ {{grandTotal}}</td></tr>
  </table>
</div>
{{#narration}}<p><b>Narration:</b> <i>{{narration}}</i></p>{{/narration}}
${FOOT}
</div>`,
  ledger: `${STYLE}
<div class="page">
${HEAD}
<table class="items">
  <thead><tr><th class="center">S.No.</th><th>Particulars</th><th class="center">Dr / Cr</th><th class="num">Amount</th></tr></thead>
  <tbody>{{#lines}}<tr><td class="center">{{sno}}</td><td>{{ledger}}</td><td class="center">{{side}}</td><td class="num">{{amount}}</td></tr>{{/lines}}</tbody>
</table>
<div class="totals"><div><div class="label">Amount in Words</div>{{amountInWords}}</div><table><tr class="grand"><td>Total</td><td>₹ {{total}}</td></tr></table></div>
{{#narration}}<p><b>Narration:</b> <i>{{narration}}</i></p>{{/narration}}
${FOOT}
</div>`,
};
