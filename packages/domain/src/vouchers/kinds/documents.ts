import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import type { LedgerId, PartyId, StockItemId, VoucherId } from '../../ids';
import type { Masters } from '../../masters/masters';
import { partyLedgerId } from '../../masters/records';
import { MAX_MONEY, type Money, ZERO, addMoney } from '../../money';
import type { OrderBook, PlannedLink } from '../../orders/orderBook';
import { formatQty, parseQty, parseRate, valueOf } from '../../stock/quantity';
import { type PartyDetails, ledgerIdSchema, localDateSchema, voucherIdSchema } from '../drafts';
import { percentSchema } from '../../gst/tax';
import { itemIdSchema, qtySchema, rateSchema, warehouseIdSchema } from './stockJournal';

/**
 * What Sales Orders and Sales Invoices share (ADR-0015): the shape of an item line, the customer checks, and the rules for filling an
 * order line from an invoice line. Quantities and rates travel as canonical text, exactly as in the Stock Journal.
 */

export const partyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .transform((s) => s as PartyId);

/** An order line's identity inside its order: chosen when the line is created and never reused, so deliveries keep pointing at it. */
const lineIdSchema = z.string().trim().min(1).max(40);

/** The customer's own reference for the document (their PO number). */
const referenceSchema = z.string().trim().max(60).optional();

export const orderLineSchema = z.object({
  id: lineIdSchema,
  itemId: itemIdSchema,
  qty: qtySchema,
  rate: rateSchema,
  /** When this line is wanted: each line of an order has its own. */
  dueDate: localDateSchema,
});
export type OrderLine = z.output<typeof orderLineSchema>;

export const orderRefSchema = z.object({ orderId: voucherIdSchema, lineId: lineIdSchema });
export type OrderRef = z.output<typeof orderRefSchema>;

export const invoiceLineSchema = z.object({
  /** The stock item — or, on a one-time line, none: then `description` says what it is (a job charge, freight, a one-off part). */
  itemId: itemIdSchema.optional(),
  /** A ONE-TIME line: written text instead of a stock item. It is billed and taxed like any line and moves no stock. */
  description: z.string().trim().min(1).max(200).optional(),
  /** A one-time line's unit (a unit master's symbol: "Nos", "Kg"…), for the printed invoice and GST's unit code. */
  unit: z.string().trim().min(1).max(20).optional(),
  /** Where the goods leave (sales) or arrive (purchase); a one-time line has none. */
  warehouseId: warehouseIdSchema.optional(),
  qty: qtySchema,
  rate: rateSchema,
  /** The order line this delivery fills, if it is against an order. */
  orderRef: orderRefSchema.optional(),
  /** The GST rate this line is charged at (a percentage): filled from the item, and changeable on the line. Absent = not taxed. */
  gstRate: percentSchema.optional(),
  /** The item's HSN / SAC code as it was when the invoice was made, so the GST reports read it from the invoice, not from an item that may change. */
  hsn: z.string().trim().max(10).optional(),
});
export type InvoiceLine = z.output<typeof invoiceLineSchema>;

export const documentShape = {
  partyId: partyIdSchema,
  reference: referenceSchema,
};

export const salesLedgerIdSchema = ledgerIdSchema;

/** What a line comes to: quantity × rate, to the paisa. */
export const lineValue = (l: { qty: string; rate: string }): Money => valueOf(parseQty(l.qty) ?? (0n as never), parseRate(l.rate) ?? (0n as never));

export const invoiceTotal = (lines: readonly { qty: string; rate: string }[]): Money => lines.reduce<Money>((sum, l) => addMoney(sum, lineValue(l)), ZERO);

/** The party's receivable ledger — where an invoice is debited. */
export const customerLedgerOf = (partyId: PartyId): LedgerId => partyLedgerId(partyId, 'customer') as LedgerId;

/** The party's payable ledger — where a purchase invoice is credited. */
export const vendorLedgerOf = (partyId: PartyId): LedgerId => partyLedgerId(partyId, 'vendor') as LedgerId;

/** Which way a document faces: the customer's (sales) or the supplier's (purchase). It decides the wording of the checks, nothing else. */
export type DocSide = 'sales' | 'purchase';
const WORDS: Record<DocSide, { role: 'customer' | 'vendor'; who: string; roleName: string; order: string; doc: string; done: string; doing: string }> = {
  sales: { role: 'customer', who: 'customer', roleName: 'Customer', order: 'sales order', doc: 'sales', done: 'delivered', doing: 'delivering' },
  purchase: { role: 'vendor', who: 'supplier', roleName: 'Vendor', order: 'purchase order', doc: 'purchase', done: 'received', doing: 'receiving' },
};

/**
 * The customer of a sales document: a real, active party that is a customer, and the party-details snapshot filled in for THIS party
 * (required on every sales document). A customer always has its receivable ledger — ADR-0013 keeps a party's ledgers in step with its
 * roles — so the ledger itself is not looked up here.
 */
export function customerProblems(
  draft: { partyId: PartyId; partyDetails?: PartyDetails | undefined },
  masters: Masters,
): Issue[] {
  return partyProblems(draft, masters, 'customer');
}

/** The same checks for the party of either side: a real, active party with the role the document needs, and its details snapshot. */
export function partyProblems(
  draft: { partyId: PartyId; partyDetails?: PartyDetails | undefined },
  masters: Masters,
  role: 'customer' | 'vendor',
): Issue[] {
  const w = WORDS[role === 'customer' ? 'sales' : 'purchase'];
  const problems: Issue[] = [];
  const party = masters.party(draft.partyId);
  if (!party) problems.push(issue(IssueCode.SalesDocInvalid, `Choose the ${w.who}`, 'partyId'));
  else {
    if (!party.isActive) problems.push(issue(IssueCode.SalesDocInvalid, `"${party.name}" is inactive`, 'partyId'));
    if (!(party.roles ?? []).includes(role)) {
      problems.push(issue(IssueCode.SalesDocInvalid, `"${party.name}" is not a ${role === 'customer' ? 'customer' : 'vendor'}: give the party the ${w.roleName} role first`, 'partyId'));
    }
  }
  if (draft.partyDetails === undefined) {
    problems.push(issue(IssueCode.PartyDetailsInvalid, `Fill in the party details (Alt+P): a ${w.doc} document needs them`, 'partyDetails'));
  } else if (draft.partyDetails.partyId !== draft.partyId) {
    problems.push(issue(IssueCode.PartyDetailsInvalid, 'The party details belong to another party: open them again (Alt+P)', 'partyDetails'));
  }
  return problems;
}

/** The stock lines of an invoice, each with its place on the invoice (a one-time line moves no stock, so it has no entry). */
export function itemLinesOf<L extends { itemId?: string | undefined }>(lines: readonly L[]): { line: L & { itemId: StockItemId }; at: number }[] {
  return lines.flatMap((l, at) => (l.itemId !== undefined ? [{ line: l as L & { itemId: StockItemId }, at }] : []));
}

/** Problems found on the stock lines alone ("lines.1") put back on their place on the invoice ("lines.3"). */
export function onInvoiceLines(problems: readonly Issue[], places: readonly number[]): Issue[] {
  return problems.map((p) => {
    const m = /^lines\.(\d+)(\..*)?$/.exec(p.path ?? '');
    const at = m ? places[Number(m[1])] : undefined;
    return m && at !== undefined ? { ...p, path: `lines.${at}${m[2] ?? ''}` } : p;
  });
}

/**
 * A line is either a stock item or a written one-time line, never both or neither. A one-time line needs its text, a quantity and a rate,
 * and cannot fill an order line (orders are of stock items).
 */
export function lineKindProblems(l: InvoiceLine, path: string): Issue[] {
  if (l.itemId !== undefined && l.description !== undefined) return [issue(IssueCode.SalesDocInvalid, 'A line is either a stock item or written text, not both', `${path}.itemId`)];
  if (l.itemId === undefined && l.description === undefined) return [issue(IssueCode.SalesDocInvalid, 'Choose a stock item — or write the line and press Alt+T', `${path}.itemId`)];
  if (l.itemId !== undefined) {
    const out: Issue[] = [];
    if (l.warehouseId === undefined) out.push(issue(IssueCode.StockLineInvalid, 'Choose the godown', `${path}.warehouseId`));
    if (l.unit !== undefined) out.push(issue(IssueCode.SalesDocInvalid, 'A stock item line takes the unit of its item', `${path}.unit`));
    return out;
  }
  const problems: Issue[] = [];
  const q = parseQty(l.qty) ?? 0n;
  if (q <= 0n) problems.push(issue(IssueCode.StockLineInvalid, 'Enter a quantity above zero', `${path}.qty`));
  if (l.orderRef) problems.push(issue(IssueCode.OrderRefInvalid, 'A written line cannot be against an order line', `${path}.orderRef`));
  return problems;
}

/** A line's value must fit what the books hold. */
export function lineValueProblems(l: { qty: string; rate: string }, path: string): Issue[] {
  return lineValue(l) > MAX_MONEY ? [issue(IssueCode.AmountTooLarge, 'That line comes to more than the books can hold', `${path}.rate`)] : [];
}

const shown = (masters: Masters, itemId: StockItemId, q: bigint): string => {
  const item = masters.stockItem(itemId);
  const unit = item ? masters.unit(item.unitId) : undefined;
  return `${formatQty(q as never, unit?.decimals ?? 0)}${unit ? ` ${unit.symbol}` : ''}`;
};

/**
 * Every invoice line that names an order line must be one it can fill: the order exists, is the same customer's, is not closed, has that
 * line for the same item, is not dated after the invoice — and (over-delivery is refused) no more is delivered than is pending, counting
 * the invoice's own other lines against the same order line. Problems sit on the exact line and cell.
 */
export function deliveryProblems(
  draft: { partyId: PartyId; date: string; lines: readonly InvoiceLine[] },
  masters: Masters,
  orders: OrderBook,
  side: DocSide = 'sales',
): Issue[] {
  const w = WORDS[side];
  const problems: Issue[] = [];
  const taken = new Map<string, bigint>();
  draft.lines.forEach((l, i) => {
    const ref = l.orderRef;
    if (!ref) return;
    const path = `lines.${i}.orderRef`;
    const state = orders.state(ref.orderId as VoucherId);
    if (!state) {
      problems.push(issue(IssueCode.OrderRefInvalid, `That ${w.order} does not exist (or was cancelled)`, path));
      return;
    }
    const order = state.order;
    if (order.side !== side) {
      problems.push(issue(IssueCode.OrderRefInvalid, `${order.number} is not a ${w.order}`, path));
      return;
    }
    if (order.partyId !== draft.partyId) {
      problems.push(issue(IssueCode.OrderRefInvalid, `${order.number} belongs to another ${w.who}`, path));
      return;
    }
    if (order.closed) {
      problems.push(issue(IssueCode.OrderRefInvalid, `${order.number} is closed: nothing more can be ${w.done} against it`, path));
      return;
    }
    if (draft.date < order.date) {
      problems.push(issue(IssueCode.OrderRefInvalid, `This invoice is dated before ${order.number} (${order.date})`, path));
      return;
    }
    const line = state.lines.find((s) => s.line.id === ref.lineId);
    if (l.itemId === undefined) return; // a written line cannot fill an order line: lineKindProblems says so
    if (!line) {
      problems.push(issue(IssueCode.OrderRefInvalid, `${order.number} has no such line any more`, path));
      return;
    }
    if (line.line.itemId !== l.itemId) {
      const wanted = masters.stockItem(line.line.itemId)?.name ?? 'another item';
      problems.push(issue(IssueCode.OrderRefInvalid, `That line of ${order.number} is for ${wanted}`, path));
      return;
    }
    const key = `${ref.orderId}|${ref.lineId}`;
    const before = taken.get(key) ?? 0n;
    const q = parseQty(l.qty) ?? 0n;
    const pending = line.pending - before;
    if (q > pending) {
      const left = pending > 0n ? pending : 0n;
      problems.push(
        issue(
          IssueCode.OverDelivery,
          left === 0n
            ? `${order.number}: already ${w.done} in full — you are ${w.doing} ${shown(masters, l.itemId, q)}`
            : `${order.number}: ${shown(masters, l.itemId, left)} pending, you are ${w.doing} ${shown(masters, l.itemId, q)}`,
          `lines.${i}.qty`,
        ),
      );
    }
    taken.set(key, before + q);
  });
  return problems;
}

/** The deliveries an invoice makes: one per line that names an order line, sitting on that line's number. */
export function plannedLinksOf(lines: readonly InvoiceLine[]): PlannedLink[] {
  const out: PlannedLink[] = [];
  // numbered like the invoice's stock lines (1..n over the item lines): a written line moves no stock and fills no order
  itemLinesOf(lines).forEach(({ line: l }, k) => {
    if (!l.orderRef) return;
    out.push({
      lineNo: k + 1,
      orderId: l.orderRef.orderId as VoucherId,
      orderLineId: l.orderRef.lineId,
      itemId: l.itemId,
      qty: parseQty(l.qty) ?? (0n as never),
    });
  });
  return out;
}
