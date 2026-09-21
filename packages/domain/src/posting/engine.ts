import { z } from 'zod';
import type { FinancialYear } from '../dates';
import { isPeriodLocked } from '../dates';
import { type Issue, type Result, IssueCode, failWith, issue, ok } from '../errors';
import type { LedgerId } from '../ids';
import type { Masters, VoucherType } from '../masters/masters';
import { type DraftBase, voucherTypeIdSchema } from '../vouchers/drafts';
import type { VoucherKind } from '../vouchers/kind';
import type { VoucherKindRegistry } from '../vouchers/registry';
import { partyDetailsProblems } from '../vouchers/allocations';
import { OrderBook } from '../orders/orderBook';
import { StockBook } from '../stock/book';
import { type PostingPlan, checkPlanInvariants, stampPlan } from './plan';

/** Steps 1–4 of the pipeline: which voucher type is this, and does the input parse for its kind? */
export interface ResolvedDraft {
  readonly draft: DraftBase;
  readonly voucherType: VoucherType;
  readonly kind: VoucherKind;
}

/** A fully validated voucher and the posting plan derived from it — ready to commit atomically. */
export interface PreparedVoucher {
  readonly draft: DraftBase;
  readonly voucherType: VoucherType;
  readonly financialYear: FinancialYear;
  readonly plan: PostingPlan;
}

const envelopeSchema = z.object({ voucherTypeId: voucherTypeIdSchema });

/**
 *   input ─► envelope parse ─► voucher type ─► kind ─► kind schema parse
 * Pure: takes a Masters snapshot, performs no I/O.
 */
export function resolveDraft(
  input: unknown,
  masters: Masters,
  registry: VoucherKindRegistry,
): Result<ResolvedDraft> {
  const envelope = envelopeSchema.safeParse(input);
  if (!envelope.success) {
    return failWith(
      envelope.error.issues.map((i) => issue(IssueCode.SchemaInvalid, i.message, i.path.map(String).join('.') || undefined)),
    );
  }
  const voucherType = masters.voucherType(envelope.data.voucherTypeId);
  if (!voucherType) {
    return failWith([issue(IssueCode.VoucherTypeUnknown, `Unknown voucher type ${envelope.data.voucherTypeId}`, 'voucherTypeId')]);
  }
  const kind = registry.get(voucherType.baseKind);
  if (!kind) {
    return failWith([issue(IssueCode.KindUnsupported, `No voucher kind registered for "${voucherType.baseKind}"`)]);
  }
  const parsed = kind.parse(input);
  if (!parsed.ok) return parsed;
  return ok({ draft: parsed.value, voucherType, kind });
}

/**
 *   generic checks (financial year, period lock, ledgers exist & active)
 *     ─► kind validation ─► posting rule ─► stamp identity ─► invariant assertions
 * Generic failures short-circuit so kind rules can assume every ledger is real and active.
 */
export function planVoucher(
  resolved: ResolvedDraft,
  masters: Masters,
  stock: StockBook = StockBook.empty,
  orders: OrderBook = OrderBook.empty,
): Result<PreparedVoucher> {
  const { draft, voucherType, kind } = resolved;

  const financialYear = masters.financialYearOn(draft.date);
  if (!financialYear) {
    return failWith([
      issue(IssueCode.DateOutsideFinancialYear, `${draft.date} does not fall in any financial year of this company`, 'date'),
    ]);
  }

  const generic: Issue[] = [];
  if (isPeriodLocked(financialYear, draft.date)) {
    generic.push(issue(IssueCode.PeriodLocked, `Books are locked through ${financialYear.lockedThrough}`, 'date'));
  }
  const seen = new Set<LedgerId>();
  for (const ref of kind.ledgerRefs(draft)) {
    const ledger = masters.ledger(ref.ledgerId);
    if (!ledger) {
      generic.push(issue(IssueCode.LedgerUnknown, `Unknown ledger ${ref.ledgerId}`, ref.path));
    } else if (!ledger.isActive && !seen.has(ref.ledgerId)) {
      generic.push(issue(IssueCode.LedgerInactive, `Ledger "${ledger.name}" is inactive`, ref.path));
    }
    seen.add(ref.ledgerId);
  }
  generic.push(...partyDetailsProblems(draft.partyDetails, masters));
  if (generic.length > 0) return failWith(generic);

  const ctx = { masters, voucherType, financialYear, stock, orders };

  const businessIssues = kind.validate(draft, ctx);
  if (businessIssues.length > 0) return failWith(businessIssues);

  const plan = stampPlan(draft.id, draft.date, kind.post(draft, ctx), kind.postStock(draft, ctx), kind.postLinks(draft, ctx));
  const invariantIssues = checkPlanInvariants(plan, { document: kind.document, linkDirection: voucherType.baseKind === 'purchase' ? 'in' : 'out' });
  if (invariantIssues.length > 0) return failWith(invariantIssues);

  return ok({ draft, voucherType, financialYear, plan });
}

/** The whole pipeline in one call. This is what the browser previews with and the server enforces with. */
export function prepareVoucher(
  input: unknown,
  masters: Masters,
  registry: VoucherKindRegistry,
  stock: StockBook = StockBook.empty,
  orders: OrderBook = OrderBook.empty,
): Result<PreparedVoucher> {
  const resolved = resolveDraft(input, masters, registry);
  return resolved.ok ? planVoucher(resolved.value, masters, stock, orders) : resolved;
}
