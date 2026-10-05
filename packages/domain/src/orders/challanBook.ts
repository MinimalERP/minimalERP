import type { LocalDate } from '../dates';
import type { PartyId, StockItemId, VoucherId } from '../ids';
import { type Qty, type Rate, ZERO_QTY, parseQty, parseRate, qty } from '../stock/quantity';
import type { Voucher } from '../vouchers/voucher';

/**
 * THE CHALLAN BOOK — what went out on delivery challans and what has been invoiced against them. Like the order book it is DERIVED from
 * posted vouchers and stores nothing: a challan says what left, each posted sales invoice line that names a challan line bills (part of) it,
 * and what is pending is the difference. A cancelled invoice is simply not in the book, so cancelling it makes the challan pending again.
 */

/**
 * Why the goods go out on a delivery challan. One voucher type and one number series serve both; the purpose decides what may follow:
 *   sale — to a customer, to be invoiced later (the goods leave now, the bill comes after);
 *   foc  — to a customer free of cost: it is never invoiced.
 */
export const CHALLAN_PURPOSES = ['sale', 'foc'] as const;
export type ChallanPurpose = (typeof CHALLAN_PURPOSES)[number];

export interface ChallanLineDoc {
  readonly id: string;
  readonly itemId: StockItemId;
  readonly qty: Qty;
  readonly rate: Rate;
  readonly gstRate?: string | undefined;
  readonly hsn?: string | undefined;
}

export interface ChallanDoc {
  readonly voucherId: VoucherId;
  readonly number: string;
  readonly date: LocalDate;
  readonly partyId: PartyId;
  /** The customer's PO, if the challan names one. */
  readonly reference?: string | undefined;
  readonly purpose: ChallanPurpose;
  readonly lines: readonly ChallanLineDoc[];
}

/** One invoice line billing (part of) one challan line. */
export interface ChallanLink {
  /** The sales invoice. */
  readonly voucherId: VoucherId;
  readonly date: LocalDate;
  readonly challanId: VoucherId;
  readonly challanLineId: string;
  readonly itemId: StockItemId;
  readonly qty: Qty;
}

export interface ChallanLineStatus {
  readonly line: ChallanLineDoc;
  readonly sent: Qty;
  readonly invoiced: Qty;
  readonly pending: Qty;
}

/** Where a challan stands: free of cost (never invoiced), still to invoice, partly invoiced, or invoiced in full. */
export type ChallanStatus = 'foc' | 'toInvoice' | 'partlyInvoiced' | 'invoiced';

export interface ChallanState {
  readonly challan: ChallanDoc;
  readonly status: ChallanStatus;
  readonly lines: readonly ChallanLineStatus[];
}

/** A returnable challan (goods sent to a supplier, to come back as they went): what went out, to be brought back by its return. */
export interface ReturnableDoc {
  readonly voucherId: VoucherId;
  readonly number: string;
  readonly date: LocalDate;
  readonly partyId: PartyId;
  readonly lines: readonly { readonly itemId: StockItemId; readonly warehouseId: string; readonly qty: Qty }[];
}

/** The return of a returnable challan: the voucher that brought its goods back. */
export interface ReturnDoc {
  readonly voucherId: VoucherId;
  readonly number: string;
  readonly returnOf: VoucherId;
}

export interface ChallanChange {
  /** Invoices whose billing leaves the book (an invoice being altered or cancelled frees what it had billed). */
  readonly removeLinksOf?: readonly VoucherId[] | undefined;
  readonly removeChallans?: readonly VoucherId[] | undefined;
}

const keyOf = (challanId: string, lineId: string): string => `${challanId}|${lineId}`;

export class ChallanBook {
  private readonly byId: ReadonlyMap<VoucherId, ChallanDoc>;
  private readonly invoiced: ReadonlyMap<string, bigint>;
  private readonly byChallan: ReadonlyMap<VoucherId, readonly ChallanLink[]>;

  constructor(
    readonly challans: readonly ChallanDoc[] = [],
    readonly links: readonly ChallanLink[] = [],
    /** Returnable challans, and the returns that brought them back. */
    readonly returnables: readonly ReturnableDoc[] = [],
    readonly returns: readonly ReturnDoc[] = [],
  ) {
    this.byId = new Map(challans.map((c) => [c.voucherId, c]));
    const totals = new Map<string, bigint>();
    const grouped = new Map<VoucherId, ChallanLink[]>();
    for (const l of links) {
      const k = keyOf(l.challanId, l.challanLineId);
      totals.set(k, (totals.get(k) ?? 0n) + l.qty);
      const list = grouped.get(l.challanId);
      if (list) list.push(l);
      else grouped.set(l.challanId, [l]);
    }
    this.invoiced = totals;
    this.byChallan = grouped;
  }

  static readonly empty = new ChallanBook();

  withChange(change: ChallanChange): ChallanBook {
    const goneChallans = new Set(change.removeChallans ?? []);
    const goneLinks = new Set(change.removeLinksOf ?? []);
    if (goneChallans.size === 0 && goneLinks.size === 0) return this;
    return new ChallanBook(
      this.challans.filter((c) => !goneChallans.has(c.voucherId)),
      this.links.filter((l) => !goneLinks.has(l.voucherId)),
      this.returnables.filter((c) => !goneChallans.has(c.voucherId)),
      this.returns.filter((r) => !goneLinks.has(r.voucherId)),
    );
  }

  returnable(id: VoucherId): ReturnableDoc | undefined {
    return this.returnables.find((c) => c.voucherId === id);
  }

  /** The return that brought a returnable challan back, if it has come back. */
  returnOf(challanId: VoucherId): ReturnDoc | undefined {
    return this.returns.find((r) => r.returnOf === challanId);
  }

  challan(id: VoucherId): ChallanDoc | undefined {
    return this.byId.get(id);
  }

  /** Every invoice line billed against a challan — also for a challan that is not (or no longer) in this book. */
  linksTo(challanId: VoucherId): readonly ChallanLink[] {
    return this.byChallan.get(challanId) ?? [];
  }

  invoicedOn(challanId: VoucherId, lineId: string): Qty {
    return qty(this.invoiced.get(keyOf(challanId, lineId)) ?? 0n);
  }

  state(challanId: VoucherId): ChallanState | undefined {
    const challan = this.byId.get(challanId);
    if (!challan) return undefined;
    const lines = challan.lines.map((line): ChallanLineStatus => {
      const invoiced = this.invoicedOn(challanId, line.id);
      return { line, sent: line.qty, invoiced, pending: line.qty > invoiced ? qty(line.qty - invoiced) : ZERO_QTY };
    });
    const status: ChallanStatus =
      challan.purpose === 'foc'
        ? 'foc'
        : lines.every((l) => l.pending === 0n)
          ? 'invoiced'
          : lines.some((l) => l.invoiced > 0n)
            ? 'partlyInvoiced'
            : 'toInvoice';
    return { challan, status, lines };
  }

  /** Every challan, oldest first (date, then id). */
  all(): readonly ChallanState[] {
    return [...this.challans]
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.voucherId < b.voucherId ? -1 : a.voucherId > b.voucherId ? 1 : 0))
      .map((c) => this.state(c.voucherId) as ChallanState);
  }
}

// ---- reading the book out of posted vouchers --------------------------------------------------------------------------

/** A posted returnable challan as the book sees it — a challan that went out, or a return that brought one back. */
export function returnableOf(voucher: Voucher): { readonly challan?: ReturnableDoc; readonly back?: ReturnDoc } {
  const c = voucher.content as unknown as { partyId?: string; returnOf?: string; lines?: { itemId?: string; warehouseId?: string; qty?: string }[] };
  if (typeof c.returnOf === 'string') return { back: { voucherId: voucher.id, number: voucher.number, returnOf: c.returnOf as VoucherId } };
  if (typeof c.partyId !== 'string' || !Array.isArray(c.lines)) return {};
  const lines = c.lines.flatMap((l) => {
    const q = typeof l.qty === 'string' ? parseQty(l.qty) : undefined;
    return typeof l.itemId === 'string' && typeof l.warehouseId === 'string' && q !== undefined ? [{ itemId: l.itemId as StockItemId, warehouseId: l.warehouseId, qty: q }] : [];
  });
  return { challan: { voucherId: voucher.id, number: voucher.number, date: voucher.date, partyId: c.partyId as PartyId, lines } };
}

interface ChallanContent {
  partyId?: string;
  reference?: string;
  purpose?: string;
  lines?: { id?: string; itemId?: string; qty?: string; rate?: string; gstRate?: string; hsn?: string; challanRef?: { challanId?: string; lineId?: string } }[];
}

/**
 * A posted delivery challan as the book sees it (or undefined if what is stored is not one). A written line (no item: a non-stock extra
 * that went out with the shipment, printed on the challan alone) is left out — it moves no stock and is never billed against.
 */
export function challanDocOf(voucher: Voucher): ChallanDoc | undefined {
  const c = voucher.content as unknown as ChallanContent;
  if (typeof c.partyId !== 'string' || !Array.isArray(c.lines)) return undefined;
  const lines: ChallanLineDoc[] = [];
  for (const l of c.lines) {
    if (typeof l.itemId !== 'string') continue;
    const q = typeof l.qty === 'string' ? parseQty(l.qty) : undefined;
    const r = typeof l.rate === 'string' ? parseRate(l.rate) : undefined;
    if (typeof l.id !== 'string' || q === undefined || r === undefined) return undefined;
    lines.push({ id: l.id, itemId: l.itemId as StockItemId, qty: q, rate: r, gstRate: l.gstRate, hsn: l.hsn });
  }
  return {
    voucherId: voucher.id,
    number: voucher.number,
    date: voucher.date,
    partyId: c.partyId as PartyId,
    reference: c.reference === undefined || c.reference === '' ? undefined : c.reference,
    purpose: c.purpose === 'foc' ? 'foc' : 'sale',
    lines,
  };
}

/** What a posted sales invoice bills against challans: one link per line that names a challan line. */
export function challanLinksOf(voucher: Voucher): ChallanLink[] {
  const c = voucher.content as unknown as ChallanContent;
  const out: ChallanLink[] = [];
  for (const l of c.lines ?? []) {
    const ref = l.challanRef;
    const q = typeof l.qty === 'string' ? parseQty(l.qty) : undefined;
    if (!ref || typeof ref.challanId !== 'string' || typeof ref.lineId !== 'string' || typeof l.itemId !== 'string' || q === undefined) continue;
    out.push({ voucherId: voucher.id, date: voucher.date, challanId: ref.challanId as VoucherId, challanLineId: ref.lineId, itemId: l.itemId as StockItemId, qty: q });
  }
  return out;
}
