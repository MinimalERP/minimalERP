import type { Command, DefaultBinding, MenuEntry, ModuleManifest } from '@minimalerp/command';
import type { AppContext } from '../shell/services';

/**
 * Bulk Import / Export via CSV (ADR-0026): Items and Parties import directly (master data, nothing to review
 * row by row); Vouchers and Sales Orders import via the same AI Inbox staged review as any other document.
 * Export always produces exactly the columns Import reads back in.
 */
const openCommand: Command<AppContext> = {
  id: 'io.open',
  title: 'Import / Export',
  category: 'Data',
  keywords: ['csv', 'bulk', 'import', 'export', 'items', 'parties', 'contacts', 'vouchers', 'spreadsheet'],
  description: 'Bulk-load or export Items, Parties and Vouchers/Sales Orders as CSV',
  run: (app) => app.navigate({ type: 'import-export' }),
};

const contextual = (id: string, title: string, panel: NonNullable<Command<AppContext>['panel']>): Command<AppContext> => ({
  id,
  title,
  category: 'Data',
  hidden: true,
  configurable: true,
  panel,
});

const commands: Command<AppContext>[] = [
  openCommand,
  contextual('io.cycleKind', 'Switch Items / Parties / Vouchers', { label: 'Switch kind', group: 'Actions', order: 1, on: ['import-export'] }),
  contextual('io.upload', 'Import a CSV file', { label: 'Import CSV', group: 'Actions', order: 2, on: ['import-export'] }),
  contextual('io.export', 'Export as CSV', { label: 'Export CSV', group: 'Actions', order: 3, on: ['import-export'] }),
  contextual('io.types', 'Choose which vouchers to export', { label: 'Voucher types', group: 'Actions', order: 4, on: ['import-export'] }),
  contextual('io.template', 'Download a sample CSV to fill in', { label: 'Sample file', group: 'Actions', order: 5, on: ['import-export'] }),
];

// The export period is the shared F2 `voucher.changeDate`, the same key as a report's period.
const bindings: DefaultBinding[] = [
  { commandId: 'io.cycleKind', chord: 'Alt+K', scope: 'screen:import-export' },
  { commandId: 'io.upload', chord: 'Alt+U', scope: 'screen:import-export' },
  { commandId: 'io.export', chord: 'Alt+E', scope: 'screen:import-export' },
  { commandId: 'io.types', chord: 'Alt+T', scope: 'screen:import-export' },
  { commandId: 'io.template', chord: 'Alt+S', scope: 'screen:import-export' },
];

const menu: MenuEntry[] = [{ section: 'transactions', commandId: 'io.open', order: 45, group: 'Import / Export' }];

export const importExportModule: ModuleManifest<AppContext> = { id: 'import-export', commands, bindings, menu };
