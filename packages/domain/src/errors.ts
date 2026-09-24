/**
 * Validation outcome model. Business-rule failures are *data* (Result/Issue) so the UI can show
 * every problem at once and the server can return them verbatim. DomainError is reserved for
 * programmer errors and broken invariants.
 */
export interface Issue {
  /** Stable machine-readable code (see IssueCode). The UI keys messages/hints off this. */
  readonly code: string;
  readonly message: string;
  /** Dotted path into the draft, e.g. `lines.2.amount`. */
  readonly path?: string | undefined;
}

export const IssueCode = {
  // parsing / resolution
  SchemaInvalid: 'SCHEMA_INVALID',
  VoucherTypeUnknown: 'VOUCHER_TYPE_UNKNOWN',
  KindUnsupported: 'KIND_UNSUPPORTED',
  // generic voucher checks
  DateOutsideFinancialYear: 'DATE_OUTSIDE_FINANCIAL_YEAR',
  PeriodLocked: 'PERIOD_LOCKED',
  LedgerUnknown: 'LEDGER_UNKNOWN',
  LedgerInactive: 'LEDGER_INACTIVE',
  // per-kind checks
  TooFewLines: 'TOO_FEW_LINES',
  AmountNotPositive: 'AMOUNT_NOT_POSITIVE',
  Unbalanced: 'UNBALANCED',
  AccountNotCashOrBank: 'ACCOUNT_NOT_CASH_OR_BANK',
  ParticularNotCashOrBank: 'PARTICULAR_NOT_CASH_OR_BANK',
  CashBankInJournal: 'CASH_BANK_IN_JOURNAL',
  SameLedgerBothSides: 'SAME_LEDGER_BOTH_SIDES',
  // posting-plan invariants (a violation means a posting rule is buggy)
  PlanTooFewLines: 'PLAN_TOO_FEW_LINES',
  AmountTooLarge: 'AMOUNT_TOO_LARGE',
  PlanNonPositiveAmount: 'PLAN_NON_POSITIVE_AMOUNT',
  PlanUnbalanced: 'PLAN_UNBALANCED',
  PlanInconsistentLines: 'PLAN_INCONSISTENT_LINES',
  // authorisation
  PermissionDenied: 'PERMISSION_DENIED',
  // lifecycle / storage
  VoucherNotFound: 'VOUCHER_NOT_FOUND',
  VoucherNotPosted: 'VOUCHER_NOT_POSTED',
  VersionConflict: 'VERSION_CONFLICT',
  VoucherTypeChanged: 'VOUCHER_TYPE_CHANGED',
  VoucherIdMismatch: 'VOUCHER_ID_MISMATCH',
  FinancialYearChanged: 'FINANCIAL_YEAR_CHANGED',
  IdempotencyConflict: 'IDEMPOTENCY_CONFLICT',
  NumberingSeriesMissing: 'NUMBERING_SERIES_MISSING',
  CompanyMismatch: 'COMPANY_MISMATCH',
  // master data
  GroupTreeInvalid: 'GROUP_TREE_INVALID',
  MasterNotFound: 'MASTER_NOT_FOUND',
  MasterIdExists: 'MASTER_ID_EXISTS',
  NameTaken: 'NAME_TAKEN',
  CodeTaken: 'CODE_TAKEN',
  ReferenceUnknown: 'REFERENCE_UNKNOWN',
  ReferenceInactive: 'REFERENCE_INACTIVE',
  SystemMasterLocked: 'SYSTEM_MASTER_LOCKED',
  HasDependents: 'HAS_DEPENDENTS',
  InvalidGstin: 'INVALID_GSTIN',
  InvalidPan: 'INVALID_PAN',
  InvalidHsn: 'INVALID_HSN',
  InvalidPhone: 'INVALID_PHONE',
  InvalidEmail: 'INVALID_EMAIL',
  HierarchyCycle: 'HIERARCHY_CYCLE',
  NatureLocked: 'NATURE_LOCKED',
  InUse: 'IN_USE',
  OutOfRange: 'OUT_OF_RANGE',
  /** A numbering series' next number cannot be moved before what it already is — that number, or one before it, may already be issued. */
  SeriesNextBehind: 'SERIES_NEXT_BEHIND',
  UnsupportedOperation: 'UNSUPPORTED_OPERATION',
  OpeningInvalid: 'OPENING_INVALID',
  AllocationInvalid: 'ALLOCATION_INVALID',
  PartyDetailsInvalid: 'PARTY_DETAILS_INVALID',
  /** Stock: a movement (or the removal of one) would take an item below zero in a godown on some day. */
  StockNegative: 'STOCK_NEGATIVE',
  /** Stock: a stock line is malformed (no rate on an In, a rate on an Out, an unknown or inactive item or godown, too many decimals). */
  StockLineInvalid: 'STOCK_LINE_INVALID',
  /** Sales documents: something about a sales order or invoice is wrong that is not stock (the party, the ledger, a due date, a line). */
  SalesDocInvalid: 'SALES_DOC_INVALID',
  /** An invoice line names an order line that cannot take it (unknown, another customer's, closed, another item, dated before the order). */
  OrderRefInvalid: 'ORDER_REF_INVALID',
  /** An invoice would deliver more of an order line than is pending on it. */
  OverDelivery: 'OVER_DELIVERY',
  /** A sales order cannot be cancelled or changed below what has already been delivered against it. */
  OrderHasDeliveries: 'ORDER_HAS_DELIVERIES',
  /** GST on an invoice: not switched on for the company, a state or rate that is not valid, or tax that is not what the lines come to. */
  GstInvalid: 'GST_INVALID',
  /** TDS on a receipt: more than the bill it is deducted from, on something that is not a bill, or a kind of voucher that has none. */
  TdsInvalid: 'TDS_INVALID',
  /** Round Off on an invoice: the company's Round Off ledger is missing (an old company gets it when it is reopened). */
  RoundOffInvalid: 'ROUND_OFF_INVALID',
  /** A purchase invoice reuses a supplier's invoice number that is already a bill of that supplier. */
  BillRefInUse: 'BILL_REF_IN_USE',
  /** Infrastructure: a master change was checked against data that changed underneath it. Callers re-check and retry. */
  MastersChanged: 'MASTERS_CHANGED',
} as const;

export type IssueCodeValue = (typeof IssueCode)[keyof typeof IssueCode];

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly Issue[] };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = <T = never>(...issues: Issue[]): Result<T> => ({ ok: false, issues });

export const failWith = <T = never>(issues: readonly Issue[]): Result<T> => ({ ok: false, issues });

export const issue = (code: string, message: string, path?: string): Issue =>
  path === undefined ? { code, message } : { code, message, path };

export class DomainError extends Error {
  readonly issues: readonly Issue[];
  constructor(issues: readonly Issue[]) {
    super(issues.map((i) => `${i.code}: ${i.message}`).join('; '));
    this.name = 'DomainError';
    this.issues = issues;
  }
}
