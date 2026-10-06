import {
  type BaseKind,
  type LedgerId,
  type LocalDate,
  type Money,
  type Party,
  type Voucher,
  billStatusOf,
  dailyDigest,
  gstInvoices,
  money,
  partyLedgerId,
} from '@minimalerp/domain';
import type { Books } from '../books/books';
import { type OutstandingBillRow, billRows, partyRows, partyTotals } from '../reports/outstandingReports';
import { type StockSummaryRow, availableOf, stockSummaryRows } from '../reports/stockReports';
import { type VoucherListRow, voucherListRows } from '../reports/voucherLists';
import type { ItemDocKind } from '../vouchers/kinds';
import { type SalesForm, type SalesPreview, previewSales, salesFormFromVoucher, salesKindOf } from '../vouchers/salesModel';

/**
 * What the mobile screens show, read from the books by the SAME functions the desktop reports use (Outstanding, Stock Summary, the voucher
 * lists, the invoice preview) — so a figure on the phone is the figure on the desktop, and no accounting or GST arithmetic lives here.
 * Pure functions of `Books`: nothing is stored, nothing is written.
 */

const day = (d: string): LocalDate => d as LocalDate;

/**
 * A screen's figures, kept while the books they were read from are the same books: going Back to a list or to the Gateway shows what was
 * there at once instead of reading every voucher again. `Books` replaces its vouchers, lines, stock and masters whenever anything changes,
 * so "the same" is identity — a figure can never outlive the data it came from. `peek` answers only if it is already known (a screen paints
 * first and works the figures out after).
 */
interface Remembered<A extends readonly unknown[], R> {
  (books: Books, ...args: A): R;
  peek(books: Books, ...args: A): R | undefined;
}
function remember<A extends readonly unknown[], R>(read: (books: Books, ...args: A) => R): Remembered<A, R> {
  const kept = new Map<string, { readonly from: readonly unknown[]; readonly value: R }>();
  const source = (books: Books): readonly unknown[] => [books, books.vouchers, books.lines, books.stock, books.masters];
  const peek = (books: Books, ...args: A): R | undefined => {
    const hit = kept.get(JSON.stringify(args));
    const from = source(books);
    return hit && hit.from.every((x, i) => x === from[i]) ? hit.value : undefined;
  };
  const get = (books: Books, ...args: A): R => {
    const known = peek(books, ...args);
    if (known !== undefined) return known;
    const value = read(books, ...args);
    if (kept.size > 40) kept.clear(); // a day's worth of lists at most: never a store that grows for ever
    kept.set(JSON.stringify(args), { from: source(books), value });
    return value;
  };
  return Object.assign(get, { peek });
}

/** The financial year `today` falls in (else the latest): where "this year" starts for stock. */
const yearStart = (books: Books, today: string): LocalDate => (books.masters.financialYearOn(day(today)) ?? books.masters.financialYears.at(-1))?.start ?? day(today);

// ---- Home ----------------------------------------------------------------------------------------------------------------

export interface HomeFigures {
  readonly receivable: Money;
  readonly receivableOverdue: Money;
  readonly payable: Money;
  readonly salesToday: Money;
  readonly salesThisMonth: Money;
  readonly topOverdue: readonly { readonly name: string; readonly overdue: Money; readonly oldestDays: number }[];
  readonly dueLines: readonly { readonly party: string; readonly item: string; readonly pending: string; readonly dueDate: string; readonly overdue: boolean }[];
}

export const homeFigures = remember(readHomeFigures);

function readHomeFigures(books: Books, today: string): HomeFigures {
  const { vouchers, lines, masters, orders } = books;
  const asOn = day(today);
  const digest = dailyDigest({ vouchers, lines, masters, orders, asOn, inboxWaiting: 0 });
  const payable = partyTotals(partyRows({ vouchers, lines, masters, side: 'payable', asOn }));
  // sales as the GST reports read them: invoices as billed, credit notes taken off
  const billed = (from: string): Money => money(gstInvoices({ vouchers, masters, side: 'sales', range: { from: day(from), to: asOn } }).reduce((t, i) => t + i.billed, 0n));
  return {
    receivable: digest.receivables.total,
    receivableOverdue: digest.receivables.overdue,
    payable: payable.pending,
    salesToday: billed(today),
    salesThisMonth: billed(`${today.slice(0, 8)}01`),
    topOverdue: digest.receivables.topOverdue,
    dueLines: digest.orders.lines.slice(0, 8).map((l) => ({ party: l.party, item: l.item, pending: l.pending, dueDate: l.dueDate, overdue: l.overdue })),
  };
}

// ---- Parties -------------------------------------------------------------------------------------------------------------

export interface PartyListRow {
  readonly partyId: string;
  readonly name: string;
  readonly roles: string;
  /** What the party owes us, and what we owe it (each the ledger's balance; zero when it has no such ledger). */
  readonly receivable: Money;
  readonly payable: Money;
  readonly overdueDays: number;
}

export const partyList = remember(readPartyList);

function readPartyList(books: Books, today: string): PartyListRow[] {
  const { vouchers, lines, masters } = books;
  const asOn = day(today);
  const by = (side: 'receivable' | 'payable') => new Map(partyRows({ vouchers, lines, masters, side, asOn }).map((r) => [r.partyId as string | undefined, r]));
  const owes = by('receivable');
  const owed = by('payable');
  return masters.parties
    .filter((p) => p.isActive)
    .map((p) => ({
      partyId: p.id,
      name: p.name,
      roles: (p.roles ?? []).map((r) => (r === 'customer' ? 'Customer' : 'Supplier')).join(' · '),
      receivable: owes.get(p.id)?.balance ?? money(0n),
      payable: owed.get(p.id)?.balance ?? money(0n),
      overdueDays: owes.get(p.id)?.oldest ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface PartySide {
  readonly balance: Money;
  readonly bills: readonly OutstandingBillRow[];
}

export interface PartyPage {
  readonly party: Party;
  readonly receivable: PartySide | undefined;
  readonly payable: PartySide | undefined;
  /** Its documents, newest first. */
  readonly documents: readonly DocRow[];
}

export function partyPage(books: Books, partyId: string, today: string): PartyPage | undefined {
  const { vouchers, lines, masters } = books;
  const party = masters.party(partyId as never);
  if (!party) return undefined;
  const asOn = day(today);
  const sideOf = (role: 'customer' | 'vendor'): PartySide | undefined => {
    if (!(party.roles ?? []).includes(role)) return undefined;
    const side = role === 'customer' ? 'receivable' : 'payable';
    const ledgerId = partyLedgerId(party.id, role) as LedgerId;
    const row = partyRows({ vouchers, lines, masters, side, asOn }).find((r) => r.ledgerId === ledgerId);
    return { balance: row?.balance ?? money(0n), bills: billRows({ vouchers, masters, side, asOn, ledgerId }) };
  };
  const mine = vouchers.filter((v) => (v.content as unknown as { partyId?: string }).partyId === partyId);
  return { party, receivable: sideOf('customer'), payable: sideOf('vendor'), documents: docRowsOf(books, mine, today).slice(0, 30) };
}

// ---- Items ---------------------------------------------------------------------------------------------------------------

export interface ItemListRow extends StockSummaryRow {
  readonly available: bigint;
}

/** Every active item that holds stock, with what the book holds of it today (an item never stocked shows as nothing). */
export const itemList = remember(readItemList);

function readItemList(books: Books, today: string): ItemListRow[] {
  const { masters, stock, orders } = books;
  const rows = stockSummaryRows(masters, stock, yearStart(books, today), day(today), orders);
  const seen = new Set(rows.map((r) => r.itemId));
  const none = { qty: 0n as never, value: 0n as never };
  const never: StockSummaryRow[] = masters.stockItems
    .filter((i) => i.isActive && i.itemType !== 'service' && !seen.has(i.id))
    .map((i) => {
      const unit = masters.unit(i.unitId);
      return { itemId: i.id, name: i.name, unit: unit?.symbol ?? '', decimals: unit?.decimals ?? 0, group: '', opening: none, inward: none, outward: none, closing: none, committed: 0n as never, onOrder: 0n as never };
    });
  return [...rows, ...never].map((r) => ({ ...r, available: availableOf(r) })).sort((a, b) => a.name.localeCompare(b.name));
}

export interface ItemPage {
  readonly row: ItemListRow;
  /** A service: it is billed, and holds no stock. */
  readonly service: boolean;
  readonly hsn: string;
  readonly godowns: readonly { readonly name: string; readonly qty: bigint }[];
  /** The latest movements, newest first. */
  readonly movements: readonly { readonly voucherId: string; readonly number: string; readonly date: string; readonly direction: 'in' | 'out'; readonly qty: bigint; readonly balance: bigint }[];
}

export function itemPage(books: Books, itemId: string, today: string): ItemPage | undefined {
  const { masters, stock } = books;
  const item = masters.stockItem(itemId as never);
  if (!item) return undefined;
  // a service holds no stock, so the Stock list leaves it out: its own page still opens, with nothing in it
  const unit = masters.unit(item.unitId);
  const nothing = { qty: 0n as never, value: 0n as never };
  const row: ItemListRow = itemList(books, today).find((r) => r.itemId === itemId) ?? {
    itemId: item.id, name: item.name, unit: unit?.symbol ?? '', decimals: unit?.decimals ?? 0, group: '',
    opening: nothing, inward: nothing, outward: nothing, closing: nothing, committed: 0n as never, onOrder: 0n as never, available: 0n,
  };
  const ledger = stock.ledger(item.id, yearStart(books, today), day(today));
  return {
    row,
    service: item.itemType === 'service',
    hsn: item.hsn ?? '',
    godowns: masters.warehouses.map((w) => ({ name: w.name, qty: stock.qtyAt(item.id, w.id, day(today)) as bigint })).filter((g) => g.qty !== 0n),
    movements: ledger.rows
      .slice(-25)
      .reverse()
      .map((r) => ({ voucherId: r.movement.voucherId, number: books.voucher(r.movement.voucherId)?.number ?? '', date: r.movement.date, direction: r.movement.direction, qty: r.movement.qty as bigint, balance: r.balance.qty as bigint })),
  };
}

// ---- Documents -----------------------------------------------------------------------------------------------------------

/** Transactions, grouped and named as on the desktop: each row is the list of that voucher type. */
export const TRANSACTION_GROUPS: readonly { readonly group: string; readonly lists: readonly { readonly kind: BaseKind; readonly title: string }[] }[] = [
  {
    group: 'Sales',
    lists: [
      { kind: 'sales', title: 'Sales Vouchers' },
      { kind: 'salesOrder', title: 'Sales Orders' },
      { kind: 'creditNote', title: 'Credit Notes' },
      { kind: 'quotation', title: 'Quotations' },
      { kind: 'deliveryChallan', title: 'Delivery Challans' },
    ],
  },
  {
    group: 'Purchase',
    lists: [
      { kind: 'purchase', title: 'Purchase Vouchers' },
      { kind: 'purchaseOrder', title: 'Purchase Orders' },
      { kind: 'debitNote', title: 'Debit Notes' },
      { kind: 'returnableChallan', title: 'Returnable Challans' },
    ],
  },
  {
    group: 'General',
    lists: [
      { kind: 'payment', title: 'Payment Vouchers' },
      { kind: 'receipt', title: 'Receipt Vouchers' },
      { kind: 'contra', title: 'Contra Vouchers' },
      { kind: 'journal', title: 'Journal Vouchers' },
    ],
  },
];

export const listTitleOf = (kind: BaseKind): string => TRANSACTION_GROUPS.flatMap((g) => g.lists).find((l) => l.kind === kind)?.title ?? 'Vouchers';

// ---- Go To: one box on the Gateway that finds a party, an item or a voucher by its number --------------------------------------

export interface GoToHit {
  readonly key: string;
  readonly title: string;
  readonly sub: string;
  readonly open: { readonly page: 'party'; readonly partyId: string } | { readonly page: 'item'; readonly itemId: string } | { readonly page: 'doc'; readonly voucherId: string };
}

export function goToHits(books: Books, text: string, limit = 25): GoToHit[] {
  const t = text.trim().toLowerCase();
  if (t.length < 2) return [];
  const has = (...fields: (string | undefined)[]) => fields.some((f) => (f ?? '').toLowerCase().includes(t));
  const { masters } = books;
  const hits: GoToHit[] = [];
  for (const p of masters.parties) {
    if (p.isActive && has(p.name, p.gstin, p.phone)) hits.push({ key: `p:${p.id}`, title: p.name, sub: 'Party', open: { page: 'party', partyId: p.id } });
  }
  for (const i of masters.stockItems) {
    if (i.isActive && has(i.name, i.code, i.hsn)) hits.push({ key: `i:${i.id}`, title: i.name, sub: 'Stock item', open: { page: 'item', itemId: i.id } });
  }
  // vouchers by number, newest first
  for (let k = books.vouchers.length - 1; k >= 0 && hits.length < limit * 2; k--) {
    const v = books.vouchers[k] as Voucher;
    if (has(v.number)) hits.push({ key: `v:${v.id}`, title: v.number, sub: `${masters.voucherType(v.voucherTypeId)?.name ?? 'Voucher'} · ${v.date}`, open: { page: 'doc', voucherId: v.id } });
  }
  return hits.slice(0, limit);
}

export type DocRow = VoucherListRow;

/** One voucher type's list, newest first — the desktop list's own rows (status, pending and all). */
export const docList = remember(readDocList);

function readDocList(books: Books, kind: BaseKind, today: string): DocRow[] {
  const { vouchers, lines, masters, orders } = books;
  return voucherListRows({ vouchers, lines, masters, orders, kind, asOf: day(today) }).reverse();
}

/** These vouchers as list rows, whatever their types, newest first. */
function docRowsOf(books: Books, vouchers: readonly Voucher[], today: string): DocRow[] {
  const { lines, masters, orders } = books;
  const kinds = new Set(vouchers.map((v) => masters.voucherType(v.voucherTypeId)?.baseKind).filter((k): k is BaseKind => k !== undefined));
  const ids = new Set(vouchers.map((v) => v.id as string));
  return [...kinds]
    .flatMap((kind) => voucherListRows({ vouchers: books.vouchers, lines, masters, orders, kind, asOf: day(today) }))
    .filter((r) => ids.has(r.voucherId))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.number < b.number ? 1 : -1));
}

export interface DocView {
  readonly voucher: Voucher;
  readonly typeName: string;
  readonly baseKind: BaseKind | undefined;
  /** An item document (invoice, order, quote, challan, note): the form and the engine's own figures for it. */
  readonly item: { readonly kind: ItemDocKind; readonly form: SalesForm; readonly preview: SalesPreview } | undefined;
  /** What it posted, for a voucher that is not an item document — and for the curious on one that is. */
  readonly journal: readonly { readonly ledger: string; readonly side: 'debit' | 'credit'; readonly amount: Money }[];
  readonly bill: { readonly total: Money; readonly settled: Money; readonly pending: Money } | undefined;
}

export function docView(books: Books, voucherId: string): DocView | undefined {
  const voucher = books.voucher(voucherId);
  if (!voucher) return undefined;
  const { masters } = books;
  const type = masters.voucherType(voucher.voucherTypeId);
  const kind = salesKindOf(masters, voucher.voucherTypeId);
  const form = kind ? salesFormFromVoucher(voucher, masters, books.orders) : undefined;
  return {
    voucher,
    typeName: type?.name ?? 'Voucher',
    baseKind: type?.baseKind,
    item: kind && form ? { kind, form, preview: previewSales(form, kind, masters, books.stock, books.orders, undefined, books.vouchers) } : undefined,
    journal: books.lines.filter((l) => l.voucherId === voucher.id).map((l) => ({ ledger: masters.ledger(l.ledgerId)?.name ?? '', side: l.side, amount: l.amount })),
    bill: billStatusOf(voucher, books.vouchers, masters),
  };
}
