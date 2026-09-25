/**
 * Grid reports (everything hosted on `DataGrid` in ReportScreen).
 *
 * **Domain** (`packages/domain/src/reports/`) computes figures from vouchers, journal lines and stock.
 * **Web** (this file + `*Reports.ts` beside it) adds column specs, formatting, drill routes and UI-only row shapes.
 * Statement and GST reports register in `registry.ts` and use their own screens.
 */
import {
  type BaseKind,
  type ColumnSpec,
  type DayBookRow,
  type LocalDate,
  type Masters,
  type StatementRow,
  dayBookRows,
  ledgerStatement,
  localDate,
  onlyVoucherTypes,
  statementView,
} from '@minimalerp/domain';
import type { Books } from '../books/books';
import type { ReportKind } from '../shell/router';
import { dayBookColumns, ledgerColumns, type TypeChoice } from './definitions';
import { type TbRow, bookGroupIds, tbColumns, tbRows } from './booksReports';
import { type OutstandingBillRow, type PartyRow, billColumns, billRows, partyColumns, partyRows } from './outstandingReports';
import { type VoucherListRow, listTitle, voucherListColumns, voucherListRows } from './voucherLists';
import { type OrderRow, orderRegisterColumns, newestOrdersFirst, orderRegisterRows } from './salesReports';
import { type SalesRegisterRow, newestInvoicesFirst, salesRegisterColumns, salesRegisterRows } from './salesRegister';
import { type StockLedgerRow, type StockSummaryRow, stockLedgerColumns, stockLedgerOf, stockSummaryColumns, stockSummaryRows } from './stockReports';
import type { GstReportKind, StatementReportKind } from './registry';
import { todayText } from '../vouchers/format';

export type GridReportKind = Exclude<ReportKind, StatementReportKind | GstReportKind>;

export type AnyGridRow =
  | DayBookRow
  | StatementRow
  | StockSummaryRow
  | StockLedgerRow
  | OrderRow
  | SalesRegisterRow
  | VoucherListRow
  | TbRow
  | PartyRow
  | OutstandingBillRow;

/** Default row order before the user sorts a column. */
export type GridRowOrder = 'natural' | 'newest-first' | 'newest-orders' | 'newest-invoices';

/** Outstanding is as-on a date; other grid reports use a from→to period. */
export function gridUsesAsOnDate(report: GridReportKind): boolean {
  return report === 'outstanding';
}

/** Opens the voucher-type picker (Day Book, Ledger, Stock Ledger). */
export function gridSupportsTypeFilter(report: GridReportKind): boolean {
  return report === 'daybook' || report === 'ledger' || report === 'stock-item';
}

export interface GridReportContext {
  readonly report: GridReportKind;
  readonly books: Books;
  readonly masters: Masters;
  readonly range: { readonly from: LocalDate; readonly to: LocalDate };
  readonly ledgerId: string | undefined;
  readonly ledgerFromAddress: string | undefined;
  readonly itemFromAddress: string | undefined;
  readonly kind: string | undefined;
  readonly groupFromAddress: string | undefined;
  readonly typeChoices: readonly TypeChoice[];
  readonly typeIds: readonly string[];
}

export interface GridReportSlice {
  readonly columns: readonly ColumnSpec<AnyGridRow>[];
  readonly baseRows: readonly AnyGridRow[];
  readonly rowOrder: GridRowOrder;
  /** Ledger: the statement the rows came from (its opening and closing balance are shown around the grid). */
  readonly statement?: ReturnType<typeof ledgerStatement> | undefined;
  /** Stock item: its stock ledger (opening, current, committed, …). */
  readonly stockLedger?: ReturnType<typeof stockLedgerOf> | undefined;
}

export function orderGridRows(order: GridRowOrder, rows: readonly AnyGridRow[]): readonly AnyGridRow[] {
  switch (order) {
    case 'natural':
      return rows;
    case 'newest-orders':
      return newestOrdersFirst(rows as readonly OrderRow[]);
    case 'newest-invoices':
      return newestInvoicesFirst(rows as readonly SalesRegisterRow[]);
    case 'newest-first':
      return [...rows].reverse();
  }
}

/** Rows and columns for one grid report — pure given context (call from `useMemo` in ReportScreen). */
export function gridReportSlice(ctx: GridReportContext): GridReportSlice {
  const { report, books, masters, range, ledgerId, ledgerFromAddress, itemFromAddress, kind, groupFromAddress, typeChoices, typeIds } = ctx;
  const side = kind === 'payable' ? 'payable' : 'receivable';
  const asOn = range.to;
  const listKind = kind as BaseKind | undefined;
  const bookKind = report === 'book' && (kind === 'cash' || kind === 'bank') ? kind : undefined;
  const itemId = itemFromAddress;

  switch (report) {
    case 'daybook': {
      const day = dayBookRows({ vouchers: books.vouchers, lines: books.lines, masters, range });
      return { columns: dayBookColumns(typeChoices), baseRows: onlyVoucherTypes(day, typeIds), rowOrder: 'newest-first' };
    }
    case 'ledger': {
      const statement = ledgerId
        ? ledgerStatement({ ledgerId: ledgerId as never, vouchers: books.vouchers, lines: books.lines, masters, range })
        : undefined;
      const view = statement ? statementView(statement, typeIds) : undefined;
      return { columns: ledgerColumns(typeChoices), baseRows: view?.rows ?? [], rowOrder: 'newest-first', statement };
    }
    case 'stock-summary':
      return {
        columns: stockSummaryColumns(),
        baseRows: stockSummaryRows(masters, books.stock, range.from, range.to, books.orders),
        rowOrder: 'natural',
      };
    case 'stock-item': {
      const ledger =
        itemId !== undefined
          ? stockLedgerOf(masters, books.stock, books.vouchers, itemId as never, range.from, range.to, books.orders)
          : undefined;
      return {
        columns: stockLedgerColumns(typeChoices),
        baseRows: onlyVoucherTypes(ledger?.rows ?? [], typeIds),
        rowOrder: 'newest-first',
        stockLedger: ledger,
      };
    }
    case 'sales-orders':
    case 'purchase-orders':
      return {
        columns: orderRegisterColumns(report === 'purchase-orders' ? 'purchase' : 'sales'),
        baseRows: orderRegisterRows(books.orders, masters, range.from, range.to, {
          itemId: itemFromAddress,
          side: report === 'purchase-orders' ? 'purchase' : 'sales',
          asOf: localDate(todayText()),
        }),
        rowOrder: 'newest-orders',
      };
    case 'sales-register':
      return {
        columns: salesRegisterColumns(),
        baseRows: salesRegisterRows(books.vouchers, masters, range.from, range.to),
        rowOrder: 'newest-invoices',
      };
    case 'vouchers':
      return {
        columns: voucherListColumns(listKind ?? 'journal'),
        baseRows: listKind
          ? voucherListRows({
              vouchers: books.vouchers,
              lines: books.lines,
              masters,
              orders: books.orders,
              kind: listKind,
              range,
              asOf: localDate(todayText()),
            })
          : [],
        rowOrder: 'newest-first',
      };
    case 'trial-balance':
      return {
        columns: tbColumns(),
        baseRows: tbRows({ masters, lines: books.lines, range, parentIds: groupFromAddress ? [groupFromAddress as never] : undefined }),
        rowOrder: 'natural',
      };
    case 'book':
      return {
        columns: tbColumns(),
        baseRows: bookKind
          ? tbRows({ masters, lines: books.lines, range, parentIds: bookGroupIds(masters, bookKind), includeEmpty: true })
          : [],
        rowOrder: 'natural',
      };
    case 'outstanding':
      return {
        columns: ledgerFromAddress ? billColumns() : partyColumns(side),
        baseRows: ledgerFromAddress
          ? billRows({ vouchers: books.vouchers, masters, side, asOn, ledgerId: ledgerFromAddress as never })
          : partyRows({ vouchers: books.vouchers, lines: books.lines, masters, side, asOn }),
        rowOrder: 'natural',
      };
  }
}

/** Heading on the report screen (after a company is open). */
export function gridReportHeading(ctx: GridReportContext): string {
  const { report, masters, ledgerId, itemFromAddress, kind, groupFromAddress } = ctx;
  const side = kind === 'payable' ? 'payable' : 'receivable';
  const listKind = kind as BaseKind | undefined;
  const bookKind = report === 'book' && (kind === 'cash' || kind === 'bank') ? kind : undefined;
  const ledger = ledgerId ? masters.ledger(ledgerId as never) : undefined;
  const stockItem = itemFromAddress ? masters.stockItem(itemFromAddress as never) : undefined;
  const listTypeName = listKind
    ? (masters.voucherTypes.find((t) => t.baseKind === listKind && t.isSystem)?.name ??
      masters.voucherTypes.find((t) => t.baseKind === listKind)?.name ??
      listKind)
    : '';
  const groupOpened = groupFromAddress ? masters.groups.get(groupFromAddress as never) : undefined;
  const partyOpened =
    ctx.ledgerFromAddress && report === 'outstanding' ? masters.ledger(ctx.ledgerFromAddress as never) : undefined;

  switch (report) {
    case 'trial-balance':
      return groupOpened ? `Trial Balance: ${groupOpened.name}` : 'Trial Balance';
    case 'book':
      return bookKind === 'cash' ? 'Cash Book' : 'Bank Book';
    case 'outstanding':
      if (partyOpened) return `Outstanding: ${partyOpened.name}`;
      return side === 'payable' ? 'Outstanding Payables' : 'Outstanding Receivables';
    case 'vouchers':
      return listTitle(listTypeName);
    case 'daybook':
      return 'Day Book';
    case 'stock-summary':
      return 'Stock Summary';
    case 'stock-item':
      return stockItem ? `Stock: ${stockItem.name}` : 'Stock Ledger';
    case 'sales-orders':
    case 'purchase-orders':
      if (stockItem) return `${report === 'purchase-orders' ? 'Purchase' : 'Sales'} orders: ${stockItem.name}`;
      return report === 'purchase-orders' ? 'Purchase Order Register' : 'Sales Order Register';
    case 'sales-register':
      return 'Sales Invoice Register';
    case 'ledger':
      return ledger ? `Ledger: ${ledger.name}` : 'Ledger';
  }
}
