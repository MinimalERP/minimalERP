/** What a printed page shows: the documents `PrintView` lays out (and a company's own layout fills, see `printTemplate.ts`). */

export interface PrintAddress {
  readonly name?: string | undefined;
  readonly lines?: string | undefined;
  readonly stateCode?: string | undefined;
  readonly country?: string | undefined;
  readonly pincode?: string | undefined;
}

export interface PrintParty {
  readonly name: string;
  readonly gstin?: string | undefined;
  readonly billTo?: PrintAddress | undefined;
  /** Absent: same as billing. */
  readonly shipTo?: PrintAddress | undefined;
}

export interface PrintCompany {
  readonly name: string;
  readonly address?: string | undefined;
  readonly gstin?: string | undefined;
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
  readonly bankName?: string | undefined;
  readonly bankAccountNo?: string | undefined;
  readonly bankIfsc?: string | undefined;
  readonly bankBranch?: string | undefined;
  readonly invoiceNote?: string | undefined;
  readonly invoiceTerms?: string | undefined;
}

/** A simple double- or single-entry voucher: Payment, Receipt, Contra, Journal, Opening. */
export interface LedgerDoc {
  readonly kind: 'ledger';
  /** The voucher's base kind ("payment"…): a company's own layout may be for this kind alone (ADR-0025). */
  readonly voucherKind?: string | undefined;
  readonly docTitle: string;
  readonly number: string;
  readonly date: string;
  readonly lines: readonly { readonly ledger: string; readonly side: 'debit' | 'credit'; readonly amount: bigint }[];
  readonly narration?: string | undefined;
}

/** A Sales/Purchase Order or Invoice: bill-to/ship-to, an item table, GST, totals, bank details and a signature. */
export interface InvoiceDoc {
  readonly kind: 'invoice';
  /** The voucher's base kind ("sales", "purchaseOrder"…): a company's own layout may be for this kind alone (ADR-0025). */
  readonly voucherKind?: string | undefined;
  readonly docTitle: string;
  readonly number: string;
  readonly date: string;
  /** What the number row is labelled — "No." unless the screen names something more specific ("Invoice No." for a Sales Invoice). */
  readonly numberLabel?: string | undefined;
  /** The customer's own reference (Sales) — shown as "PO No." only when present. */
  readonly poNo?: string | undefined;
  /** The E-way Bill number for this invoice's movement of goods (Sales) — shown only when present. */
  readonly ewayBillNo?: string | undefined;
  /** The state of the delivery address, as it prints ("Maharashtra (27)") — shown only when known. */
  readonly placeOfSupply?: string | undefined;
  readonly party: PrintParty;
  readonly lines: readonly {
    readonly desc: string;
    readonly hsn?: string | undefined;
    readonly qty: string;
    readonly rate: string;
    readonly amount: bigint;
    readonly gstRate?: string | undefined;
  }[];
  readonly subtotal: bigint;
  readonly gst?: { readonly cgst: bigint; readonly sgst: bigint; readonly igst: bigint } | undefined;
  /** The Round Off adjustment (signed: positive when rounded up) — shown only when nonzero. */
  readonly roundOff?: bigint | undefined;
  readonly grandTotal: bigint;
  readonly narration?: string | undefined;
  /** Only on the copy a payment reminder attaches: where the bill stands today. The ordinary print never carries it. */
  readonly paymentStatus?: PaymentStatus | undefined;
}

export interface PaymentStatus {
  readonly asOn: string;
  /** What the bill was raised for, what has come in against it, and the rest. */
  readonly amount: bigint;
  readonly received: bigint;
  readonly pending: bigint;
  readonly dueDate: string;
  readonly daysOverdue: number;
}

/** A Stock Journal or opening stock: an internal movement, not a customer document — no GST, bank details or signature. */
export interface StockDoc {
  readonly kind: 'stock';
  readonly docTitle: string;
  readonly number: string;
  readonly date: string;
  readonly lines: readonly { readonly direction: 'in' | 'out'; readonly item: string; readonly warehouse: string; readonly qty: string; readonly value: bigint }[];
  readonly narration?: string | undefined;
}

/** A report: the same rows and columns the screen shows, in full — never only the on-screen grid's windowed slice. */
export interface ReportDoc {
  readonly kind: 'report';
  readonly title: string;
  readonly period: string;
  readonly filters: readonly string[];
  readonly columns: readonly { readonly label: string; readonly align?: 'left' | 'right' | undefined }[];
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: string;
  /**
   * A statement to send someone (a ledger): printed like a voucher — framed, the company's heading on the left, the document's title and dates on
   * the right, the party and a summary in a box — instead of a plain report page.
   */
  readonly statement?: StatementHead | undefined;
  /** More tables after the main one (a party ledger's outstanding bills). */
  readonly tables?: readonly { readonly title: string; readonly columns: ReportDoc['columns']; readonly rows: readonly (readonly string[])[] }[] | undefined;
}

export interface StatementHead {
  /** "Statement of Account" (a party) or "Ledger Account". */
  readonly docTitle: string;
  /** Right of the heading, under the title: "Period" …, "As on" … */
  readonly details: readonly (readonly [string, string])[];
  /** Whom it is of: the name, then address, GSTIN, phone / email lines. */
  readonly party: { readonly label: string; readonly name: string; readonly lines: readonly string[] };
  /** Beside the party: opening, debits, credits, closing, what is pending. */
  readonly summary: readonly (readonly [string, string])[];
}

/**
 * A dispatch docket, two pages: the consignment (the customer, the invoices it carries, packages, transporter, LR) and every item on those
 * invoices, like items added together. Built from invoices already posted — nothing of it is stored.
 */
export interface DocketDoc {
  readonly kind: 'docket';
  readonly number: string;
  readonly date: string;
  readonly party: PrintParty;
  readonly invoices: readonly { readonly number: string; readonly date: string; readonly poNo?: string | undefined; readonly amount: bigint }[];
  readonly packages: string;
  readonly transporter: string;
  readonly lrNo: string;
  readonly items: readonly { readonly desc: string; readonly hsn?: string | undefined; readonly qty: string }[];
  /** All the items' quantity, per unit ("120 Nos + 5 Kg"). */
  readonly totalQty: string;
}

export type PrintDoc = LedgerDoc | InvoiceDoc | StockDoc | ReportDoc | DocketDoc;
