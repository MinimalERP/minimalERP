import type { Command, DefaultBinding, MenuEntry, ModuleManifest } from '@minimalerp/command';
import type { AppContext } from '../shell/services';

/**
 * THE PLANNED COMMANDS. Everything the finished product will let you do already has its name, its
 * category, its keywords and (where the plan fixes one) its shortcut — so Go To, the Gateway and the
 * shortcut editor are exercised for real now, and the shortcuts you learn will not move.
 *
 * (Masters and company settings are real now: see masters.ts.)
 *
 * Each opens a "planned" screen that says which phase delivers it. When a feature is built, its module
 * REPLACES its entry here with the real command (same id) — nothing else in the app changes.
 */
export const PHASES: Readonly<Record<number, string>> = {
  4: 'Masters & the search index',
  5: 'Accounting vouchers & first books',
  6: 'Books & reports',
  7: 'Inventory, Sales & Purchase, GST',
  8: 'Orders & documents',
};

const planned = (
  id: string,
  title: string,
  category: string,
  phase: number,
  extra: Partial<Command<AppContext>> = {},
): Command<AppContext> => ({
  id,
  title,
  category,
  badge: `Phase ${phase}`,
  description: `Planned — arrives with Phase ${phase}: ${PHASES[phase]}`,
  run: (app) => app.navigate({ type: 'planned', id }),
  ...extra,
});

// Contra, Payment, Receipt, Journal, Sales, Sales Order and the Stock Journal are real now (modules/vouchers.ts).
const vouchers: Command<AppContext>[] = [
  planned('voucher.new.creditNote', 'New Credit Note', 'Voucher', 7, { keywords: ['sales return'] }),
  planned('voucher.new.debitNote', 'New Debit Note', 'Voucher', 7, { keywords: ['purchase return'] }),
];

// Every report is real now (modules/reports.ts), GST reports included; GST itself is a switch on the Company (Charge GST) with rates in the GST Rate master.
const reports: Command<AppContext>[] = [];

const settings: Command<AppContext>[] = [];

const bindings: DefaultBinding[] = [];

// Where the planned vouchers sit in the grouped Transactions screen (the real ones are placed by modules/vouchers.ts).
const VOUCHER_GROUPS: Readonly<Record<string, { group: string; order: number }>> = {
  'voucher.new.creditNote': { group: 'Sales', order: 3 },
  'voucher.new.debitNote': { group: 'Purchase', order: 12 },
};

const entry = (section: string, commandId: string, order: number): MenuEntry => ({ section, commandId, order });

const menu: MenuEntry[] = [
  ...vouchers.map((c) => ({ ...entry('transactions', c.id, VOUCHER_GROUPS[c.id]?.order ?? 40), group: VOUCHER_GROUPS[c.id]?.group ?? 'General' })),
  ...reports.map((c, i) => ({ ...entry('reports', c.id, i + 40), group: 'Tax' })), // (the real reports are placed by modules/reports.ts)
  ...settings.map((c, i) => entry('utilities', c.id, i + 10)), // after the company settings (masters module)
];

export const roadmapModule: ModuleManifest<AppContext> = {
  id: 'roadmap',
  commands: [...vouchers, ...reports, ...settings],
  bindings,
  menuSections: [
    { id: 'masters', title: 'Masters', order: 1, description: 'Ledgers, parties, stock items and other records' },
    { id: 'transactions', title: 'Transactions', order: 2, description: 'Vouchers: payments, receipts, sales, purchases…' },
    { id: 'reports', title: 'Reports', order: 3, description: 'Books, statements and registers' },
  ],
  menu,
};
