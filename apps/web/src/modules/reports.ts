import type { Command, DefaultBinding, MenuEntry, ModuleManifest } from '@minimalerp/command';
import type { AppContext } from '../shell/services';

/**
 * Reports on the one grid. Day Book, Ledger and Stock Summary replace their planned entries (same ids). The grid's own commands — sort, filter, clear, the
 * voucher-type filter — are contextual: the report screen in front supplies them, so every report built later gets the same keys for free.
 */
const commands: Command<AppContext>[] = [
  {
    id: 'report.dayBook',
    title: 'Day Book',
    category: 'Report',
    keywords: ['daybook', 'transactions', 'register'],
    description: 'Every voucher, day by day',
    run: (app) => app.navigate({ type: 'report', report: 'daybook' }),
  },
  {
    id: 'report.ledger',
    title: 'Ledger',
    category: 'Report',
    keywords: ['account', 'statement'],
    description: 'One ledger’s entries with a running balance',
    run: (app) => app.navigate({ type: 'report', report: 'ledger' }),
  },
  {
    id: 'report.trialBalance',
    title: 'Trial Balance',
    category: 'Report',
    keywords: ['tb', 'balances', 'groups', 'debit credit'],
    description: 'Every group of accounts with opening, debit, credit and closing — Enter opens a group, then a ledger',
    run: (app) => app.navigate({ type: 'report', report: 'trial-balance' }),
  },
  {
    id: 'report.profitAndLoss',
    title: 'Profit & Loss',
    category: 'Report',
    keywords: ['p&l', 'pnl', 'income statement', 'trading account', 'gross profit', 'net profit'],
    description: 'Trading and Profit & Loss account for a period, two-sided',
    run: (app) => app.navigate({ type: 'report', report: 'profit-loss' }),
  },
  {
    id: 'report.balanceSheet',
    title: 'Balance Sheet',
    category: 'Report',
    keywords: ['liabilities', 'assets', 'financial position'],
    description: 'Liabilities and assets as on a date, two-sided',
    run: (app) => app.navigate({ type: 'report', report: 'balance-sheet' }),
  },
  {
    id: 'report.cashBook',
    title: 'Cash Book',
    category: 'Report',
    keywords: ['cash', 'petty cash'],
    description: 'The cash ledgers with opening, debit, credit and closing — Enter opens one',
    run: (app) => app.navigate({ type: 'report', report: 'book', kind: 'cash' }),
  },
  {
    id: 'report.bankBook',
    title: 'Bank Book',
    category: 'Report',
    keywords: ['bank', 'bank accounts'],
    description: 'The bank ledgers with opening, debit, credit and closing — Enter opens one',
    run: (app) => app.navigate({ type: 'report', report: 'book', kind: 'bank' }),
  },
  {
    id: 'report.outstanding',
    title: 'Outstanding Receivables',
    category: 'Report',
    keywords: ['debtors', 'customers', 'bills', 'ageing', 'aging', 'overdue', 'receivable', 'dues'],
    description: 'What customers owe, bill by bill, aged from each due date',
    run: (app) => app.navigate({ type: 'report', report: 'outstanding', kind: 'receivable' }),
  },
  {
    id: 'report.payables',
    title: 'Outstanding Payables',
    category: 'Report',
    keywords: ['creditors', 'suppliers', 'vendors', 'bills', 'ageing', 'aging', 'overdue', 'payable'],
    description: 'What we owe suppliers, bill by bill, aged from each due date',
    run: (app) => app.navigate({ type: 'report', report: 'outstanding', kind: 'payable' }),
  },
  // What Go To runs for "Group summary" on an account group.
  {
    id: 'report.groupSummary',
    title: 'Group summary',
    category: 'Report',
    hidden: true,
    configurable: false,
    run: (app, args) => {
      const id = (args as { id?: string } | undefined)?.id;
      if (id) app.navigate({ type: 'report', report: 'trial-balance', groupId: id });
    },
  },
  {
    id: 'report.stockSummary',
    title: 'Stock Summary',
    category: 'Report',
    keywords: ['inventory', 'stock', 'closing stock', 'valuation', 'items'],
    description: 'Every item: opening, inward, outward and closing stock, with its value',
    run: (app) => app.navigate({ type: 'report', report: 'stock-summary' }),
  },
  {
    id: 'report.salesOrders',
    title: 'Sales Order Register',
    category: 'Report',
    keywords: ['orders', 'sales orders', 'customer po', 'pending orders', 'order status', 'delivered', 'fill'],
    description: 'Every sales order line: ordered, delivered, pending, and whether the order is still open',
    run: (app) => app.navigate({ type: 'report', report: 'sales-orders' }),
  },
  {
    id: 'report.purchaseOrders',
    title: 'Purchase Order Register',
    category: 'Report',
    keywords: ['orders', 'purchase orders', 'supplier orders', 'pending orders', 'order status', 'received', 'on order', 'fill'],
    description: 'Every purchase order line: ordered, received, pending, and whether the order is still open',
    run: (app) => app.navigate({ type: 'report', report: 'purchase-orders' }),
  },
  {
    id: 'report.salesRegister',
    title: 'Sales Invoice Register',
    category: 'Report',
    keywords: ['sales register', 'invoice register', 'item wise', 'gst', 'hsn'],
    description: 'Every sales invoice line: item, quantity, rate and GST — read invoices item by item',
    run: (app) => app.navigate({ type: 'report', report: 'sales-register' }),
  },
  // What Go To runs for "Purchase orders" on a stock item: the register for that item alone.
  {
    id: 'report.purchaseOrdersOf',
    title: 'Purchase orders of an item',
    category: 'Report',
    hidden: true,
    configurable: false,
    run: (app, args) => {
      const id = (args as { id?: string } | undefined)?.id;
      if (id) app.navigate({ type: 'report', report: 'purchase-orders', itemId: id });
    },
  },
  // What Go To runs for "Sales orders" on a stock item: the register for that item alone.
  {
    id: 'report.salesOrdersOf',
    title: 'Sales orders of an item',
    category: 'Report',
    hidden: true,
    configurable: false,
    run: (app, args) => {
      const id = (args as { id?: string } | undefined)?.id;
      if (id) app.navigate({ type: 'report', report: 'sales-orders', itemId: id });
    },
  },
  // What Go To runs for "Stock ledger" on a stock item.
  {
    id: 'report.stockLedgerOf',
    title: 'Stock ledger',
    category: 'Report',
    hidden: true,
    configurable: false,
    run: (app, args) => {
      const id = (args as { id?: string } | undefined)?.id;
      if (id) app.navigate({ type: 'report', report: 'stock-item', itemId: id });
    },
  },
  // What Go To runs for "Ledger report" on a ledger result.
  {
    id: 'report.ledgerOf',
    title: 'Ledger report',
    category: 'Report',
    hidden: true,
    configurable: false,
    run: (app, args) => {
      const id = (args as { id?: string } | undefined)?.id;
      if (id) app.navigate({ type: 'report', report: 'ledger', ledgerId: id });
    },
  },
  {
    id: 'report.gstr1',
    title: 'GSTR-1',
    category: 'Report',
    keywords: ['gst', 'tax', 'outward supplies', 'sales register', 'hsn', 'b2b', 'return', 'export'],
    description: 'A month’s sales invoices by rate for GSTR-1, with an HSN summary and a check before the export',
    run: (app) => app.navigate({ type: 'report', report: 'gstr1' }),
  },
  {
    id: 'report.gstr3b',
    title: 'GSTR-3B',
    category: 'Report',
    keywords: ['gst', 'tax', 'summary', 'itc', 'input tax credit', 'output tax', 'net payable', 'return'],
    description: 'A month’s output GST, input GST (to review, never auto-claimed) and the net position — an internal report',
    run: (app) => app.navigate({ type: 'report', report: 'gstr3b' }),
  },
  {
    id: 'report.gstPurchases',
    title: 'GST Purchase Register',
    category: 'Report',
    hidden: true,
    configurable: false,
    description: 'The purchase invoices and input GST behind GSTR-3B',
    run: (app) => app.navigate({ type: 'report', report: 'gst-purchases' }),
  },
  { id: 'gst.exportJson', title: 'Export GSTR-1 (JSON)', category: 'Reports', hidden: true, configurable: true, panel: { label: 'Export JSON', group: 'Report', order: 44, on: ['report'] } },
  { id: 'gst.exportCsv', title: 'Export GSTR-1 (CSV)', category: 'Reports', hidden: true, configurable: true, panel: { label: 'Export CSV', group: 'Report', order: 45, on: ['report'] } },
  { id: 'gst.view', title: 'Switch invoices / HSN summary', category: 'Reports', hidden: true, configurable: true, panel: { label: 'HSN summary', group: 'Report', order: 46, on: ['report'] } },
  { id: 'grid.sort', title: 'Sort by this column', category: 'Reports', hidden: true, configurable: true, panel: { label: 'Sort', group: 'Report', order: 40, on: ['report'] } },
  { id: 'grid.filter', title: 'Filter this column', category: 'Reports', hidden: true, configurable: true, panel: { label: 'Filter', group: 'Report', order: 41, on: ['report'] } },
  { id: 'grid.clear', title: 'Clear filters', category: 'Reports', hidden: true, configurable: true, panel: { label: 'Clear filters', group: 'Report', order: 42, on: ['report'] } },
  { id: 'report.types', title: 'Filter by voucher type', category: 'Reports', hidden: true, configurable: true, panel: { label: 'Voucher types', group: 'Report', order: 43, on: ['report'] } },
  { id: 'report.print', title: 'Print', category: 'Reports', hidden: true, configurable: true, panel: { label: 'Print', group: 'Report', order: 47, on: ['report'], fold: 'Print' } },
  {
    id: 'ledger.remind',
    title: 'Payment reminder: email the customer its statement of account',
    category: 'Reports',
    hidden: true,
    configurable: true,
    panel: { label: 'Payment reminder', group: 'Report', order: 48, on: ['report'], hideWhenUnavailable: true, fold: 'Email' },
  },
];

const bindings: DefaultBinding[] = [
  { commandId: 'grid.sort', chord: 'Alt+S', scope: 'screen:report' },
  { commandId: 'grid.filter', chord: 'Alt+L', scope: 'screen:report' },
  { commandId: 'grid.clear', chord: 'Alt+K', scope: 'screen:report' },
  { commandId: 'report.types', chord: 'Alt+T', scope: 'screen:report' },
  { commandId: 'gst.exportJson', chord: 'Alt+B', scope: 'screen:report' },
  { commandId: 'gst.exportCsv', chord: 'Alt+M', scope: 'screen:report' },
  { commandId: 'gst.view', chord: 'Alt+V', scope: 'screen:report' },
  { commandId: 'report.print', chord: 'Ctrl+P', scope: 'screen:report' },
];

const menu: MenuEntry[] = [
  { section: 'reports', commandId: 'report.trialBalance', order: 1, group: 'Statements' },
  { section: 'reports', commandId: 'report.profitAndLoss', order: 2, group: 'Statements' },
  { section: 'reports', commandId: 'report.balanceSheet', order: 3, group: 'Statements' },
  { section: 'reports', commandId: 'report.dayBook', order: 10, group: 'Books' },
  { section: 'reports', commandId: 'report.ledger', order: 11, group: 'Books' },
  { section: 'reports', commandId: 'report.cashBook', order: 12, group: 'Books' },
  { section: 'reports', commandId: 'report.bankBook', order: 13, group: 'Books' },
  { section: 'reports', commandId: 'report.outstanding', order: 20, group: 'Outstanding' },
  { section: 'reports', commandId: 'report.payables', order: 21, group: 'Outstanding' },
  { section: 'reports', commandId: 'report.stockSummary', order: 30, group: 'Inventory & Sales' },
  { section: 'reports', commandId: 'report.salesOrders', order: 31, group: 'Inventory & Sales' },
  { section: 'reports', commandId: 'report.salesRegister', order: 32, group: 'Inventory & Sales' },
  { section: 'reports', commandId: 'report.purchaseOrders', order: 33, group: 'Inventory & Sales' },
  { section: 'reports', commandId: 'report.gstr1', order: 40, group: 'GST' },
  { section: 'reports', commandId: 'report.gstr3b', order: 41, group: 'GST' },
];

export const reportsModule: ModuleManifest<AppContext> = { id: 'reports', commands, bindings, menu };
