import type { ChallanStatus } from '@minimalerp/domain';

/** The base kinds the voucher screen enters, with the name the headings and the bottom bar use. */
export const ENTRY_KINDS = ['contra', 'payment', 'receipt', 'journal'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const KIND_TITLES: Readonly<Record<EntryKind, string>> = { contra: 'Contra', payment: 'Payment', receipt: 'Receipt', journal: 'Journal' };

/**
 * The item-line documents: the Sales Invoice and Order, and the Purchase Invoice and Order. They share one window; an invoice and its order
 * switch into each other in place (F8 / Shift+F8, F9 / Shift+F9).
 */
export const SALES_KINDS = ['sales', 'salesOrder', 'purchase', 'purchaseOrder'] as const;
export type SalesKind = (typeof SALES_KINDS)[number];
export const SALES_TITLES: Readonly<Record<SalesKind, string>> = { sales: 'Sales', salesOrder: 'Sales Order', purchase: 'Purchase', purchaseOrder: 'Purchase Order' };
export const isSalesKind = (s: string): s is SalesKind => (SALES_KINDS as readonly string[]).includes(s);

/** Quotation: a sales-side document on the same worksheet; it does not switch with F8 / Shift+F8. */
export const QUOTATION_KIND = 'quotation' as const;
/** Delivery Challan: goods going out without a bill (to be invoiced later, or free of cost), on the same worksheet. */
export const CHALLAN_KIND = 'deliveryChallan' as const;
/** Returnable Challan: goods sent to a supplier that come back as they went ("Mark returned" brings them back). */
export const RETURNABLE_KIND = 'returnableChallan' as const;
/** Credit Note and Debit Note: an invoice taken back (goods returned, a price reduced), on the same worksheet as the invoice it reverses. */
export const NOTE_KINDS = ['creditNote', 'debitNote'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_TITLES: Readonly<Record<NoteKind, string>> = { creditNote: 'Credit Note', debitNote: 'Debit Note' };
export const isNoteDocKind = (s: string): s is NoteKind => (NOTE_KINDS as readonly string[]).includes(s);
export type ItemDocKind = SalesKind | typeof QUOTATION_KIND | typeof CHALLAN_KIND | typeof RETURNABLE_KIND | NoteKind;
export const isItemDocKind = (s: string): s is ItemDocKind => isSalesKind(s) || s === QUOTATION_KIND || s === CHALLAN_KIND || s === RETURNABLE_KIND || isNoteDocKind(s);
/** How a challan's state reads on its badge and in its list. */
export const CHALLAN_STATUS: Readonly<Record<ChallanStatus, string>> = {
  foc: 'FOC',
  toInvoice: 'To invoice',
  partlyInvoiced: 'Part invoiced',
  invoiced: 'Invoiced',
};

/** Which way a document faces: the customer's (we sell) or the supplier's (we buy). */
export type DocSide = 'sales' | 'purchase';

/**
 * What differs between the four documents, in one place: the words on the window and the group of accounts its ledger comes from. The screen and
 * the form model ask this instead of comparing kinds, so a side is a row here, not a fork of the window.
 */
export interface DocProfile {
  readonly side: DocSide;
  /** An invoice (goods move and money is owed) rather than an order (a document that posts nothing). A credit or debit note is one too, turned round. */
  readonly invoice: boolean;
  /** A credit note (sales side) or debit note (purchase side): it takes an invoice back, so its goods move the other way and it raises no bill to pay. */
  readonly note: boolean;
  /** The goods on its lines LEAVE a godown (a sale, a challan, a debit note) rather than arrive in one (a purchase, a credit note). */
  readonly goodsOut: boolean;
  readonly order: boolean;
  /** A quotation: prices for the customer, no stock or accounts. */
  readonly quote: boolean;
  /** A delivery or returnable challan: goods leave a godown, nothing is billed. */
  readonly challan: boolean;
  /** A returnable challan: made out to a supplier, and the goods come back. */
  readonly returnable: boolean;
  /** Each line names the godown its goods leave (or arrive in): an invoice or a challan. */
  readonly moves: boolean;
  /** The party role the document needs, and what to call the party. */
  readonly role: 'customer' | 'vendor';
  readonly noun: string;
  readonly nounPlural: string;
  /** The reserved group its ledger lives under, and what the ledger is called. */
  readonly ledgerGroup: 'sales-accounts' | 'purchase-accounts';
  readonly ledgerLabel: string;
  /** The header field that names the other side's order or reference. */
  readonly refLabel: string;
  readonly refAria: string;
  /** What happens to the goods: "delivered" / "received". */
  readonly done: string;
  readonly doing: string;
  /** The heading and the name of the bill a person reads: "Bill due" and its owner. */
  readonly billDue: string;
}

const SALES_SIDE = { side: 'sales', role: 'customer', noun: 'customer', nounPlural: 'Customers', ledgerGroup: 'sales-accounts', ledgerLabel: 'Sales ledger', done: 'delivered', doing: 'delivering', billDue: 'Bill due' } as const;
const PURCHASE_SIDE = { side: 'purchase', role: 'vendor', noun: 'supplier', nounPlural: 'Suppliers', ledgerGroup: 'purchase-accounts', ledgerLabel: 'Purchase ledger', done: 'received', doing: 'receiving', billDue: 'Bill due' } as const;

export function docProfile(kind: ItemDocKind): DocProfile {
  if (kind === QUOTATION_KIND) {
    return {
      ...SALES_SIDE,
      invoice: false,
      note: false,
      goodsOut: false,
      order: false,
      quote: true,
      challan: false,
      returnable: false,
      moves: false,
      refLabel: 'Reference',
      refAria: 'Your reference for this quote',
    };
  }
  if (kind === CHALLAN_KIND) {
    return { ...SALES_SIDE, invoice: false, note: false, goodsOut: true, order: false, quote: false, challan: true, returnable: false, moves: true, refLabel: 'Cust PO / ref', refAria: 'Customer PO or reference' };
  }
  if (kind === RETURNABLE_KIND) {
    // the goods leave a godown (as on a sale), to a supplier
    return { ...SALES_SIDE, role: 'vendor', noun: 'supplier', nounPlural: 'Suppliers', invoice: false, note: false, goodsOut: true, order: false, quote: false, challan: true, returnable: true, moves: true, refLabel: 'Reference', refAria: 'Reference' };
  }
  if (isNoteDocKind(kind)) {
    // the invoice of its side, turned round: the same party, ledger and tax; the goods go the other way
    const side = kind === 'creditNote' ? SALES_SIDE : PURCHASE_SIDE;
    return { ...side, invoice: true, note: true, goodsOut: kind === 'debitNote', order: false, quote: false, challan: false, returnable: false, moves: true, refLabel: 'Reference', refAria: 'Reference' };
  }
  const invoice = kind === 'sales' || kind === 'purchase';
  const side = kind === 'sales' || kind === 'salesOrder' ? SALES_SIDE : PURCHASE_SIDE;
  const refLabel = side.side === 'sales' ? 'Cust PO / ref' : invoice ? 'PO / ref' : 'Supplier ref';
  const refAria = side.side === 'sales' ? 'Customer PO or reference' : invoice ? 'Purchase order or reference' : 'Supplier reference';
  return { ...side, invoice, note: false, goodsOut: invoice && side.side === 'sales', order: !invoice, quote: false, challan: false, returnable: false, moves: invoice, refLabel, refAria };
}

/** A purchase or a purchase order: the goods come to us, so it is shipped to our own address unless another is chosen on the document. */
export const receivedAtOurs = (kind: ItemDocKind): boolean => {
  const p = docProfile(kind);
  return p.side === 'purchase' && !p.goodsOut;
};

/** The note that takes back an invoice of this side: a Credit Note for a sale, a Debit Note for a purchase. */
export const noteKindOf = (side: DocSide): NoteKind => (side === 'sales' ? 'creditNote' : 'debitNote');

/** The same side's invoice and order kinds. */
export const invoiceKindOf = (side: DocSide): SalesKind => (side === 'sales' ? 'sales' : 'purchase');
export const orderKindOf = (side: DocSide): SalesKind => (side === 'sales' ? 'salesOrder' : 'purchaseOrder');

/** Every kind a voucher window can be opened for: the four accounting kinds, the item documents, and the Stock Journal (which moves stock, not money). */
const ALL_TITLES: Readonly<Record<string, string>> = { ...KIND_TITLES, ...SALES_TITLES, [QUOTATION_KIND]: 'Quotation', [CHALLAN_KIND]: 'Delivery Challan', [RETURNABLE_KIND]: 'Returnable Challan', ...NOTE_TITLES, stockJournal: 'Stock Journal' };
export const kindTitle = (key: string): string | undefined => ALL_TITLES[key];
