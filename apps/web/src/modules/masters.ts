import { searchEntities, type Command, type DefaultBinding, type MenuEntry, type ModuleManifest } from '@minimalerp/command';
import type { MasterKind } from '@minimalerp/domain';
import { PLURALS } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { ENTITY_SCOPES, entityDocsOf } from '../books/entities';
import { FORMS } from '../books/forms';
import type { AppContext } from '../shell/services';

/**
 * Masters and company settings: create, list, display and alter every kind of master record, and make each of them
 * findable from Go To. These REPLACE the planned entries that used to stand in for them (same command ids), so the
 * shortcuts and Gateway rows people already know do not move.
 */

interface Create {
  readonly kind: MasterKind;
  readonly id: string;
  readonly keywords: readonly string[];
}

// The seven originally planned creations, with their command ids kept exactly. (GST rates are made from their list: Alt+C.)
const CREATES: readonly Create[] = [
  { kind: 'ledger', id: 'master.create.ledger', keywords: ['account', 'new'] },
  { kind: 'group', id: 'master.create.group', keywords: ['account group'] },
  { kind: 'party', id: 'master.create.party', keywords: ['customer', 'supplier', 'vendor', 'gstin'] },
  { kind: 'stockItem', id: 'master.create.stockItem', keywords: ['product', 'material', 'hsn'] },
  { kind: 'stockGroup', id: 'master.create.stockGroup', keywords: ['item group'] },
  { kind: 'unit', id: 'master.create.unit', keywords: ['uom', 'measure'] },
  { kind: 'warehouse', id: 'master.create.warehouse', keywords: ['godown', 'location'] },
];

const LISTS: readonly MasterKind[] = ['ledger', 'group', 'party', 'stockItem', 'stockGroup', 'unit', 'warehouse', 'gstRate', 'voucherType', 'numberingSeries'];

const NEEDS_COMPANY = (app: AppContext) => app.books.current !== undefined;

const createCommands: Command<AppContext>[] = CREATES.map(({ kind, id, keywords }) => ({
  id,
  title: `Create ${FORMS[kind].noun}`,
  category: 'Create',
  keywords,
  // Without a company there is nowhere to put it: the command takes you to creating one first.
  run: (app) => (app.books.current ? app.navigate({ type: 'master', kind, mode: 'create' }) : app.navigate({ type: 'company-new' })),
}));

const listCommands: Command<AppContext>[] = LISTS.map((kind) => ({
  id: kind === 'voucherType' ? 'settings.voucherTypes' : kind === 'numberingSeries' ? 'settings.numbering' : `master.list.${kind}`,
  title: PLURALS[kind],
  category: kind === 'voucherType' || kind === 'numberingSeries' ? 'Settings' : 'Masters',
  description: `Find, display or alter ${PLURALS[kind].toLowerCase()}`,
  keywords: kind === 'voucherType' ? ['configure vouchers'] : kind === 'numberingSeries' ? ['voucher numbers'] : ['display', 'alter', 'browse'],
  run: (app) => (app.books.current ? app.navigate({ type: 'master-list', kind }) : app.navigate({ type: 'company-new' })),
}));

const commands: Command<AppContext>[] = [
  ...createCommands,
  ...listCommands,
  {
    id: 'settings.company',
    title: 'Company Settings',
    category: 'Settings',
    keywords: ['financial year', 'books', 'gstin', 'address'],
    run: (app) => {
      const books = app.books.current;
      if (!books) app.navigate({ type: 'company-new' });
      else app.navigate({ type: 'master', kind: 'company', mode: 'display', id: books.masters.company.id });
    },
  },
  {
    id: 'settings.invoicePdf',
    title: 'Invoice / PDF Settings',
    category: 'Settings',
    keywords: ['print', 'bank details', 'terms', 'thank you', 'phone', 'email', 'stamp', 'signature'],
    description: 'What a printed voucher carries beyond the transaction: phone, email, bank details, a thank-you note and terms',
    when: NEEDS_COMPANY,
    run: (app) => app.navigate({ type: 'invoice-settings' }),
  },
  {
    id: 'settings.printLayouts',
    title: 'Print Layouts',
    category: 'Settings',
    keywords: ['print', 'layout', 'template', 'html', 'invoice design', 'logo', 'signature', 'pdf', 'format'],
    description: 'This company’s own print layout (simple HTML) for invoices, orders and vouchers, with its logo and signature',
    when: (app) => app.books.current?.canEditPrintLayouts === true,
    run: (app) => app.navigate({ type: 'print-layouts' }),
  },
  {
    id: 'company.create',
    title: 'Create Company',
    category: 'Company',
    keywords: ['new company', 'onboarding', 'books', 'financial year'],
    description: 'Start a company’s books: name, financial year and GSTIN',
    when: (app) => app.books.canCreate && (!NEEDS_COMPANY(app) || (app.books.canSwitch && app.books.ownsOpenCompany)),
    run: (app) => app.navigate({ type: 'company-new' }),
  },
  {
    id: 'company.loadDemo',
    title: 'Load Demo Company',
    category: 'Company',
    keywords: ['sample', 'example', 'try', 'demo data'],
    description: 'A ready-made manufacturer with ledgers, parties and stock items to explore',
    when: (app) => !NEEDS_COMPANY(app) && app.books.canCreate && app.books.canLoadDemo,
    run: (app) => {
      void loadDemoCompany(app.books).then((result) => {
        if (result.ok) app.goHome();
        else console.error('Could not load the demo company', result.issues);
      });
    },
  },
  {
    id: 'company.switch',
    title: 'Switch Company',
    category: 'Company',
    keywords: ['change company', 'open company', 'other company', 'select company'],
    description: 'Open another of your companies',
    when: (app) => NEEDS_COMPANY(app) && app.books.canSwitch && app.books.ownsOpenCompany,
    run: (app) => app.navigate({ type: 'company-switch' }),
  },
  {
    id: 'company.user',
    title: 'Company User',
    category: 'Settings',
    keywords: ['user', 'access', 'login', 'staff', 'member', 'email', 'password', 'share'],
    description: 'The one extra person who may use this company (and no other): link their account by its email',
    when: (app) => NEEDS_COMPANY(app) && app.books.canManageUser,
    run: (app) => app.navigate({ type: 'company-user' }),
  },
  {
    id: 'company.gmail',
    title: 'Company Gmail',
    category: 'Settings',
    keywords: ['email', 'mail', 'gmail', 'send', 'script', 'google'],
    description: 'The Gmail this company emails vouchers from: its own script’s address and secret',
    when: (app) => NEEDS_COMPANY(app) && app.books.canManageUser,
    run: (app) => app.navigate({ type: 'company-gmail' }),
  },
  {
    id: 'company.reset',
    title: 'Close Company',
    category: 'Company',
    keywords: ['delete', 'start over', 'reset', 'remove data'],
    description: 'Delete this browser’s copy of the company and start again',
    when: (app) => NEEDS_COMPANY(app) && app.books.canClose,
    run: (app) => app.navigate({ type: 'company-reset' }),
  },

  // What Go To results run. Not a place you go, so it is hidden from the command list.
  {
    id: 'master.open',
    title: 'Open master record',
    category: 'Masters',
    hidden: true,
    configurable: false,
    run: (app, args) => {
      const a = args as { kind?: MasterKind; id?: string; mode?: 'display' | 'alter' } | undefined;
      if (!a?.kind || !a.id) return;
      app.navigate({ type: 'master', kind: a.kind, mode: a.mode ?? 'display', id: a.id });
    },
  },

  // Contextual: the form / list in front supplies the behaviour.
  {
    id: 'master.createInline',
    title: 'Create new record from here',
    category: 'Data entry',
    hidden: true,
    configurable: true,
    panel: { label: 'Create new', group: 'Actions', order: 12, on: ['voucher', 'master', 'master-list'], labelOn: { voucher: 'Create ledger / party' } },
  },
  {
    id: 'voucher.accept',
    title: 'Accept / save',
    category: 'Data entry',
    hidden: true,
    configurable: true,
    panel: { label: 'Accept', group: 'Actions', order: 11, on: ['voucher', 'master'] },
  },
  {
    id: 'master.alter',
    title: 'Alter this record',
    category: 'Data entry',
    hidden: true,
    configurable: true,
    panel: { label: 'Alter', group: 'Change', order: 30, on: ['voucher', 'master', 'master-list'] },
  },
  // The record's own report, straight from the master: a ledger's or party's Ledger report, an item's Stock ledger. Shown on the panel only while
  // the screen has a record it applies to (a ledger or party; a stock item that holds stock).
  {
    id: 'master.ledgerReport',
    title: 'Open the ledger report of this record',
    category: 'Data entry',
    hidden: true,
    configurable: true,
    panel: { label: 'Ledger report', group: 'Reports', order: 40, on: ['master', 'master-list'], hideWhenUnavailable: true },
  },
  {
    id: 'master.stockLedger',
    title: 'Open the stock ledger of this item',
    category: 'Data entry',
    hidden: true,
    configurable: true,
    panel: { label: 'Stock ledger', group: 'Reports', order: 41, on: ['master', 'master-list'], hideWhenUnavailable: true },
  },
  {
    id: 'master.toggleActive',
    title: 'Deactivate / reactivate this record',
    category: 'Data entry',
    hidden: true,
    configurable: true,
    panel: { label: 'Deactivate', group: 'Change', order: 32, on: ['master'] },
  },
  {
    id: 'master.advanceSeries',
    title: 'Set the next number',
    category: 'Data entry',
    hidden: true,
    configurable: true,
    panel: { label: 'Next number…', group: 'Change', order: 33, on: ['master'], hideWhenUnavailable: true },
  },
];

const bindings: DefaultBinding[] = [
  { commandId: 'company.switch', chord: 'Alt+F3' },
  { commandId: 'voucher.accept', chord: 'Ctrl+A' },
  { commandId: 'master.createInline', chord: 'Alt+C' },
  { commandId: 'master.alter', chord: 'Alt+A' },
  { commandId: 'master.toggleActive', chord: 'Alt+X' },
  { commandId: 'master.advanceSeries', chord: 'Alt+N' },
  { commandId: 'master.ledgerReport', chord: 'Alt+R' },
  { commandId: 'master.stockLedger', chord: 'Alt+E' },
];

const entry = (section: string, commandId: string, order: number): MenuEntry => ({ section, commandId, order });

// The Masters menu lists each kind once (Ledgers, Groups…); creating is Alt+C inside a list. The "Create Ledger"-style commands
// still exist for Go To and shortcuts, they just do not crowd the menu.
const menu: MenuEntry[] = [
  ...LISTS.filter((k) => k !== 'voucherType' && k !== 'numberingSeries').map((k, i) => entry('masters', `master.list.${k}`, i + 1)),
  entry('utilities', 'settings.company', 5),
  entry('utilities', 'company.user', 5.5),
  entry('utilities', 'company.gmail', 5.6),
  entry('utilities', 'settings.invoicePdf', 6),
  entry('utilities', 'settings.printLayouts', 6.5),
  entry('utilities', 'settings.voucherTypes', 7),
  entry('utilities', 'settings.numbering', 8),
  entry('utilities', 'company.create', 2),
  entry('utilities', 'company.switch', 1),
  entry('utilities', 'company.loadDemo', 3),
  entry('utilities', 'company.reset', 4),
];

export const mastersModule: ModuleManifest<AppContext> = {
  id: 'masters',
  commands,
  bindings,
  menu,
  providers: [
    {
      // Ledgers, groups, parties, items, units, warehouses… straight from the open company's master data.
      // The snapshot is immutable and cached per version, so a new record is searchable the instant it exists.
      id: 'masters',
      scopes: ENTITY_SCOPES,
      search(query, context) {
        const books = context.app.books.current;
        if (!books) return [];
        return searchEntities(entityDocsOf(books.masters), query.text, { scope: query.scope });
      },
    },
  ],
};
