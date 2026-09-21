import type { LocalDate } from '../dates';
import type { CompanyId, FinancialYearId, VoucherId, VoucherTypeId } from '../ids';
import type { DraftBase } from './drafts';

export type VoucherStatus = 'posted' | 'cancelled';

/**
 * A voucher as stored after posting. `version` bumps on every change (alter or cancel) and is the
 * optimistic-concurrency token; `revision` counts alterations only. A cancelled voucher keeps its
 * number (no gaps) but contributes nothing to the books.
 * Drafts (unposted, unnumbered) arrive with the voucher screen in Phase 5.
 */
export interface Voucher {
  readonly id: VoucherId;
  readonly companyId: CompanyId;
  readonly voucherTypeId: VoucherTypeId;
  readonly financialYearId: FinancialYearId;
  readonly number: string;
  readonly date: LocalDate;
  readonly status: VoucherStatus;
  readonly version: number;
  readonly revision: number;
  /** The parsed draft exactly as posted — the source the journal was derived from. */
  readonly content: DraftBase;
}
