/** The base kinds the voucher screen enters, with the name the headings and the bottom bar use. */
export const ENTRY_KINDS = ['contra', 'payment', 'receipt', 'journal'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const KIND_TITLES: Readonly<Record<EntryKind, string>> = { contra: 'Contra', payment: 'Payment', receipt: 'Receipt', journal: 'Journal' };
export const isEntryKind = (s: string): s is EntryKind => (ENTRY_KINDS as readonly string[]).includes(s);

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
export type ItemDocKind = SalesKind | typeof QUOTATION_KIND;
export const isItemDocKind = (s: string): s is ItemDocKind => isSalesKind(s) || s === QUOTATION_KIND;

/** Which way a document faces: the customer's (we sell) or the supplier's (we buy). */
export type DocSide = 'sales' | 'purchase';

/**
 * What differs between the four documents, in one place: the words on the window and the group of accounts its ledger comes from. The screen and
 * the form model ask this instead of comparing kinds, so a side is a row here, not a fork of the window.
 */
export interface DocProfile {
  readonly side: DocSide;
  /** An invoice (goods move and money is owed) rather than an order (a document that posts nothing). */
  readonly invoice: boolean;
  readonly order: boolean;
  /** A quotation: prices for the customer, no stock or accounts. */
  readonly quote: boolean;
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
      order: false,
      quote: true,
      refLabel: 'Reference',
      refAria: 'Your reference for this quote',
      billDue: 'Valid until',
    };
  }
  const invoice = kind === 'sales' || kind === 'purchase';
  const side = kind === 'sales' || kind === 'salesOrder' ? SALES_SIDE : PURCHASE_SIDE;
  const refLabel = side.side === 'sales' ? 'Cust PO / ref' : invoice ? 'PO / ref' : 'Supplier ref';
  const refAria = side.side === 'sales' ? 'Customer PO or reference' : invoice ? 'Purchase order or reference' : 'Supplier reference';
  return { ...side, invoice, order: !invoice, quote: false, refLabel, refAria };
}

/** The same side's invoice and order kinds. */
export const invoiceKindOf = (side: DocSide): SalesKind => (side === 'sales' ? 'sales' : 'purchase');
export const orderKindOf = (side: DocSide): SalesKind => (side === 'sales' ? 'salesOrder' : 'purchaseOrder');

/** Every kind a voucher window can be opened for: the four accounting kinds, the item documents, and the Stock Journal (which moves stock, not money). */
const ALL_TITLES: Readonly<Record<string, string>> = { ...KIND_TITLES, ...SALES_TITLES, [QUOTATION_KIND]: 'Quotation', stockJournal: 'Stock Journal' };
export const kindTitle = (key: string): string | undefined => ALL_TITLES[key];
