import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import type { StockItemId, WarehouseId } from '../../ids';
import type { Masters } from '../../masters/masters';
import type { StockBook } from '../../stock/book';
import type { PlannedStock, StockDirection, StockMovement } from '../../stock/movement';
import { MAX_QTY, decimalsUsed, formatQty, isQtyText, parseQty, parseRate, qtyText, rateText, valueOf } from '../../stock/quantity';
import { draftBaseShape, narrationSchema } from '../drafts';
import { defineVoucherKind } from '../kind';

/**
 * Stock Journal: stock moving with NO accounting effect — a transfer between godowns (an Out and an In of one item), a conversion
 * (Out the raw material, In the finished goods), an adjustment. Debit = stock IN, Credit = stock OUT, as on a journal.
 *
 * An In carries a rate (its value is quantity × rate). An Out carries none: the book values it at the item's moving weighted average of
 * the day. Quantities and rates travel as text ("10", "58.5") in their canonical four-place form, because JSON has no bigint and a
 * draft is stored exactly as posted.
 */
export const qtySchema = z
  .string()
  .trim()
  .refine(isQtyText, 'Enter a quantity such as 10 or 2.5')
  .transform((t) => qtyText(parseQty(t) ?? 0n as never));
export const rateSchema = z
  .string()
  .trim()
  .refine((t) => parseRate(t) !== undefined, 'Enter a rate such as 58 or 58.25')
  .transform((t) => rateText(parseRate(t) ?? 0n as never));

export const itemIdSchema = z.string().min(1).max(128).transform((s) => s as StockItemId);
export const warehouseIdSchema = z.string().min(1).max(128).transform((s) => s as WarehouseId);

export const stockEntrySchema = z.object({
  itemId: itemIdSchema,
  warehouseId: warehouseIdSchema,
  direction: z.enum(['in', 'out']),
  qty: qtySchema,
  rate: rateSchema.optional(),
  narration: narrationSchema,
});

export const stockJournalDraftSchema = z.object({
  ...draftBaseShape,
  entries: z.array(stockEntrySchema),
});
export type StockJournalDraft = z.output<typeof stockJournalDraftSchema>;
export type StockEntry = z.output<typeof stockEntrySchema>;

/**
 * The problems with a stock entry that do not depend on the rest of the books: does the item exist, may it hold stock, is the godown
 * real, does the quantity fit the unit, does an In have a rate and an Out none. (Shared by the Stock Journal and opening stock.)
 */
export function stockEntryProblems(
  e: { itemId: StockItemId; warehouseId: WarehouseId; direction: StockDirection; qty: string; rate?: string | undefined },
  masters: Masters,
  path: string,
): Issue[] {
  const at = (field: string): string => (path === '' ? field : `${path}.${field}`);
  const problems: Issue[] = itemQtyProblems(e.itemId, e.qty, masters, path);
  const warehouse = masters.warehouse(e.warehouseId);
  if (!warehouse) problems.push(issue(IssueCode.StockLineInvalid, 'That godown does not exist', at('warehouseId')));
  else if (!warehouse.isActive) problems.push(issue(IssueCode.StockLineInvalid, `Godown "${warehouse.name}" is inactive`, at('warehouseId')));
  if (e.direction === 'in' && e.rate === undefined) {
    problems.push(issue(IssueCode.StockLineInvalid, 'Stock coming in needs a rate (0 for a free issue)', at('rate')));
  }
  if (e.direction === 'out' && e.rate !== undefined) {
    problems.push(issue(IssueCode.StockLineInvalid, 'Stock going out takes its value from the stock — leave the rate empty', at('rate')));
  }
  return problems;
}

/**
 * The item and quantity of any stock line: the item exists, is active and holds stock, and the quantity is above zero, fits what the
 * books can hold and uses no more decimals than the item's unit allows. (Shared by every kind that names an item and a quantity.)
 */
export function itemQtyProblems(itemId: StockItemId, quantity: string, masters: Masters, path: string): Issue[] {
  const problems: Issue[] = [];
  const at = (field: string): string => (path === '' ? field : `${path}.${field}`);
  const item = masters.stockItem(itemId);
  if (!item) problems.push(issue(IssueCode.StockLineInvalid, 'That stock item does not exist', at('itemId')));
  else {
    if (!item.isActive) problems.push(issue(IssueCode.StockLineInvalid, `"${item.name}" is inactive`, at('itemId')));
    if (item.itemType === 'service') problems.push(issue(IssueCode.StockLineInvalid, `"${item.name}" is a service: it has no stock`, at('itemId')));
  }
  const q = parseQty(quantity) ?? 0n;
  if (q <= 0n) problems.push(issue(IssueCode.StockLineInvalid, 'Enter a quantity above zero', at('qty')));
  else if (q > MAX_QTY) problems.push(issue(IssueCode.AmountTooLarge, 'That quantity is more than the books can hold', at('qty')));
  else if (item) {
    const unit = masters.unit(item.unitId);
    if (unit && decimalsUsed(q as never) > unit.decimals) {
      problems.push(
        issue(
          IssueCode.StockLineInvalid,
          unit.decimals === 0 ? `${item.name} is counted in whole ${unit.symbol}` : `${item.name} takes at most ${unit.decimals} decimal places (${unit.symbol})`,
          at('qty'),
        ),
      );
    }
  }
  return problems;
}

/** Turns entries into planned movements (the engine stamps voucher id, line number and date). */
export function plannedStockOf(entries: readonly StockEntry[]): PlannedStock[] {
  return entries.map((e) => {
    const q = parseQty(e.qty) ?? (0n as never);
    return {
      itemId: e.itemId,
      warehouseId: e.warehouseId,
      direction: e.direction,
      qty: q,
      ...(e.direction === 'in' ? { value: valueOf(q, parseRate(e.rate ?? '0') ?? (0n as never)) } : {}),
    };
  });
}

/**
 * Would these movements, added to the company's stock, take any item below zero in a godown on any day? Each shortfall becomes an issue —
 * on the entry line when it is this voucher that goes short, otherwise a general one (a back-dated In can make a later voucher fail).
 */
export function shortfallProblems(
  entries: readonly StockEntry[],
  voucherId: StockMovement['voucherId'],
  date: StockMovement['date'],
  masters: Masters,
  stock: StockBook,
  path: string,
): Issue[] {
  const planned = plannedStockOf(entries);
  const provisional: StockMovement[] = planned.map((p, i) => ({ ...p, voucherId, lineNo: i + 1, date }));
  const touched = [...new Set(entries.map((e) => e.itemId))];
  const problems: Issue[] = [];
  for (const s of stock.withChange({ add: provisional }).shortfalls(touched)) {
    const item = masters.stockItem(s.itemId);
    const unit = item ? masters.unit(item.unitId) : undefined;
    const godown = masters.warehouse(s.warehouseId)?.name ?? 'the godown';
    const amount = `${formatQty(s.short, unit?.decimals ?? 0)} ${unit?.symbol ?? ''}`.trim();
    const mine = s.voucherId === voucherId;
    // where the item IS on that day, when it is not in this godown: the usual reason for "not enough"
    const elsewhere = masters.warehouses
      .filter((w) => w.id !== s.warehouseId && w.isActive)
      .map((w) => ({ name: w.name, held: stock.withChange({ add: provisional }).qtyAt(s.itemId, w.id, s.date) }))
      .filter((w) => w.held > 0n)
      .map((w) => `${w.name} ${formatQty(w.held, unit?.decimals ?? 0)}`);
    const where = mine && elsewhere.length > 0 ? ` It is in ${elsewhere.join(', ')}.` : '';
    const line = mine ? s.lineNo - 1 : entries.findIndex((e) => e.itemId === s.itemId && e.warehouseId === s.warehouseId);
    problems.push(
      issue(
        IssueCode.StockNegative,
        mine
          ? `Not enough ${item?.name ?? 'stock'} in ${godown}: this is ${amount} more than there is on ${s.date}.${where}`
          : `This would leave ${item?.name ?? 'stock'} in ${godown} ${amount} short on ${s.date}, when a later entry needs it`,
        line >= 0 ? (path === '' ? 'qty' : `${path}.${line}.qty`) : path,
      ),
    );
  }
  return problems;
}

export const stockJournalKind = defineVoucherKind<StockJournalDraft>({
  base: 'stockJournal',
  layout: 'stock',
  schema: stockJournalDraftSchema,

  ledgerRefs: () => [],

  validate(draft, { masters, stock }) {
    const problems: Issue[] = [];
    if (draft.entries.length === 0) {
      problems.push(issue(IssueCode.TooFewLines, 'A stock journal needs at least one line', 'entries'));
    }
    draft.entries.forEach((e, i) => problems.push(...stockEntryProblems(e, masters, `entries.${i}`)));
    if (problems.length > 0) return problems;
    return shortfallProblems(draft.entries, draft.id, draft.date, masters, stock, 'entries');
  },

  post: () => [],
  postStock: (draft) => plannedStockOf(draft.entries),
  stockItems: (draft) => [...new Set(draft.entries.map((e) => e.itemId))],
});
