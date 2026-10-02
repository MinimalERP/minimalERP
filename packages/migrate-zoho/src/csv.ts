import { parseCsvRecords } from '@minimalerp/domain';

/**
 * Zoho Books' own "Invoices" export: one row per LINE ITEM, with every header field of the invoice repeated on
 * each of its rows. Only the columns this migration actually uses are named here — the export has 180 of them.
 */
export interface ZohoLine {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly invoiceStatus: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly gstin: string;
  readonly placeOfSupply: string;
  readonly billingAttention: string;
  readonly billingAddress: string;
  readonly billingCity: string;
  readonly billingState: string;
  readonly billingCode: string;
  readonly primaryEmail: string;
  readonly paymentTermsDays: string;
  readonly dueDate: string;
  readonly purchaseOrder: string;
  readonly subtotal: string;
  readonly total: string;
  readonly roundOff: string;
  readonly itemName: string;
  readonly itemDesc: string;
  readonly quantity: string;
  readonly usageUnit: string;
  readonly itemPrice: string;
  readonly hsn: string;
  readonly cgstRate: string;
  readonly sgstRate: string;
  readonly igstRate: string;
}

export interface ZohoInvoice {
  readonly invoiceNumber: string;
  readonly rows: readonly ZohoLine[];
}

const col = (r: Record<string, string>, name: string): string => (r[name] ?? '').trim();

/** One `ZohoLine` per CSV data row, reading only the columns this migration needs. */
export function parseZohoCsv(csvText: string): ZohoLine[] {
  return parseCsvRecords(csvText).map((r) => ({
    invoiceId: col(r, 'Invoice ID'),
    invoiceNumber: col(r, 'Invoice Number'),
    invoiceDate: col(r, 'Invoice Date'),
    invoiceStatus: col(r, 'Invoice Status'),
    customerId: col(r, 'Customer ID'),
    customerName: col(r, 'Customer Name'),
    gstin: col(r, 'GST Identification Number (GSTIN)'),
    placeOfSupply: col(r, 'Place of Supply(With State Code)'),
    billingAttention: col(r, 'Billing Attention'),
    billingAddress: col(r, 'Billing Address'),
    billingCity: col(r, 'Billing City'),
    billingState: col(r, 'Billing State'),
    billingCode: col(r, 'Billing Code'),
    primaryEmail: col(r, 'Primary Contact EmailID'),
    paymentTermsDays: col(r, 'Payment Terms'),
    dueDate: col(r, 'Due Date'),
    purchaseOrder: col(r, 'PurchaseOrder'),
    subtotal: col(r, 'SubTotal'),
    total: col(r, 'Total'),
    roundOff: col(r, 'Round Off'),
    itemName: col(r, 'Item Name'),
    itemDesc: col(r, 'Item Desc'),
    quantity: col(r, 'Quantity'),
    usageUnit: col(r, 'Usage unit'),
    itemPrice: col(r, 'Item Price'),
    hsn: col(r, 'HSN/SAC'),
    cgstRate: col(r, 'CGST Rate %'),
    sgstRate: col(r, 'SGST Rate %'),
    igstRate: col(r, 'IGST Rate %'),
  }));
}

/** Rows sharing one "Invoice Number" become one invoice, its lines kept in the file's own order; invoices
 *  ordered by their first row's position in the file (Zoho's own export order, oldest first in practice). */
export function groupByInvoice(rows: readonly ZohoLine[]): ZohoInvoice[] {
  const order: string[] = [];
  const byNumber = new Map<string, ZohoLine[]>();
  for (const r of rows) {
    if (r.invoiceNumber === '') continue; // a stray blank line at the end of the file
    if (!byNumber.has(r.invoiceNumber)) order.push(r.invoiceNumber);
    byNumber.set(r.invoiceNumber, [...(byNumber.get(r.invoiceNumber) ?? []), r]);
  }
  return order.map((invoiceNumber) => ({ invoiceNumber, rows: byNumber.get(invoiceNumber) as ZohoLine[] }));
}

/** Parses a Zoho invoice number range like "26-27/001..26-27/090" (inclusive) or a comma list of exact numbers.
 *  Range comparison is on the numeric part after the last "/" (Zoho's own sequence), so it doesn't depend on
 *  a particular financial-year prefix. Returns undefined (meaning "everything") when `spec` is undefined. */
export function invoiceFilterOf(spec: string | undefined): ((invoiceNumber: string) => boolean) | undefined {
  if (spec === undefined || spec.trim() === '') return undefined;
  const seqOf = (n: string): number => {
    const m = /(\d+)\s*$/.exec(n);
    return m ? Number(m[1]) : Number.NaN;
  };
  const range = /^(.+)\.\.(.+)$/.exec(spec.trim());
  if (range) {
    const from = seqOf(range[1] as string);
    const to = seqOf(range[2] as string);
    return (invoiceNumber) => {
      const n = seqOf(invoiceNumber);
      return !Number.isNaN(n) && n >= from && n <= to;
    };
  }
  const exact = new Set(
    spec
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  );
  return (invoiceNumber) => exact.has(invoiceNumber);
}

/**
 * Zoho Books' "Customer Payments" export: one row per INVOICE a payment was applied to (a payment applied to nothing, or with money
 * left over, has a row with no invoice), every header field of the payment repeated on each row. Zoho has renamed some of these
 * columns between versions, so each is read under any of the names it has gone by.
 */
export interface ZohoPaymentRow {
  readonly paymentId: string;
  readonly paymentNumber: string;
  readonly date: string;
  readonly customerName: string;
  readonly gstin: string;
  /** What the customer paid, before Zoho's bank charges. */
  readonly amount: string;
  /** Of `amount`, what was not applied to any invoice: an advance. */
  readonly unusedAmount: string;
  readonly bankCharges: string;
  readonly mode: string;
  readonly reference: string;
  readonly description: string;
  /** The Zoho account the money went into ("HDFC Bank", "Petty Cash", "Undeposited Funds", …). */
  readonly depositTo: string;
  /** Zoho's id for this one application of the payment to an invoice: the same row read twice is dropped. */
  readonly invoicePaymentId: string;
  readonly invoiceNumber: string;
  readonly appliedAmount: string;
  /** TDS the customer deducted from this invoice. */
  readonly tds: string;
}

export interface ZohoPayment {
  readonly paymentNumber: string;
  readonly rows: readonly ZohoPaymentRow[];
}

const anyCol = (r: Record<string, string>, ...names: string[]): string => names.map((n) => col(r, n)).find((v) => v !== '') ?? '';

export function parseZohoPaymentsCsv(csvText: string): ZohoPaymentRow[] {
  return parseCsvRecords(csvText).map((r) => ({
    paymentId: anyCol(r, 'CustomerPayment ID', 'Customer Payment ID', 'Payment ID'),
    paymentNumber: anyCol(r, 'Payment Number', 'Payment#'),
    date: anyCol(r, 'Date', 'Payment Date'),
    customerName: anyCol(r, 'Customer Name'),
    gstin: anyCol(r, 'GST Identification Number (GSTIN)'),
    amount: anyCol(r, 'Amount', 'Payment Amount'),
    unusedAmount: anyCol(r, 'Unused Amount'),
    bankCharges: anyCol(r, 'Bank Charges'),
    mode: anyCol(r, 'Mode', 'Payment Mode'),
    reference: anyCol(r, 'Reference Number', 'Reference#'),
    description: anyCol(r, 'Description', 'Notes'),
    depositTo: anyCol(r, 'Deposit To', 'Paid Through'),
    invoicePaymentId: anyCol(r, 'InvoicePayment ID', 'Invoice Payment ID'),
    invoiceNumber: anyCol(r, 'Invoice Number', 'Invoice#'),
    appliedAmount: anyCol(r, 'Amount Applied to Invoice', 'Applied Amount', 'Invoice Payment Applied Amount'),
    tds: anyCol(r, 'Withholding Tax Amount', 'TDS Amount', 'Tax Deducted'),
  }));
}

/** Rows of one payment (by Zoho's payment ID, else its number) become one payment, in the file's order. A row seen before (the same
 *  invoice payment, in two overlapping exports) is read once. */
export function groupByPayment(rows: readonly ZohoPaymentRow[]): ZohoPayment[] {
  const order: string[] = [];
  const byKey = new Map<string, ZohoPaymentRow[]>();
  const seen = new Set<string>();
  for (const r of rows) {
    const key = r.paymentId || r.paymentNumber;
    if (key === '') continue;
    if (r.invoicePaymentId !== '') {
      if (seen.has(`${key}|${r.invoicePaymentId}`)) continue;
      seen.add(`${key}|${r.invoicePaymentId}`);
    }
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  return order.map((key) => {
    const rows = byKey.get(key) as ZohoPaymentRow[];
    return { paymentNumber: rows[0]?.paymentNumber || key, rows };
  });
}
