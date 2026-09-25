import type { ReportKind } from '../shell/router';

/** How ReportScreen hosts a report: grid (DataGrid), a two-sided statement, or GST screens. */
export type ReportHost = 'grid' | 'statement' | 'gst';

const HOST: Partial<Record<ReportKind, ReportHost>> = {
  'profit-loss': 'statement',
  'balance-sheet': 'statement',
  gstr1: 'gst',
  gstr3b: 'gst',
  'gst-purchases': 'gst',
};

/** Where to route a report kind. Unknown kinds use the shared grid host. */
function reportHost(report: ReportKind): ReportHost {
  return HOST[report] ?? 'grid';
}

export type GstReportKind = Extract<ReportKind, 'gstr1' | 'gstr3b' | 'gst-purchases'>;
export type StatementReportKind = Extract<ReportKind, 'profit-loss' | 'balance-sheet'>;

export function asStatementReport(report: ReportKind): StatementReportKind | undefined {
  return reportHost(report) === 'statement' ? (report as StatementReportKind) : undefined;
}

export function asGstReport(report: ReportKind): GstReportKind | undefined {
  return reportHost(report) === 'gst' ? (report as GstReportKind) : undefined;
}

/** Screen title when no company is open (and the default heading elsewhere). */
export function reportTitle(report: ReportKind, kind: string | undefined): string {
  switch (report) {
    case 'daybook':
      return 'Day Book';
    case 'stock-summary':
      return 'Stock Summary';
    case 'stock-item':
      return 'Stock Ledger';
    case 'sales-orders':
      return 'Sales Order Register';
    case 'purchase-orders':
      return 'Purchase Order Register';
    case 'sales-register':
      return 'Sales Invoice Register';
    case 'trial-balance':
      return 'Trial Balance';
    case 'profit-loss':
      return 'Profit & Loss';
    case 'balance-sheet':
      return 'Balance Sheet';
    case 'book':
      return kind === 'bank' ? 'Bank Book' : 'Cash Book';
    case 'gstr1':
      return 'GSTR-1';
    case 'gstr3b':
      return 'GSTR-3B';
    case 'gst-purchases':
      return 'GST Purchases';
    case 'outstanding':
      return kind === 'payable' ? 'Outstanding Payables' : 'Outstanding Receivables';
    default:
      return 'Ledger';
  }
}
