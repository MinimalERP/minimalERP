import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import type { VoucherId } from '../../ids';
import { formatQty, parseQty } from '../../stock/quantity';
import { draftBaseShape } from '../drafts';
import { defineVoucherKind } from '../kind';
import { customerProblems, documentShape, lineValueProblems, orderLineSchema } from './documents';
import { itemQtyProblems } from './stockJournal';

/**
 * Sales Order: what a customer has ordered — items, quantities, rates, and a DUE DATE ON EACH LINE — and the customer's own reference
 * (their PO number). It is a document: it posts nothing to the accounts and nothing to the stock. What has been delivered against it is
 * not stored on it; it is read from the sales invoices that name its lines (the order book), so the order can never disagree with them.
 * `closed` is the one thing a person sets by hand: it stops further delivery, whatever is pending.
 */
export const salesOrderDraftSchema = z.object({
  ...draftBaseShape,
  ...documentShape,
  closed: z.boolean().optional(),
  /** The posted quotation this order was made from (Alt+Shift+O on the quote), if any. */
  quotationId: z.string().uuid().optional(),
  lines: z.array(orderLineSchema),
});
export type SalesOrderDraft = z.output<typeof salesOrderDraftSchema>;

export const salesOrderKind = defineVoucherKind<SalesOrderDraft>({
  base: 'salesOrder',
  layout: 'item-invoice',
  schema: salesOrderDraftSchema,
  document: true,

  ledgerRefs: () => [],

  validate(draft, { masters, orders }) {
    const problems: Issue[] = customerProblems(draft, masters);
    if (draft.lines.length === 0) problems.push(issue(IssueCode.TooFewLines, 'A sales order needs at least one line', 'lines'));

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

    // What has been delivered against the order is a promise kept to the customer: the order cannot shrink below it.
    const deliveries = orders.linksTo(draft.id);
    if (deliveries.length > 0) {
      const before = orders.order(draft.id);
      if (before && before.partyId !== draft.partyId) {
        problems.push(issue(IssueCode.OrderHasDeliveries, 'Goods were delivered against this order: the customer cannot change', 'partyId'));
      }
      if (deliveries.some((d) => d.date < draft.date)) {
        problems.push(issue(IssueCode.OrderHasDeliveries, 'The order cannot be dated after an invoice that was made against it', 'date'));
      }
      const delivered = new Map<string, { qty: bigint; itemId: string }>();
      for (const d of deliveries) {
        const got = delivered.get(d.orderLineId);
        delivered.set(d.orderLineId, { qty: (got?.qty ?? 0n) + d.qty, itemId: d.itemId });
      }
      for (const [lineId, got] of delivered) {
        const i = draft.lines.findIndex((l) => l.id === lineId);
        const line = draft.lines[i];
        if (i < 0 || !line) {
          problems.push(issue(IssueCode.OrderHasDeliveries, 'A line that has goods delivered against it cannot be removed', 'lines'));
        } else if (line.itemId !== got.itemId) {
          problems.push(issue(IssueCode.OrderHasDeliveries, 'Goods were delivered against this line: its item cannot change', `lines.${i}.itemId`));
        } else if ((parseQty(line.qty) ?? 0n) < got.qty) {
          const unit = masters.unit(masters.stockItem(line.itemId)?.unitId as never);
          problems.push(
            issue(
              IssueCode.OrderHasDeliveries,
              `${formatQty(got.qty as never, unit?.decimals ?? 0)} already delivered: the line cannot go below that`,
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
