import { type Command, type DefaultBinding, type MenuEntry, type ModuleManifest, searchEntities } from '@minimalerp/command';
import { voucherDocsOf } from '../books/voucherDocs';
import { ENTRY_KINDS, type EntryKind, KIND_TITLES, SALES_KINDS, SALES_TITLES, type SalesKind, isSalesKind } from '../vouchers/kinds';
import type { AppContext } from '../shell/services';

/**
 * Entering vouchers: Contra, Payment, Receipt and Journal on the one voucher screen, the Sales and Purchase Invoices and Orders on their item-line
 * window (F8, Shift+F8 and F9, Shift+F9 — an invoice and its order switch into each other in place), and the Stock Journal (F10). These REPLACE the planned entries of the same ids, so
 * the F4–F7 shortcuts and Gateway rows are exactly where they were. Inside a voucher the same keys SWITCH the type (scoped bindings), and the
 * bottom bar lists them — which is how one screen serves every voucher type.
 */

const STOCK_JOURNAL_KEYWORDS = ['stock transfer', 'godown', 'consumption', 'production', 'conversion', 'adjustment'];

const KEYWORDS: Readonly<Record<EntryKind, readonly string[]>> = {
  contra: ['cash deposit', 'transfer', 'bank to bank'],
  payment: ['pay', 'expense'],
  receipt: ['receive', 'collection'],
  journal: ['adjustment', 'entry'],
};
const KEYS: Readonly<Record<EntryKind, string>> = { contra: 'F4', payment: 'F5', receipt: 'F6', journal: 'F7' };
const SALES_KEYWORDS: Readonly<Record<SalesKind, readonly string[]>> = {
  sales: ['invoice', 'sell', 'sales invoice', 'bill customer', 'deliver'],
  salesOrder: ['order', 'customer po', 'purchase order from customer', 'so'],
  purchase: ['bill', 'buy', 'purchase invoice', 'supplier invoice', 'receive goods', 'goods in'],
  purchaseOrder: ['order', 'po', 'order from supplier', 'buy'],
};
const SALES_KEYS: Readonly<Record<SalesKind, string>> = { sales: 'F8', salesOrder: 'Shift+F8', purchase: 'F9', purchaseOrder: 'Shift+F9' };
const SALES_COMMAND_TITLES: Readonly<Record<SalesKind, string>> = { sales: 'New Sales Voucher', salesOrder: 'New Sales Order', purchase: 'New Purchase Voucher', purchaseOrder: 'New Purchase Order' };
const SALES_DESCRIPTIONS: Readonly<Record<SalesKind, string>> = {
  sales: 'Goods sold to a customer: books the sale, takes the stock out, fills the order lines it names',
  salesOrder: 'What a customer has ordered, with a due date on each line — posts nothing to the accounts or the stock',
  purchase: 'Goods bought from a supplier: books the purchase, brings the stock in, raises the supplier’s bill, fills the order lines it names',
  purchaseOrder: 'What we have ordered from a supplier, with a due date on each line — posts nothing to the accounts or the stock',
};

const newCommands: Command<AppContext>[] = ENTRY_KINDS.map((kind) => ({
  id: `voucher.new.${kind}`,
  title: `New ${KIND_TITLES[kind]} Voucher`,
  category: 'Voucher',
  keywords: KEYWORDS[kind],
  // Without a company the screen itself says so (and keeps the address), instead of bouncing somewhere else.
  run: (app) => app.navigate({ type: 'voucher', mode: 'create', typeKey: kind }),
}));

// The Sales and Purchase Invoices and Orders are item-line documents on their own window. They REPLACE the planned entries of the same ids.
const salesCommands: Command<AppContext>[] = SALES_KINDS.map((kind) => ({
  id: `voucher.new.${kind}`,
  title: SALES_COMMAND_TITLES[kind],
  category: 'Voucher',
  keywords: SALES_KEYWORDS[kind],
  description: SALES_DESCRIPTIONS[kind],
  run: (app) => app.navigate({ type: 'voucher', mode: 'create', typeKey: kind }),
}));

// The Stock Journal moves stock, not money: it is opened from anywhere (F10) and has its own columns, so it is not one of the keys that switch type inside an accounting voucher.
// One LIST per voucher type (Transactions › Sales › Sales Vouchers): every voucher of that type, with New. The window it opens closes back here.
const LIST_KINDS = [...ENTRY_KINDS, ...SALES_KINDS, 'stockJournal'] as const;
type ListKind = (typeof LIST_KINDS)[number];
const NEW_TITLES: Readonly<Record<ListKind, string>> = { contra: 'Contra Voucher', payment: 'Payment Voucher', receipt: 'Receipt Voucher', journal: 'Journal Voucher', sales: 'Sales Voucher', salesOrder: 'Sales Order', purchase: 'Purchase Voucher', purchaseOrder: 'Purchase Order', stockJournal: 'Stock Journal' };
const LIST_TITLES: Readonly<Record<ListKind, string>> = { contra: 'Contra Vouchers', payment: 'Payment Vouchers', receipt: 'Receipt Vouchers', journal: 'Journal Vouchers', sales: 'Sales Vouchers', salesOrder: 'Sales Orders', purchase: 'Purchase Vouchers', purchaseOrder: 'Purchase Orders', stockJournal: 'Stock Journal Vouchers' };
const LIST_KEYS: Readonly<Record<ListKind, string>> = { ...KEYS, ...SALES_KEYS, stockJournal: 'F10' };
const LIST_KEYWORDS: Readonly<Record<ListKind, readonly string[]>> = {
  contra: ['list', 'register', 'cash deposit'],
  payment: ['list', 'register', 'payments made'],
  receipt: ['list', 'register', 'collections'],
  journal: ['list', 'register', 'entries'],
  sales: ['list', 'register', 'invoices', 'sales register'],
  salesOrder: ['list', 'register', 'orders', 'customer po'],
  purchase: ['list', 'register', 'bills', 'purchase register', 'supplier invoices'],
  purchaseOrder: ['list', 'register', 'orders', 'supplier orders'],
  stockJournal: ['list', 'register', 'transfers', 'conversion'],
};
const listCommands: Command<AppContext>[] = LIST_KINDS.map((kind) => ({
  id: `voucher.list.${kind}`,
  title: LIST_TITLES[kind],
  category: 'Voucher',
  keywords: LIST_KEYWORDS[kind],
  description: 'Every voucher of this type — open one, or create a new one',
  menuKeyOf: `voucher.new.${kind}`,
  run: (app) => app.navigate({ type: 'report', report: 'vouchers', kind }),
}));
// "New …" on a list's panel (and its F-key while the list is in front): opens the window on top and receives what it made.
const listNewCommands: Command<AppContext>[] = LIST_KINDS.map((kind) => ({
  id: `list.new.${kind}`,
  title: `Create from the ${LIST_TITLES[kind]} list`,
  category: 'Data entry',
  hidden: true,
  configurable: true,
  panel: { label: `New ${NEW_TITLES[kind]}`, group: 'Actions', order: 5, on: ['report'], hideWhenUnavailable: true },
}));

const stockJournalCommand: Command<AppContext> = {
  id: 'voucher.new.stockJournal',
  title: 'New Stock Journal',
  category: 'Voucher',
  keywords: STOCK_JOURNAL_KEYWORDS,
  description: 'Move stock between godowns or convert it — no accounting effect',
  run: (app) => app.navigate({ type: 'voucher', mode: 'create', typeKey: 'stockJournal' }),
  // on every side panel, apart from the voucher types: stock can be adjusted from wherever the person is
  panel: { label: 'Stock Journal', group: 'Stock', order: 19, on: ['voucher', 'report', 'master', 'master-list'] },
};

const switchCommands: Command<AppContext>[] = [...ENTRY_KINDS, ...SALES_KINDS].map((kind, i) => {
  const title = isSalesKind(kind) ? SALES_TITLES[kind] : KIND_TITLES[kind];
  return {
    id: `voucher.switch.${kind}`,
    title: `Switch to ${title}`,
    category: 'Data entry',
    hidden: true,
    configurable: true,
    panel: { label: title, group: 'Voucher type', order: 20 + i, on: ['voucher'] },
  } satisfies Command<AppContext>;
});

const contextual = (id: string, title: string, panel?: NonNullable<Command<AppContext>['panel']>): Command<AppContext> => ({
  id,
  title,
  category: 'Data entry',
  hidden: true,
  configurable: true,
  ...(panel ? { panel } : {}),
});

const commands: Command<AppContext>[] = [
  ...newCommands,
  ...salesCommands,
  stockJournalCommand,
  ...listCommands,
  ...listNewCommands,
  ...switchCommands,
  contextual('voucher.changeDate', 'Change date / period', { label: 'Date', group: 'Actions', order: 10, on: ['voucher', 'report'], labelOn: { report: 'Period' } }),
  contextual('voucher.partyDetails', 'Party details (billing and shipping)', { label: 'Party details', group: 'Actions', order: 13, on: ['voucher'] }),
  contextual('voucher.acceptAndNew', 'Save and start a new one', { label: 'Save & new', group: 'Actions', order: 11.5, on: ['voucher'] }),
  contextual('voucher.againstOrder', 'Deliver or receive against an order', { label: 'Against order', group: 'Actions', order: 12, on: ['voucher'] }),
  contextual('order.invoice', 'Create an invoice for the pending items of this order', { label: 'Invoice pending', group: 'Actions', order: 15, on: ['voucher'] }),
  contextual('voucher.removeLine', 'Remove this line', { label: 'Remove line', group: 'Actions', order: 14, on: ['voucher'] }),
  contextual('voucher.print', 'Print', { label: 'Print', group: 'Actions', order: 16, on: ['voucher'] }),
  contextual('voucher.cancel', 'Cancel this voucher', { label: 'Cancel voucher', group: 'Change', order: 31, on: ['voucher'] }),
  contextual('order.close', 'Close this order', { label: 'Close order', group: 'Change', order: 32, on: ['voucher'] }),
  // What Go To results run for a voucher.
  {
    id: 'voucher.open',
    title: 'Open voucher',
    category: 'Voucher',
    hidden: true,
    configurable: false,
    run: (app, args) => {
      const a = args as { id?: string; mode?: 'display' | 'alter' } | undefined;
      if (a?.id) app.navigate({ type: 'voucher', mode: a.mode ?? 'display', id: a.id });
    },
  },
];

const bindings: DefaultBinding[] = [
  // Everywhere: open a new voucher of that type (the shortcuts the planned commands already had).
  ...ENTRY_KINDS.map((kind) => ({ commandId: `voucher.new.${kind}`, chord: KEYS[kind] })),
  // Inside a voucher: the same keys switch its type.
  ...ENTRY_KINDS.map((kind) => ({ commandId: `voucher.switch.${kind}`, chord: KEYS[kind], scope: 'screen:voucher' })),
  ...SALES_KINDS.map((kind) => ({ commandId: `voucher.new.${kind}`, chord: SALES_KEYS[kind] })),
  ...SALES_KINDS.map((kind) => ({ commandId: `voucher.switch.${kind}`, chord: SALES_KEYS[kind], scope: 'screen:voucher' })),
  { commandId: 'voucher.againstOrder', chord: 'Alt+O', scope: 'screen:voucher' },
  { commandId: 'order.close', chord: 'Alt+K', scope: 'screen:voucher' },
  { commandId: 'order.invoice', chord: 'Alt+I', scope: 'screen:voucher' },
  { commandId: 'voucher.new.stockJournal', chord: 'F10' },
  { commandId: 'voucher.acceptAndNew', chord: 'Alt+N', scope: 'screen:voucher' },
  // On a voucher list, the keys that make a voucher of that type make it FROM the list (so the list gets the result back).
  ...LIST_KINDS.map((kind) => ({ commandId: `list.new.${kind}`, chord: LIST_KEYS[kind], scope: 'screen:report' })),
  { commandId: 'voucher.changeDate', chord: 'F2' },
  { commandId: 'voucher.partyDetails', chord: 'Alt+P', scope: 'screen:voucher' },
  { commandId: 'voucher.cancel', chord: 'Alt+X', scope: 'screen:voucher' },
  { commandId: 'voucher.removeLine', chord: 'Ctrl+Delete', scope: 'screen:voucher' },
  { commandId: 'voucher.print', chord: 'Ctrl+P', scope: 'screen:voucher' },
];

const GROUPS: Readonly<Record<ListKind, { group: string; order: number }>> = {
  sales: { group: 'Sales', order: 1 },
  salesOrder: { group: 'Sales', order: 2 },
  purchase: { group: 'Purchase', order: 10 },
  purchaseOrder: { group: 'Purchase', order: 11 },
  stockJournal: { group: 'Inventory', order: 20 },
  contra: { group: 'General', order: 30 },
  payment: { group: 'General', order: 31 },
  receipt: { group: 'General', order: 32 },
  journal: { group: 'General', order: 33 },
};
const menu: MenuEntry[] = LIST_KINDS.map((kind) => ({ section: 'transactions', commandId: `voucher.list.${kind}`, order: GROUPS[kind].order, group: GROUPS[kind].group }));

export const vouchersModule: ModuleManifest<AppContext> = {
  id: 'vouchers',
  commands,
  bindings,
  menu,
  providers: [
    {
      // Vouchers by number, party, narration or amount. Unscoped searches include them only when the text looks like a number or a
      // voucher number (so "rent" finds the ledger, and "12000" or "PAY/" finds vouchers); `v:` searches them always.
      id: 'vouchers',
      scopes: ['voucher'],
      search(query, context) {
        const books = context.app.books.current;
        if (!books) return [];
        if (query.scope === undefined && !/[0-9/]/.test(query.text)) return [];
        return searchEntities(voucherDocsOf(books), query.text, { scope: 'voucher', limit: 15 });
      },
    },
  ],
};
