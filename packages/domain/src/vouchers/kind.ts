import type { z } from 'zod';
import type { FinancialYear } from '../dates';
import { type Issue, type Result, IssueCode, failWith, issue, ok } from '../errors';
import type { LedgerId, StockItemId, VoucherId } from '../ids';
import type { BaseKind, Masters, VoucherType } from '../masters/masters';
import type { OrderBook, PlannedLink } from '../orders/orderBook';
import type { PlannedLine } from '../posting/plan';
import type { StockBook } from '../stock/book';
import type { PlannedStock } from '../stock/movement';
import type { DraftBase } from './drafts';

export type VoucherLayout = 'single-entry' | 'double-entry' | 'opening' | 'stock' | 'item-invoice';

export interface LedgerRef {
  readonly ledgerId: LedgerId;
  /** Dotted path of the field holding this reference, e.g. `lines.2.ledgerId`. */
  readonly path: string;
}

/** Everything a kind may consult while validating or posting. Read-only; no I/O. */
export interface KindContext {
  readonly masters: Masters;
  readonly voucherType: VoucherType;
  readonly financialYear: FinancialYear;
  /** The company's stock movements as they stand — WITHOUT the voucher being altered, if any. Read-only; empty for kinds that never look. */
  readonly stock: StockBook;
  /** The company's orders and deliveries as they stand — WITHOUT the voucher being altered, if any. Read-only; empty for kinds that never look. */
  readonly orders: OrderBook;
}

/**
 * The extension point for new voucher behaviour. To add a voucher kind: write one of these and
 * register it — screens, hotkeys, numbering and Alt+G all key off VoucherType rows, so nothing
 * else changes.
 *
 *   UI layout  →  schema (parse)  →  ledgerRefs (existence/active checks by the engine)
 *              →  validate (kind rules)  →  post (posting rule → PlannedLine[])
 */
export interface VoucherKindSpec<D extends DraftBase> {
  readonly base: BaseKind;
  /** Tells the UI which generic layout component renders this kind. */
  readonly layout: VoucherLayout;
  readonly schema: z.ZodType<D>;
  /** Every ledger the draft references (with its field path), so the engine can verify each exists and is active. */
  ledgerRefs(draft: D): readonly LedgerRef[];
  /** Kind-specific rules. Ledgers are already known to exist and be active. */
  validate(draft: D, ctx: KindContext): Issue[];
  /** The posting rule. Must return a balanced set of positive-amount lines; the engine verifies. */
  post(draft: D, ctx: KindContext): readonly PlannedLine[];
  /** The stock movements the voucher makes (stock vouchers only). Accounting kinds omit it. */
  postStock?(draft: D, ctx: KindContext): readonly PlannedStock[];
  /** Every stock item the draft touches, so a backend can load just those items' movements before validating. */
  stockItems?(draft: D): readonly StockItemId[];
  /** The deliveries the voucher makes against sales-order lines (a sales invoice). Other kinds omit it. */
  postLinks?(draft: D, ctx: KindContext): readonly PlannedLink[];
  /** Every order the draft names or IS, so a backend can load just those orders and their deliveries before validating. */
  orderIds?(draft: D): readonly VoucherId[];
  /** A document kind posts nothing to the journal or the stock (a Sales Order): the engine then expects an empty plan. */
  readonly document?: boolean;
}

/** A kind with its draft type erased, as stored in the registry. */
export interface VoucherKind {
  readonly base: BaseKind;
  readonly layout: VoucherLayout;
  parse(input: unknown): Result<DraftBase>;
  ledgerRefs(draft: DraftBase): readonly LedgerRef[];
  validate(draft: DraftBase, ctx: KindContext): Issue[];
  post(draft: DraftBase, ctx: KindContext): readonly PlannedLine[];
  postStock(draft: DraftBase, ctx: KindContext): readonly PlannedStock[];
  stockItems(draft: DraftBase): readonly StockItemId[];
  postLinks(draft: DraftBase, ctx: KindContext): readonly PlannedLink[];
  orderIds(draft: DraftBase): readonly VoucherId[];
  readonly document: boolean;
}

export function defineVoucherKind<D extends DraftBase>(spec: VoucherKindSpec<D>): VoucherKind {
  // Casting `DraftBase` back to `D` is sound: the engine only passes drafts produced by this
  // kind's own `parse`, and a kind is only looked up by the voucher type's baseKind.
  return {
    base: spec.base,
    layout: spec.layout,
    parse(input) {
      const parsed = spec.schema.safeParse(input);
      if (parsed.success) return ok(parsed.data);
      return failWith(
        parsed.error.issues.map((i) =>
          issue(IssueCode.SchemaInvalid, i.message, i.path.map(String).join('.') || undefined),
        ),
      );
    },
    ledgerRefs: (draft) => spec.ledgerRefs(draft as D),
    validate: (draft, ctx) => spec.validate(draft as D, ctx),
    post: (draft, ctx) => spec.post(draft as D, ctx),
    postStock: (draft, ctx) => spec.postStock?.(draft as D, ctx) ?? [],
    stockItems: (draft) => spec.stockItems?.(draft as D) ?? [],
    postLinks: (draft, ctx) => spec.postLinks?.(draft as D, ctx) ?? [],
    orderIds: (draft) => spec.orderIds?.(draft as D) ?? [],
    document: spec.document === true,
  };
}
