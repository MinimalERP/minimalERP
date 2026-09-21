import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import type { VoucherId } from '../../ids';
import { formatQty, parseQty } from '../../stock/quantity';
import { draftBaseShape } from '../drafts';
import { defineVoucherKind } from '../kind';
import { documentShape, lineValueProblems, orderLineSchema, partyProblems } from './documents';
import { itemQtyProblems } from './stockJournal';

/**
 * Purchase Order: what we have ordered from a supplier — items, quantities, rates, and a DUE DATE ON EACH LINE — and the supplier's own
 * reference (their quotation or order number). It is a document: it posts nothing to the accounts and nothing to the stock. What has been
 * received against it is read from the purchase invoices that name its lines (the order book, ADR-0015), so the order can never disagree
 * with them. `closed` is the one thing a person sets by hand: it stops further receipt, whatever is pending.
 */
export const purchaseOrderDraftSchema = z.object({
  ...draftBaseShape,
  ...documentShape,
  closed: z.boolean().optional(),
  lines: z.array(orderLineSchema),
});
export type PurchaseOrderDraft = z.output<typeof purchaseOrderDraftSchema>;

export const purchaseOrderKind = defineVoucherKind<PurchaseOrderDraft>({
  base: 'purchaseOrder',
  layout: 'item-invoice',
  schema: purchaseOrderDraftSchema,
  document: true,

  ledgerRefs: () => [],

  validate(draft, { masters, orders }) {
    const problems: Issue[] = partyProblems(draft, masters, 'vendor');
    if (draft.lines.length === 0) problems.push(issue(IssueCode.TooFewLines, 'A purchase order needs at least one line', 'lines'));

    const ids = new Set<string>();
    draft.lines.forEach((l, i) => {
      const path = `lines.${i}`;
      if (ids.has(l.id)) problems.push(issue(IssueCode.SalesDocInvalid, 'Two lines carry the same id', `${path}.id`));
      ids.add(l.id);
      problems.push(...itemQtyProblems(l.itemId, l.qty, masters, path));
      problems.push(...lineValueProblems(l, path));
      if (l.dueDate < draft.date) {
        problems.push(issue(IssueCode.SalesDocInvalid, `The due date is before the order date (${draft.date})`, `${path}.dueDate`));
      }
    });

    // What has been received against the order is a fact: the order cannot shrink below it.
    const receipts = orders.linksTo(draft.id);
    if (receipts.length > 0) {
      const before = orders.order(draft.id);
      if (before && before.partyId !== draft.partyId) {
        problems.push(issue(IssueCode.OrderHasDeliveries, 'Goods were received against this order: the supplier cannot change', 'partyId'));
      }
      if (receipts.some((d) => d.date < draft.date)) {
        problems.push(issue(IssueCode.OrderHasDeliveries, 'The order cannot be dated after an invoice that was made against it', 'date'));
      }
      const received = new Map<string, { qty: bigint; itemId: string }>();
      for (const d of receipts) {
        const got = received.get(d.orderLineId);
        received.set(d.orderLineId, { qty: (got?.qty ?? 0n) + d.qty, itemId: d.itemId });
      }
      for (const [lineId, got] of received) {
        const i = draft.lines.findIndex((l) => l.id === lineId);
        const line = draft.lines[i];
        if (i < 0 || !line) {
          problems.push(issue(IssueCode.OrderHasDeliveries, 'A line that has goods received against it cannot be removed', 'lines'));
        } else if (line.itemId !== got.itemId) {
          problems.push(issue(IssueCode.OrderHasDeliveries, 'Goods were received against this line: its item cannot change', `lines.${i}.itemId`));
        } else if ((parseQty(line.qty) ?? 0n) < got.qty) {
          const unit = masters.unit(masters.stockItem(line.itemId)?.unitId as never);
          problems.push(
            issue(
              IssueCode.OrderHasDeliveries,
              `${formatQty(got.qty as never, unit?.decimals ?? 0)} already received: the line cannot go below that`,
              `lines.${i}.qty`,
            ),
          );
        }
      }
    }
    return problems;
  },

  post: () => [],
  orderIds: (draft) => [draft.id as VoucherId],
});
