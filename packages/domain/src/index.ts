/**
 * @minimalerp/domain — pure accounting/ERP logic. No I/O, no DOM, no framework.
 * May import only the stdlib, zod and big.js (enforced by tooling/dependency-cruiser.cjs).
 *
 * Pipeline:  input → resolveDraft → planVoucher → PostingPlan → (adapter commits atomically)
 */
export * from './ids';
export * from './errors';
export * from './money';
export * from './dates';

export * from './masters/groups';
export * from './masters/masters';
export * from './masters/systemLedgers';
export * from './masters/records';
export * from './masters/rules';
export * from './masters/commands';
export * from './masters/seed';
export * from './masters/rows';
export * from './masters/newCompany';

export * from './vouchers/drafts';
export * from './vouchers/allocations';
export * from './gst/tax';
export * from './reports/gst';
export {
  deriveGstHeader,
  gstOfContent,
  grandTotal,
  grandTotalParts,
  roundOffAmount,
  invoiceGst,
  breakdownOf,
  lineGstRate,
  isRated,
  type GstHeader,
  type GrandTotalParts,
  type InvoiceSide,
} from './vouchers/kinds/gstDoc';
export * from './vouchers/kind';
export * from './vouchers/registry';
export * from './vouchers/voucher';
export { journalKind } from './vouchers/kinds/journal';
export { openingKind, openingDraftSchema, type OpeningDraft } from './vouchers/kinds/opening';
export { contraKind, paymentKind, receiptKind } from './vouchers/kinds/single-entry';

export * from './stock/quantity';
export * from './stock/movement';
export * from './stock/book';
export * from './orders/orderBook';
export { stockJournalKind, stockJournalDraftSchema, type StockJournalDraft } from './vouchers/kinds/stockJournal';
export { stockOpeningKind, stockOpeningDraftSchema, type StockOpeningDraft } from './vouchers/kinds/stockOpening';
export { salesKind, salesDraftSchema, type SalesDraft } from './vouchers/kinds/sales';
export { salesOrderKind, salesOrderDraftSchema, type SalesOrderDraft } from './vouchers/kinds/salesOrder';
export { quotationKind, quotationDraftSchema, type QuotationDraft } from './vouchers/kinds/quotation';
export { purchaseKind, purchaseDraftSchema, type PurchaseDraft } from './vouchers/kinds/purchase';
export { purchaseOrderKind, purchaseOrderDraftSchema, type PurchaseOrderDraft } from './vouchers/kinds/purchaseOrder';
export {
  customerLedgerOf,
  vendorLedgerOf,
  invoiceTotal,
  lineValue,
  type InvoiceLine,
  type OrderLine,
  type OrderRef,
} from './vouchers/kinds/documents';

export * from './posting/plan';
export * from './posting/engine';
export * from './posting/lifecycle';

export * from './reports/trialBalance';
export * from './reports/grid';
export * from './reports/books';
export * from './wire';
export * from './reports/groupSummary';
export * from './reports/financials';
export * from './reports/outstanding';

export * from './intake/extraction';
export * from './intake/proposal';
export * from './intake/match';
export * from './intake/propose';
export * from './intake/remittance';
export * from './reports/digest';
export * from './csv/format';
export * from './csv/items';
export * from './csv/parties';
export * from './csv/vouchers';
export * from './masters/mailTemplates';
export * from './mail/voucherMail';
