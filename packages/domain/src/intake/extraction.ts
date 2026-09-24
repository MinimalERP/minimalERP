import { z } from 'zod';
import { parseLocalDate } from '../dates';

/**
 * What a reader (Gemini) is asked to take out of one document a person chose to send to the ERP — a customer's PO, a supplier's bill, a
 * payment advice. It is a READING, not a voucher: names and numbers exactly as printed, no ids. `proposeFromExtraction` turns it into a
 * proposal a person reviews; nothing here is ever posted as it stands.
 *
 * The reader is a language model, so the schema is forgiving about representation (numbers may come as 1200, "1,200.00" or "₹ 1200") and
 * strict about nothing: a field it could not read is simply absent, and the review screen shows what is missing.
 */

export const INTAKE_KINDS = ['salesOrder', 'sales', 'purchase', 'receipt', 'payment'] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

/** The kinds that carry item lines (the others carry an amount and the bills it settles). */
export const isItemKind = (kind: IntakeKind): kind is 'salesOrder' | 'sales' | 'purchase' => kind === 'salesOrder' || kind === 'sales' || kind === 'purchase';

/** "1,23,456.50", "₹ 1200", 1200 → "123456.50" / "1200"; anything that is not a plain non-negative decimal → undefined. */
export function decimalText(v: unknown): string | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? String(v) : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[₹,\s]|rs\.?|inr/gi, '');
  return /^\d+(\.\d+)?$/.test(s) ? s.replace(/^0+(?=\d)/, '') : undefined;
}

/** "2024-05-01" as is; "01/05/2024" and "01-05-2024" read day first (Indian documents); anything else → undefined. */
export function dateText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (parseLocalDate(s)) return s;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (!m) return undefined;
  const iso = `${m[3]}-${(m[2] ?? '').padStart(2, '0')}-${(m[1] ?? '').padStart(2, '0')}`;
  return parseLocalDate(iso) ? iso : undefined;
}

const text = (max: number) =>
  z
    .unknown()
    .transform((v) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : ''))
    .transform((s) => (s === '' ? undefined : s))
    .optional();
const decimal = z.unknown().transform(decimalText).optional();
const date = z.unknown().transform(dateText).optional();

export const extractionLineSchema = z.object({
  /** The line as printed: what a person would recognise the item by. */
  description: text(200),
  /** The party's own code for the item, or ours if printed. */
  code: text(40),
  hsn: text(10),
  qty: decimal,
  unit: text(20),
  rate: decimal,
  /** The line's value, when printed (used to find the rate when only qty and amount are given). */
  amount: decimal,
  /** GST percentage of the line, e.g. "18". */
  gstRate: decimal,
  /** Delivery date of the line (orders). */
  dueDate: date,
});
export type ExtractionLine = z.output<typeof extractionLineSchema>;

export const extractionBillSchema = z.object({
  /** The invoice / bill number this payment settles. */
  ref: text(60),
  amount: decimal,
  /** TDS deducted from that bill. */
  tds: decimal,
});

export const extractionSchema = z.object({
  /** Who the document is from (on a receipt: who paid; on a payment: who was paid). */
  partyName: text(120),
  partyGstin: text(15),
  partyAddress: text(400),
  /** The document's date. */
  date: date,
  /** The customer's PO number (an order), or the order an invoice is against. */
  poNumber: text(60),
  /** The supplier's invoice number (a purchase bill). */
  invoiceNumber: text(60),
  dueDate: date,
  lines: z.array(extractionLineSchema).max(200).catch([]).default([]),
  /** Before tax, and with tax, as printed. */
  subtotal: decimal,
  grandTotal: decimal,
  // ---- a receipt / payment advice ----
  /** The amount paid (what reached, or left, the bank). */
  amount: decimal,
  /** UTR / UPI reference / cheque number. */
  instrument: text(40),
  /** The last digits of our bank account, if the advice names it. */
  bankAccount: text(40),
  bills: z.array(extractionBillSchema).max(100).catch([]).default([]),
});
export type Extraction = z.output<typeof extractionSchema>;

/**
 * The same shape as a JSON schema (the OpenAPI subset Gemini's `responseSchema` takes), so the model can only answer in it. Every value is
 * a string so the model never rounds a number; `extractionSchema` reads them.
 */
const S = { type: 'STRING' } as const;
export const extractionResponseSchema = {
  type: 'OBJECT',
  properties: {
    partyName: S,
    partyGstin: S,
    partyAddress: S,
    date: { type: 'STRING', description: 'YYYY-MM-DD' },
    poNumber: S,
    invoiceNumber: S,
    dueDate: { type: 'STRING', description: 'YYYY-MM-DD' },
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING', description: 'the item description as printed, without the part number' },
          code: { type: 'STRING', description: 'the part number / material number / item code printed on the line (not the HSN)' },
          hsn: S, qty: S, unit: S, rate: S, amount: S, gstRate: S, dueDate: { type: 'STRING', description: 'YYYY-MM-DD' } },
      },
    },
    subtotal: S,
    grandTotal: S,
    amount: S,
    instrument: S,
    bankAccount: S,
    bills: { type: 'ARRAY', items: { type: 'OBJECT', properties: { ref: S, amount: S, tds: S } } },
  },
} as const;

const WHAT: Record<IntakeKind, string> = {
  salesOrder: "a customer's purchase order sent to us (we are the seller). The party is the customer; poNumber is their PO number.",
  sales: 'a request to invoice goods we are delivering to a customer. The party is the customer; poNumber is their PO number if mentioned.',
  purchase: "a supplier's tax invoice / bill to us (we are the buyer). The party is the supplier; invoiceNumber is the supplier's invoice number.",
  receipt: "a customer's payment advice / remittance to us. The party is the customer who paid; list the bills (our invoice numbers) it settles and any TDS deducted.",
  payment: "a payment made by us to a supplier (bank debit advice or our payment confirmation). The party is the supplier paid; list the bills (their invoice numbers) it settles.",
};

/** The instruction the reader gets with the document. */
export function extractionPrompt(kind: IntakeKind, ownCompany: string): string {
  return [
    `You read business documents for the accounting system of "${ownCompany}". This document is ${WHAT[kind]}`,
    `Never return "${ownCompany}" as the party.`,
    'Copy names, numbers and codes exactly as printed. Give dates as YYYY-MM-DD (Indian documents write day first).',
    'For each line give its part number (material no. / item code) in `code` and its description separately in `description`.',
    'Give amounts and quantities as plain numbers without currency symbols or thousands separators.',
    'Leave out any field that is not on the document; never guess.',
  ].join('\n');
}
