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
