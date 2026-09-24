import type { Frame } from '@minimalerp/command';
import { serializeItemsCsv, serializePartiesCsv, serializeVouchersCsv, voucherEntriesOf } from '@minimalerp/domain';
import { useRef, useState } from 'preact/hooks';
import { type BulkImportSummary, type VoucherImportSummary, importItemsCsv, importPartiesCsv, importVouchersCsv } from '../books/csvImport';
import { Only } from '../shell/Only';
import { useFrameState, useServices, useSubscriptions } from '../shell/hooks';
import type { ScreenRef } from '../shell/router';
import { downloadText } from '../ui/download';
import { Kbd } from '../ui/Kbd';

const SCOPE = 'screen:import-export';

type Kind = 'items' | 'parties' | 'vouchers';
const KINDS: readonly { readonly value: Kind; readonly label: string; readonly hint: string }[] = [
  { value: 'items', label: 'Items', hint: 'stock items — created or updated directly, by name' },
  { value: 'parties', label: 'Parties', hint: 'customers/vendors — created or updated directly, by name' },
  { value: 'vouchers', label: 'Vouchers / Sales Orders', hint: 'queued in the AI Inbox — review and accept each one' },
];

type Result = { readonly kind: 'bulk'; readonly summary: BulkImportSummary } | { readonly kind: 'staged'; readonly summary: VoucherImportSummary };

/** Bulk Import / Export via CSV: Items and Parties import directly (master data, nothing to review row by
 *  row); Vouchers and Sales Orders import via the same AI Inbox staged review as any other document. Export
 *  always produces exactly the columns Import reads back in. */
export function ImportExportScreen({ frame }: { frame: Frame<ScreenRef> }) {
  const { books: host, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const books = host.current;
  const [kind, setKind] = useFrameState<Kind>(frame, 'kind', 'items');
  const [result, setResult] = useState<Result | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);

  const cycle = (): boolean => {
    const i = KINDS.findIndex((k) => k.value === kind);
    setKind(KINDS[(i + 1) % KINDS.length]?.value as Kind);
    setResult(undefined);
    setError(undefined);
    return true;
  };

  const pick = (): boolean => {
    if (!books) return false;
    fileRef.current?.click();
    return true;
  };

  const onFile = (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file || !books) return;
    setError(undefined);
    setBusy(true);
    setResult(undefined);
    void file
      .text()
      .then(async (text) => {
        if (kind === 'items') setResult({ kind: 'bulk', summary: await importItemsCsv(books, text) });
        else if (kind === 'parties') setResult({ kind: 'bulk', summary: await importPartiesCsv(books, text) });
        else setResult({ kind: 'staged', summary: await importVouchersCsv(books, text) });
      })
      .catch(() => setError(`${file.name} could not be read.`))
      .finally(() => setBusy(false));
  };

  const exportCsv = (): boolean => {
    if (!books) return false;
    const m = books.masters;
    if (kind === 'items') downloadText('items.csv', serializeItemsCsv(m.stockItems, m), 'text/csv');
    else if (kind === 'parties') downloadText('parties.csv', serializePartiesCsv(m.parties), 'text/csv');
    else downloadText('vouchers.csv', serializeVouchersCsv(voucherEntriesOf(books.vouchers, m)), 'text/csv');
    return true;
  };

  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];
  const current = KINDS.find((k) => k.value === kind);

  return (
    <section class="screen" aria-labelledby="io-title" data-testid="import-export">
      <Only scope={SCOPE} command="io.cycleKind" run={cycle} />
      {books && !busy && <Only scope={SCOPE} command="io.upload" run={pick} />}
      {books && <Only scope={SCOPE} command="io.export" run={exportCsv} />}
      <input ref={fileRef} type="file" accept=".csv,text/csv" hidden data-testid="io-file" onChange={(e) => onFile((e.target as HTMLInputElement).files?.[0])} />
      <h1 id="io-title">Import / Export</h1>
      {!books ? (
        <p class="empty">Open a company first.</p>
      ) : (
        <>
          <p class="lede">
            {chord('io.cycleKind') && <Kbd chord={chord('io.cycleKind') as string} />} {current?.label} — {current?.hint}
          </p>
          <p class="lede">
            {chord('io.upload') && (
              <>
                <Kbd chord={chord('io.upload') as string} /> import a CSV
              </>
            )}
            {chord('io.export') && (
              <>
                {' · '}
                <Kbd chord={chord('io.export') as string} /> export
              </>
            )}
          </p>
          {busy && <p data-testid="io-busy">Working…</p>}
          {error && (
            <p class="callout" data-testid="io-error">
              {error}
            </p>
          )}
          {result?.kind === 'bulk' && (
            <div data-testid="io-result">
              <p>
                {result.summary.created} created · {result.summary.updated} updated
                {result.summary.errors.length > 0 ? ` · ${result.summary.errors.length} row(s) had problems` : ''}
              </p>
              {result.summary.errors.map((e) => (
                <p key={e.row} class="callout">
                  Row {e.row}: {e.message}
                </p>
              ))}
            </div>
          )}
          {result?.kind === 'staged' && (
            <div data-testid="io-result">
              <p>
                {result.summary.staged} queued in the AI Inbox — review and accept each one (Alt+G, "AI Inbox").
                {result.summary.errors.length > 0 ? ` ${result.summary.errors.length} could not be queued.` : ''}
              </p>
              {result.summary.errors.map((e) => (
                <p key={e.docRef} class="callout">
                  {e.docRef}: {e.message}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
