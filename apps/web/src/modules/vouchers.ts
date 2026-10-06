import { type Command, type DefaultBinding, type MenuEntry, type ModuleManifest, searchEntities } from '@minimalerp/command';
import { voucherDocsOf } from '../books/voucherDocs';
import { CHALLAN_KIND, ENTRY_KINDS, NOTE_KINDS, NOTE_TITLES, type NoteKind, RETURNABLE_KIND, type EntryKind, KIND_TITLES, QUOTATION_KIND, SALES_KINDS, SALES_TITLES, type SalesKind, isSalesKind } from '../vouchers/kinds';
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
  // Opened by its key, a voucher is in FAST ENTRY: saving starts the next one of the same type (a list's own New closes back to the list).
  run: (app) => app.navigate({ type: 'voucher', mode: 'create', typeKey: kind, fast: true }),
}));

// The Sales and Purchase Invoices and Orders are item-line documents on their own window. They REPLACE the planned entries of the same ids.
const salesCommands: Command<AppContext>[] = SALES_KINDS.map((kind) => ({
  id: `voucher.new.${kind}`,
  title: SALES_COMMAND_TITLES[kind],
  category: 'Voucher',
  keywords: SALES_KEYWORDS[kind],
  description: SALES_DESCRIPTIONS[kind],
  run: (app) => app.navigate({ type: 'voucher', mode: 'create', typeKey: kind, fast: true }),
}));

const quotationCommand: Command<AppContext> = {
  id: 'voucher.new.quotation',
  title: 'New Quotation',
  category: 'Voucher',
  keywords: ['quote', 'estimate', 'quotation', 'proposal'],
  description: 'What you offered a customer — items, quantities and rates — posts nothing to the accounts or the stock',
  run: (app) => app.navigate({ type: 'voucher', mode: 'create', typeKey: QUOTATION_KIND, fast: true }),
};

// The Delivery Challan: goods out without a bill (invoiced later, or free of cost) — one number series whatever the purpose.
const challanCommand: Command<AppContext> = {
  id: 'voucher.new.deliveryChallan',
  title: 'New Delivery Challan',
  category: 'Voucher',
  keywords: ['delivery challan', 'delivery note', 'dc', 'dispatch', 'foc', 'free of cost', 'sample'],
  description: 'Goods sent out without a bill — to be invoiced later, or free of cost. Takes the stock out; posts nothing to the accounts',
  run: (app) => app.navigate({ type: 'voucher', mode: 'create', typeKey: CHALLAN_KIND, fast: true }),
};

// The Returnable Challan: goods to a supplier that come back as they went ("Mark returned" on it brings them back).
const returnableCommand: Command<AppContext> = {
  id: 'voucher.new.returnableChallan',
  title: 'New Returnable Challan',
  category: 'Voucher',
  keywords: ['returnable challan', 'rc', 'repair', 'sample', 'approval', 'send to supplier', 'returnable'],
  description: 'Goods sent to a supplier to come back (repair, testing, approval) — takes the stock out until you mark it returned',
  run: (app) => app.navigate({ type: 'voucher', mode: 'create', typeKey: RETURNABLE_KIND, fast: true }),
};

// The Credit Note and the Debit Note (ADR-0026): an invoice taken back. They REPLACE the planned entries of the same ids.
const NOTE_KEYWORDS: Readonly<Record<NoteKind, readonly string[]>> = {
  creditNote: ['credit note', 'cn', 'sales return', 'return from customer', 'goods returned', 'rate difference', 'discount after sale'],
  debitNote: ['debit note', 'dn', 'purchase return', 'return to supplier', 'goods sent back', 'rate difference', 'short supply'],
};
const NOTE_DESCRIPTIONS: Readonly<Record<NoteKind, string>> = {
  creditNote: 'A sale taken back — goods returned by a customer, or a price reduced: reverses the sale and its GST, brings the stock back in, and is set against the invoice',
  debitNote: 'A purchase taken back — goods sent back to a supplier, or a price reduced: reverses the purchase and its GST, takes the stock out, and is set against the supplier’s bill',
};
const noteCommands: Command<AppContext>[] = NOTE_KINDS.map((kind) => ({
  id: `voucher.new.${kind}`,
  title: `New ${NOTE_TITLES[kind]}`,
  category: 'Voucher',
  keywords: NOTE_KEYWORDS[kind],
  description: NOTE_DESCRIPTIONS[kind],
  run: (app) => app.navigate({ type: 'voucher', mode: 'create', typeKey: kind, fast: true }),
}));

// The Stock Journal moves stock, not money: it is opened from anywhere (F10) and has its own columns, so it is not one of the keys that switch type inside an accounting voucher.
// One LIST per voucher type (Transactions › Sales › Sales Vouchers): every voucher of that type, with New. The window it opens closes back here.
const LIST_KINDS = [...ENTRY_KINDS, ...SALES_KINDS, QUOTATION_KIND, 'stockJournal', CHALLAN_KIND, RETURNABLE_KIND, ...NOTE_KINDS] as const;
type ListKind = (typeof LIST_KINDS)[number];
const NEW_TITLES: Readonly<Record<ListKind, string>> = { contra: 'Contra Voucher', payment: 'Payment Voucher', receipt: 'Receipt Voucher', journal: 'Journal Voucher', sales: 'Sales Voucher', salesOrder: 'Sales Order', quotation: 'Quotation', purchase: 'Purchase Voucher', purchaseOrder: 'Purchase Order', stockJournal: 'Stock Journal', deliveryChallan: 'Delivery Challan', returnableChallan: 'Returnable Challan', creditNote: 'Credit Note', debitNote: 'Debit Note' };
const LIST_TITLES: Readonly<Record<ListKind, string>> = { contra: 'Contra Vouchers', payment: 'Payment Vouchers', receipt: 'Receipt Vouchers', journal: 'Journal Vouchers', sales: 'Sales Vouchers', salesOrder: 'Sales Orders', quotation: 'Quotations', purchase: 'Purchase Vouchers', purchaseOrder: 'Purchase Orders', stockJournal: 'Stock Journal Vouchers', deliveryChallan: 'Delivery Challans', returnableChallan: 'Returnable Challans', creditNote: 'Credit Notes', debitNote: 'Debit Notes' };
const LIST_KEYS: Readonly<Record<ListKind, string>> = { ...KEYS, ...SALES_KEYS, quotation: '', stockJournal: 'F10', deliveryChallan: 'Alt+F8', returnableChallan: '', creditNote: '', debitNote: '' };
const LIST_KEYWORDS: Readonly<Record<ListKind, readonly string[]>> = {
  contra: ['list', 'register', 'cash deposit'],
  payment: ['list', 'register', 'payments made'],
  receipt: ['list', 'register', 'collections'],
  journal: ['list', 'register', 'entries'],
  sales: ['list', 'register', 'invoices', 'sales register'],
  salesOrder: ['list', 'register', 'orders', 'customer po'],
  quotation: ['list', 'register', 'quotes', 'estimates'],
  purchase: ['list', 'register', 'bills', 'purchase register', 'supplier invoices'],
  purchaseOrder: ['list', 'register', 'orders', 'supplier orders'],
  stockJournal: ['list', 'register', 'transfers', 'conversion'],
  deliveryChallan: ['list', 'register', 'challans', 'dc', 'dispatch', 'foc'],
  returnableChallan: ['list', 'register', 'returnable', 'rc', 'repair', 'sent to supplier'],
  creditNote: ['list', 'register', 'credit notes', 'cn', 'sales returns'],
  debitNote: ['list', 'register', 'debit notes', 'dn', 'purchase returns'],
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
  run: (app) => app.navigate({ type: 'voucher', mode: 'create', typeKey: 'stockJournal', fast: true }),
  // on every side panel, apart from the voucher types: stock can be adjusted from wherever the person is
  panel: { label: 'Stock Journal', group: 'Stock', order: 19, on: ['voucher', 'report', 'master', 'master-list'], fold: 'Inventory' },
};

const switchCommands: Command<AppContext>[] = [...ENTRY_KINDS, ...SALES_KINDS].map((kind, i) => {
  const title = isSalesKind(kind) ? SALES_TITLES[kind] : KIND_TITLES[kind];
  return {
    id: `voucher.switch.${kind}`,
    title: `Switch to ${title}`,
    category: 'Data entry',
    hidden: true,
    configurable: true,
    panel: { label: title, group: 'Voucher type', order: 20 + i, on: ['voucher'], fold: 'Other' },
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

// The AI Inbox (ADR-0023): documents sent from Gmail, read into proposals that wait for a person.
const inboxCommand: Command<AppContext> = {
  id: 'inbox.open',
  title: 'AI Inbox',
  category: 'Voucher',
  keywords: ['inbox', 'ai', 'gemini', 'gmail', 'mail', 'email', 'documents', 'proposals', 'auto entry'],
  description: 'Vouchers proposed from documents you sent from Gmail — check, complete and accept them',
  run: (app) => app.navigate({ type: 'inbox' }),
};

// What this company sent to the owner's other companies through the ERP (ADR-0025), and whether each was accepted there.
const sentCommand: Command<AppContext> = {
  id: 'exchange.sent',
  title: 'Sent to Companies',
  category: 'Voucher',
  keywords: ['sent', 'send via erp', 'exchange', 'intercompany', 'other company', 'group', 'accepted', 'rejected', 'status'],
  description: 'Vouchers sent to your other companies via the ERP: sent, accepted or rejected',
  when: (app) => app.books.current?.canSendToCompanies === true,
  run: (app) => app.navigate({ type: 'exchange-sent' }),
};

// The quote enquiries sent from the company's website (they arrive in the ERP's database; the online books only).
const websiteEnquiriesCommand: Command<AppContext> = {
  id: 'website.enquiries',
  title: 'Website Enquiries',
  category: 'Voucher',
  keywords: ['website', 'enquiry', 'enquiries', 'inquiry', 'rfq', 'quote request', 'lead', 'leads', 'customer', 'drawing'],
  description: 'Quote requests from the website: call, WhatsApp, email, drawing, status, convert',
  // the online books only (the website writes into the ERP's database): the same test as Send via ERP
  when: (app) => app.books.current?.canSendToCompanies === true,
  run: (app) => app.navigate({ type: 'website-enquiries' }),
};

const commands: Command<AppContext>[] = [
  inboxCommand,
  sentCommand,
  websiteEnquiriesCommand,
  contextual('inbox.reject', 'Reject this proposal', { label: 'Reject', group: 'Change', order: 31, on: ['inbox'] }),
  contextual('inbox.upload', 'Upload a document (PDF or photo) to be read', { label: 'Upload document', group: 'Actions', order: 5, on: ['inbox'] }),
  contextual('inbox.camera', 'Take a photo of a document to be read', { label: 'Take photo', group: 'Actions', order: 6, on: ['inbox'] }),
  ...newCommands,
  ...salesCommands,
  quotationCommand,
  ...noteCommands,
  challanCommand,
  returnableCommand,
  stockJournalCommand,
  ...listCommands,
  ...listNewCommands,
  ...switchCommands,
  contextual('voucher.changeDate', 'Change date / period', { label: 'Date', group: 'Actions', order: 10, on: ['voucher', 'report', 'import-export'], labelOn: { report: 'Period', 'import-export': 'Export period' } }),
  contextual('voucher.partyDetails', 'Party details (billing and shipping)', { label: 'Party details', group: 'Actions', order: 13, on: ['voucher'] }),
  contextual('voucher.acceptAndNew', 'Save and start a new one', { label: 'Save & new', group: 'Actions', order: 11.5, on: ['voucher'] }),
  contextual('voucher.againstOrder', 'Deliver or receive against an order', { label: 'Against order', group: 'Actions', order: 12, on: ['voucher'] }),
  contextual('voucher.paidFrom', 'Paid from: pay this purchase now from cash or a bank (a Payment is saved with it)', { label: 'Paid from', group: 'Actions', order: 12.5, on: ['voucher'], hideWhenUnavailable: true }),
  contextual('voucher.applyCredit', 'Apply credit: set the advances paid to this supplier against this bill', { label: 'Apply credit', group: 'Actions', order: 12.6, on: ['voucher'], hideWhenUnavailable: true }),
  contextual('voucher.applyToBills', 'Apply to bills: set this advance against the supplier’s open bills', { label: 'Apply to bills', group: 'Actions', order: 12.7, on: ['voucher'], hideWhenUnavailable: true }),
  contextual('order.invoice','Create an invoice for the pending items of this order', { label: 'Invoice pending', group: 'Actions', order: 15, on: ['voucher'], fold: 'Inventory', labelIn: { 'voucher:lines-selected': 'Invoice selected' } }),
  // on a Sales invoice it makes its credit note; on a Purchase invoice (the window says so with a scope) its debit note
  contextual('invoice.note', 'Credit / debit note for this invoice: goods returned or a price reduced', { label: 'Credit note', group: 'Actions', order: 15.1, on: ['voucher'], hideWhenUnavailable: true, labelIn: { 'voucher:purchase-invoice': 'Debit note' } }),
  contextual('challan.markReturned', 'Mark returned: the goods have come back from the supplier', { label: 'Mark returned', group: 'Actions', order: 15.2, on: ['voucher'], hideWhenUnavailable: true }),
  contextual('quotation.order', 'Create a sales order from this quotation', { label: 'Sales order', group: 'Actions', order: 15.5, on: ['voucher'], hideWhenUnavailable: true }),
  contextual('voucher.removeLine', 'Remove this line', { label: 'Remove line', group: 'Actions', order: 14, on: ['voucher'] }),
  contextual('voucher.oneTimeLine', 'One-time line: write it instead of choosing a stock item', { label: 'One-time line', group: 'Actions', order: 14.5, on: ['voucher'], hideWhenUnavailable: true }),
  contextual('voucher.print', 'Print', { label: 'Print', group: 'Actions', order: 16, on: ['voucher'], fold: 'Print' }),
  contextual('voucher.docket', 'Dispatch docket: print the invoices and their items for the transporter', { label: 'Dispatch docket', group: 'Actions', order: 16.2, on: ['voucher', 'report'], hideWhenUnavailable: true, fold: 'Print' }),
  // Select is a switch: on, the rows (a list's vouchers, an order's lines) show tick boxes; off, the boxes go and nothing stays ticked.
  contextual('list.select', 'Select: show or hide the tick boxes', { label: 'Select', group: 'Actions', order: 6, on: ['report', 'voucher'], hideWhenUnavailable: true }),
  contextual('list.pick', 'Tick or untick this row (switches Select on)'),
  contextual('voucher.email', 'Email this to the party (from your Gmail)', { label: 'Email', group: 'Actions', order: 16.5, on: ['voucher'], hideWhenUnavailable: true, fold: 'Email' }),
  contextual('voucher.remind', 'Payment reminder: email the customer this invoice with its payment status', { label: 'Payment reminder', group: 'Actions', order: 16.55, on: ['voucher'], hideWhenUnavailable: true, fold: 'Email' }),
  contextual('voucher.sendErp', 'Send via ERP to your company with this party’s GSTIN (lands in its inbox)', { label: 'Send via ERP', group: 'Actions', order: 16.6, on: ['voucher'], hideWhenUnavailable: true, fold: 'Email' }),
  contextual('voucher.cancel', 'Cancel this voucher', { label: 'Cancel voucher', group: 'Change', order: 31, on: ['voucher'] }),
  contextual('order.close', 'Close this order', { label: 'Close order', group: 'Change', order: 32, on: ['voucher'], fold: 'Inventory' }),
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
  { commandId: 'quotation.order', chord: 'Alt+Shift+O', scope: 'screen:voucher' },
  { commandId: 'invoice.note', chord: 'Alt+Shift+R', scope: 'screen:voucher' },
  { commandId: 'voucher.email', chord: 'Alt+Shift+E', scope: 'screen:voucher' },
  { commandId: 'voucher.sendErp', chord: 'Alt+Shift+S', scope: 'screen:voucher' },
  { commandId: 'voucher.new.stockJournal', chord: 'F10' },
  { commandId: 'voucher.new.deliveryChallan', chord: 'Alt+F8' },
  { commandId: 'voucher.acceptAndNew', chord: 'Alt+N', scope: 'screen:voucher' },
  // On a voucher list, the keys that make a voucher of that type make it FROM the list (so the list gets the result back).
  ...LIST_KINDS.filter((kind) => LIST_KEYS[kind] !== '').map((kind) => ({ commandId: `list.new.${kind}`, chord: LIST_KEYS[kind], scope: 'screen:report' })),
  { commandId: 'voucher.changeDate', chord: 'F2' },
  { commandId: 'voucher.partyDetails', chord: 'Alt+P', scope: 'screen:voucher' },
  { commandId: 'voucher.cancel', chord: 'Alt+X', scope: 'screen:voucher' },
  { commandId: 'inbox.reject', chord: 'Alt+X', scope: 'screen:inbox' },
  { commandId: 'inbox.upload', chord: 'Alt+U', scope: 'screen:inbox' },
  { commandId: 'inbox.camera', chord: 'Alt+P', scope: 'screen:inbox' },
  { commandId: 'voucher.removeLine', chord: 'Ctrl+Delete', scope: 'screen:voucher' },
  { commandId: 'voucher.oneTimeLine', chord: 'Alt+T', scope: 'screen:voucher' },
  { commandId: 'voucher.print', chord: 'Ctrl+P', scope: 'screen:voucher' },
  // a sales invoice's window and the Sales list both make a dispatch docket
  { commandId: 'voucher.docket', chord: 'Alt+D' },
  // a list's rows and an order window's lines are both ticked with it
  { commandId: 'list.pick', chord: 'Ctrl+Space' },
];

const GROUPS: Readonly<Record<ListKind, { group: string; order: number }>> = {
  sales: { group: 'Sales', order: 1 },
  salesOrder: { group: 'Sales', order: 2 },
  quotation: { group: 'Sales', order: 3 },
  purchase: { group: 'Purchase', order: 10 },
  purchaseOrder: { group: 'Purchase', order: 11 },
  stockJournal: { group: 'Inventory', order: 20 },
  deliveryChallan: { group: 'Sales', order: 4 },
  returnableChallan: { group: 'Purchase', order: 14 },
  creditNote: { group: 'Sales', order: 2.5 },
  debitNote: { group: 'Purchase', order: 12 },
  contra: { group: 'General', order: 30 },
  payment: { group: 'General', order: 31 },
  receipt: { group: 'General', order: 32 },
  journal: { group: 'General', order: 33 },
};
const menu: MenuEntry[] = [
  ...LIST_KINDS.map((kind) => ({ section: 'transactions', commandId: `voucher.list.${kind}`, order: GROUPS[kind].order, group: GROUPS[kind].group })),
  // last, so the voucher lists keep their places (and their arrow-key positions)
  { section: 'transactions', commandId: 'inbox.open', order: 40, group: 'AI Inbox' },
  { section: 'transactions', commandId: 'exchange.sent', order: 41, group: 'AI Inbox' },
  { section: 'transactions', commandId: 'website.enquiries', order: 42, group: 'AI Inbox' },
];

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
