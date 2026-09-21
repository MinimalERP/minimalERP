import type { Frame } from '@minimalerp/command';
import {
  type ColumnSpec,
  type GridQuery,
  type Gstr1Row,
  type Gstr3bRow,
  type HsnRow,
  EMPTY_QUERY,
  applyGridQuery,
  cycleSort,
  gstInvoices,
  gstReconciliation,
  gstTotals,
  gstr1Export,
  gstr1Rows,
  gstr1Validation,
  gstr3b,
  hsnRows,
  type HeadCheck,
  type SystemLedgerKey,
} from '@minimalerp/domain';
import { useMemo, useState } from 'preact/hooks';
import { defaultPeriod, findFinancialYear, gstr1Columns, gstr3bColumns, hsnColumns, parseMonth, periodInYear, periodOfYm, yearOf, type GstPeriod } from '../reports/gstReports';
import { Only } from '../shell/Only';
import { useCommandHandler, useFrameState, useListNavigation, useServices, useSubscriptions } from '../shell/hooks';
import type { ReportKind, ScreenRef } from '../shell/router';
import { DataGrid } from '../ui/DataGrid';
import { downloadText } from '../ui/download';
import { Kbd } from '../ui/Kbd';
import { formatAmount } from '../vouchers/format';
import { FieldsDialog } from './ReportDialogs';

const SCOPE = 'screen:report';

type GstReport = Extract<ReportKind, 'gstr1' | 'gstr3b' | 'gst-purchases'>;
type View = 'invoices' | 'hsn';
type AnyRow = Gstr1Row | HsnRow | Gstr3bRow;

/**
 * GSTR-1, the purchase register behind GSTR-3B, and GSTR-3B (ADR-0019): REPORTS of a month, on the same grid, with the same keys (F2 changes the
 * period, Alt+S sorts, Alt+K clears, Enter drills). Nothing here posts anything and nothing is filed: every figure is an invoice's own, and Enter
 * follows it — a row to its voucher, an HSN to its invoices, a GSTR-3B line to the invoices behind it — and the tax ledger buttons to the ledger.
 * GSTR-1 says what is missing before it will export, and exports the month as structured JSON, or CSV of the view in front.
 */
export function GstScreen({ frame, report, kind }: { frame: Frame<ScreenRef>; report: GstReport; kind: string | undefined }) {
  const { books: host, app, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const books = host.current as NonNullable<typeof host.current>;
  useSubscriptions(books);
  const masters = books.masters;
  const today = new Date().toISOString().slice(0, 10);

  const [period, setPeriod] = useFrameState<GstPeriod>(frame, 'period', periodOfYm(kind) ?? defaultPeriod(masters, today));
  const [view, setView] = useFrameState<View>(frame, 'view', 'invoices');
  const [query, setQuery] = useFrameState<GridQuery>(frame, 'query', EMPTY_QUERY);
  const [col, setCol] = useFrameState<number>(frame, 'col', 0);
  const [row, setRow] = useFrameState<number>(frame, 'row', 0);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'ok' } | undefined>(undefined);
  const range = { from: period.from, to: period.to };
  const side = report === 'gst-purchases' ? 'purchase' : 'sales';
  const year = yearOf(masters, period);

  // ---- the data: read from the posted invoices and the journal ----
  const invoices = useMemo(() => (report === 'gstr3b' ? [] : gstInvoices({ vouchers: books.vouchers, masters, side, range })), [report, side, books.vouchers, masters, period.from, period.to]);
  const invoiceRows = useMemo(() => gstr1Rows(invoices), [invoices]);
  const hsn = useMemo(() => hsnRows(invoices), [invoices]);
  const summary = useMemo(() => (report === 'gstr3b' ? gstr3b({ vouchers: books.vouchers, lines: books.lines, masters, range }) : undefined), [report, books.vouchers, books.lines, masters, period.from, period.to]);
  const issues = useMemo(() => (report === 'gstr1' ? gstr1Validation(masters, invoices) : []), [report, masters, invoices]);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const totals = useMemo(() => gstTotals(invoices), [invoices]);
  const checks: { label: string; list: HeadCheck[] }[] = useMemo(
    () =>
      summary
        ? [
            { label: 'Sales against the Output ledgers', list: summary.reconciliation.sales },
            { label: 'Purchases against the Input ledgers', list: summary.reconciliation.purchases },
          ]
        : report === 'gstr1'
          ? [{ label: 'Sales against the Output ledgers', list: gstReconciliation({ invoices, lines: books.lines, masters, side: 'sales' }) }]
          : [{ label: 'Purchases against the Input ledgers', list: gstReconciliation({ invoices, lines: books.lines, masters, side: 'purchase' }) }],
    [summary, report, invoices, books.lines, masters],
  );

  const columns = (report === 'gstr3b' ? gstr3bColumns() : view === 'hsn' ? hsnColumns() : gstr1Columns(side)) as readonly ColumnSpec<AnyRow>[];
  const baseRows = (report === 'gstr3b' ? (summary?.rows ?? []) : view === 'hsn' ? hsn : invoiceRows) as readonly AnyRow[];
  const rows = useMemo(() => applyGridQuery(baseRows, columns, query), [baseRows, columns, query]);
  const safeRow = Math.min(row, Math.max(0, rows.length - 1));
  const safeCol = Math.min(col, columns.length - 1);
  const column = columns[safeCol] as ColumnSpec<AnyRow>;

  const drill = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.rowType === 'gstr1') app.navigate({ type: 'voucher', mode: 'display', id: r.voucherId });
    else if (r.rowType === 'hsn') {
      // an HSN opens the invoices that carry it
      setView('invoices');
      setQuery({ ...query, quick: r.hsn });
      setRow(0);
    } else if (r.drill) app.navigate({ type: 'report', report: r.drill === 'sales' ? 'gstr1' : 'gst-purchases', kind: period.ym });
  };
  useListNavigation(SCOPE, { count: rows.length, index: safeRow, setIndex: setRow, onActivate: drill, homeEnd: false, pageSize: 10 });

  const moveCol = (delta: number) => setCol((safeCol + delta + columns.length) % columns.length);
  useCommandHandler(SCOPE, 'field.next', () => (moveCol(1), true));
  useCommandHandler(SCOPE, 'field.prev', () => (moveCol(-1), true));
  useCommandHandler(SCOPE, 'nav.left', () => (query.quick === '' ? (moveCol(-1), true) : false));
  useCommandHandler(SCOPE, 'nav.right', () => (query.quick === '' ? (moveCol(1), true) : false));
  useCommandHandler(SCOPE, 'grid.sort', () => {
    if (column.sortable === false) return true;
    setQuery(cycleSort(query, column.id));
    return true;
  });
  useCommandHandler(SCOPE, 'grid.clear', () => {
    setQuery({ ...query, filters: {}, quick: '' });
    setRow(0);
    return true;
  });
  useCommandHandler(SCOPE, 'voucher.changeDate', () => (setAsking(true), true));

  // ---- the export: structured data for a later portal integration, only when nothing the return needs is missing ----
  const stem = `GSTR1_${masters.company.gstin ?? 'GSTIN'}_${period.ym.slice(5, 7)}${period.ym.slice(0, 4)}`;
  const blocked = (): boolean => {
    if (errors.length === 0) return false;
    setNotice({ tone: 'error', text: `Nothing was exported: ${errors.length} thing${errors.length === 1 ? '' : 's'} to fix first (listed above). Warnings do not block.` });
    return true;
  };
  const exportJson = (): boolean => {
    if (blocked()) return true;
    const ex = gstr1Export({ masters, invoices, period });
    downloadText(`${stem}.json`, JSON.stringify(ex.json, null, 2), 'application/json');
    setNotice({ tone: 'ok', text: `${stem}.json saved: ${invoices.length} invoice${invoices.length === 1 ? '' : 's'}, ${hsn.length} HSN line${hsn.length === 1 ? '' : 's'}.` });
    return true;
  };
  const exportCsv = (): boolean => {
    if (blocked()) return true;
    const ex = gstr1Export({ masters, invoices, period });
    const name = view === 'hsn' ? `${stem}_hsn.csv` : `${stem}_invoices.csv`;
    downloadText(name, view === 'hsn' ? ex.hsnCsv : ex.invoicesCsv, 'text/csv');
    setNotice({ tone: 'ok', text: `${name} saved.` });
    return true;
  };
  const toggleView = (): boolean => {
    setView(view === 'invoices' ? 'hsn' : 'invoices');
    setQuery({ ...query, filters: {}, quick: '' });
    setCol(0);
    setRow(0);
    return true;
  };

  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];
  const title = report === 'gstr1' ? (view === 'hsn' ? 'GSTR-1: HSN summary' : 'GSTR-1') : report === 'gstr3b' ? 'GSTR-3B' : 'GST Purchases';

  const ledgerButtons = (list: HeadCheck[], kindOf: 'output' | 'input') =>
    list.map((c) => {
      const key = `gst-${kindOf}-${c.head.toLowerCase()}` as SystemLedgerKey;
      const ledger = masters.systemLedger(key);
      return (
        <span key={c.head} class={c.ok ? 'gst-check ok' : 'gst-check bad'} data-testid={`recon-${kindOf}-${c.head.toLowerCase()}`}>
          {ledger ? (
            <button type="button" class="linkish" title="Open this ledger" onClick={() => app.navigate({ type: 'report', report: 'ledger', ledgerId: ledger.id })}>
              {ledger.name}
            </button>
          ) : (
            c.head
          )}{' '}
          {c.ok ? '✓' : '✗'} {formatAmount(c.report)}
          {c.ok ? '' : ` ≠ ledger ${formatAmount(c.ledger)}`}
        </span>
      );
    });

  return (
    <section class="screen report-screen" aria-labelledby="report-title" data-testid="report">
      <h1 id="report-title">{title}</h1>
      <p class="lede" data-testid="report-period">
        {year && <>Financial year {year.label} · </>}
        <strong data-testid="gst-period">{period.label}</strong> {chord('voucher.changeDate') && <Kbd chord={chord('voucher.changeDate') as string} />} period
        {(report === 'gstr1' || report === 'gst-purchases') && chord('gst.view') && (
          <>
            {' '}
            · <Kbd chord={chord('gst.view') as string} /> {view === 'hsn' ? 'invoices' : 'HSN summary'}
          </>
        )}
        {report === 'gstr3b' && <> · Enter on a line opens the invoices behind it</>}
      </p>

      {report === 'gstr1' &&
        (errors.length > 0 || warnings.length > 0 ? (
          <div data-testid="gst-validation">
            {errors.length > 0 && (
              <div class="notice error" role="alert" data-testid="gst-errors">
                <strong>{errors.length} to fix before the export:</strong>
                <ul class="gst-issues">
                  {errors.slice(0, 8).map((i, n) => (
                    <li key={n}>
                      {i.number ? <strong>{i.number}: </strong> : null}
                      {i.message}
                    </li>
                  ))}
                  {errors.length > 8 && <li>… and {errors.length - 8} more</li>}
                </ul>
              </div>
            )}
            {warnings.length > 0 && (
              <div class="notice" data-testid="gst-warnings">
                <strong>{warnings.length} to look at</strong> (they do not block the export):
                <ul class="gst-issues">
                  {warnings.slice(0, 5).map((i, n) => (
                    <li key={n}>
                      {i.number ? <strong>{i.number}: </strong> : null}
                      {i.message}
                    </li>
                  ))}
                  {warnings.length > 5 && <li>… and {warnings.length - 5} more</li>}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <p class="notice" role="status" data-testid="gst-ready">
            ✓ Nothing is missing: this month can be exported ({chord('gst.exportJson') ? <Kbd chord={chord('gst.exportJson') as string} /> : 'export'} for the JSON, {chord('gst.exportCsv') ? <Kbd chord={chord('gst.exportCsv') as string} /> : 'export'} for CSV).
          </p>
        ))}
      {notice && (
        <p class={notice.tone === 'error' ? 'notice error' : 'notice'} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="gst-notice">
          {notice.text}
        </p>
      )}
      {report === 'gstr3b' && summary && (
        <p class="notice" data-testid="gst-itc-note">
          Input tax is shown as <strong>to review</strong>, never claimed: the invoices do not say whether a credit is eligible (blocked credits, reverse charge, credit and debit notes are not modelled). Nothing here is filed.
        </p>
      )}

      <div class="chips" data-testid="chips">
        <input
          class="field-input quick-filter"
          type="text"
          aria-label="Quick filter"
          placeholder="type to narrow…"
          autocomplete="off"
          spellcheck={false}
          value={query.quick}
          onInput={(e) => {
            setQuery({ ...query, quick: (e.target as HTMLInputElement).value });
            setRow(0);
          }}
        />
      </div>

      {rows.length === 0 ? (
        <p class="empty" data-testid="report-empty">
          {baseRows.length === 0 ? `No ${side === 'sales' ? 'sales' : 'purchase'} invoices in ${period.label}.` : 'No rows match.'}
        </p>
      ) : (
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(r) => (r as { key: string }).key}
          activeRow={safeRow}
          activeCol={safeCol}
          query={query}
          label={title}
          rowClass={(r) => (r.rowType === 'gstr3b' ? (r.heading ? 'gst-heading' : r.review ? 'gst-review' : '') : '')}
          onPickRow={(i) => (setRow(i), drill(i))}
          onPickColumn={setCol}
          onSortColumn={(i) => {
            const c = columns[i] as ColumnSpec<AnyRow>;
            if (c.sortable !== false) setQuery(cycleSort(query, c.id));
          }}
        />
      )}

      <p class="report-foot" data-testid="report-foot">
        {report === 'gstr3b' && summary ? (
          <>
            {summary.sales.length} sales invoice{summary.sales.length === 1 ? '' : 's'} · {summary.purchases.length} purchase invoice{summary.purchases.length === 1 ? '' : 's'} · Output tax <strong data-testid="gst-output">{formatAmount(summary.output.tax)}</strong> · Input tax to review{' '}
            <strong data-testid="gst-review">{formatAmount(summary.toReview.tax)}</strong> · Net payable, claiming nothing under review <strong data-testid="gst-net">{formatAmount(summary.net.tax)}</strong>
          </>
        ) : (
          <span data-testid="gst-totals">
            {totals.invoices} invoice{totals.invoices === 1 ? '' : 's'} · Taxable <strong data-testid="gst-t-taxable">{formatAmount(totals.taxable)}</strong> · CGST <strong data-testid="gst-t-cgst">{formatAmount(totals.cgst)}</strong> · SGST{' '}
            <strong data-testid="gst-t-sgst">{formatAmount(totals.sgst)}</strong> · IGST <strong data-testid="gst-t-igst">{formatAmount(totals.igst)}</strong> · Total GST <strong data-testid="gst-t-tax">{formatAmount(totals.tax)}</strong> · Invoice value{' '}
            <strong data-testid="gst-t-value">{formatAmount(totals.value)}</strong>
          </span>
        )}
      </p>
      <p class="report-foot" data-testid="gst-reconciliation">
        {checks.map((c, n) => (
          <span key={n} class="gst-recon">
            {c.label}: {ledgerButtons(c.list, c.label.startsWith('Sales') ? 'output' : 'input')}
          </span>
        ))}
      </p>

      {report === 'gstr1' && (
        <>
          <Only scope={SCOPE} command="gst.exportJson" run={exportJson} />
          <Only scope={SCOPE} command="gst.exportCsv" run={exportCsv} />
        </>
      )}
      {(report === 'gstr1' || report === 'gst-purchases') && <Only scope={SCOPE} command="gst.view" run={toggleView} />}

      {asking && (
        <FieldsDialog
          title="Period"
          fields={[
            { key: 'fy', label: 'Financial year', value: year?.label ?? masters.financialYears.at(-1)?.label ?? '', hint: `like ${masters.financialYears.at(-1)?.label ?? '26-27'}` },
            { key: 'month', label: 'Month', value: period.label.slice(0, 3), hint: 'Apr, or 4' },
          ]}
          validate={(v) => {
            const errs: Record<string, string> = {};
            const fy = findFinancialYear(masters, v['fy'] ?? '');
            const m = parseMonth(v['month'] ?? '');
            if (!fy) errs['fy'] = 'That is not one of this company’s financial years';
            if (m === undefined) errs['month'] = 'That is not a month';
            else if (fy && !periodInYear(fy, m)) errs['month'] = `${(v['month'] ?? '').trim()} is not in ${fy.label}`;
            return errs;
          }}
          onDone={(v) => {
            if (v) {
              const fy = findFinancialYear(masters, v['fy'] ?? '');
              const m = parseMonth(v['month'] ?? '');
              const p = fy && m !== undefined ? periodInYear(fy, m) : undefined;
              if (p) {
                setPeriod(p);
                setRow(0);
                setNotice(undefined);
                app.replace({ type: 'report', report, kind: p.ym });
              }
            }
            setAsking(false);
          }}
        />
      )}
    </section>
  );
}
