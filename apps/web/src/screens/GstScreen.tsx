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
  gstr1Documents,
  gstr1Export,
  gstr1Rows,
  gstr1Validation,
  gstr3b,
  hsnRows,
  type Gstr2bFile,
  type HeadCheck,
  type SystemLedgerKey,
  GSTR2B_STATUS_LABELS,
  canonicalId,
  formatMoney,
  gstr2bFromJson,
  gstr2bPeriodLabel,
  gstr2bTotals,
  matchGstr2b,
} from '@minimalerp/domain';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Gstr2bGridRow, gstr2bColumns, gstr2bGridRows } from '../reports/gstr2bReport';
import { defaultPeriod, findFinancialYear, gstr1Columns, gstr3bColumns, hsnColumns, parseMonth, parseQuarter, periodInYear, periodOfYm, quarterInYear, yearOf, type GstPeriod } from '../reports/gstReports';
import { Only } from '../shell/Only';
import { useCommandHandler, useFrameState, useListNavigation, useServices, useSubscriptions } from '../shell/hooks';
import type { ReportKind, ScreenRef } from '../shell/router';
import { DataGrid } from '../ui/DataGrid';
import { downloadText } from '../ui/download';
import { Kbd } from '../ui/Kbd';
import { bulkPurchases, optionByName, templateOf } from '../reports/gstr2bBulk';
import { formatAmount, formatDate, todayText } from '../vouchers/format';
import { paidFromOptions, paymentForPurchase, salesLedgerOptions } from '../vouchers/salesModel';
import { FieldsDialog } from './ReportDialogs';

const SCOPE = 'screen:report';

type GstReport = Extract<ReportKind, 'gstr1' | 'gstr3b' | 'gst-purchases'>;
/** `2b`: GST Purchases with a GSTR-2B file loaded — the file's invoices against the books'. */
type View = 'invoices' | 'hsn' | '2b';
type AnyRow = Gstr1Row | HsnRow | Gstr3bRow | Gstr2bGridRow;

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
  const today = todayText();

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

  // ---- GSTR-2B: the portal's file against the purchases (GST Purchases only). The file is read here and kept for this window; nothing of it is stored. ----
  const [file2b, setFile2b] = useFrameState<Gstr2bFile | undefined>(frame, 'file2b', undefined);
  /** The purchases tagged "GST matched": voucher id → the 2B period (online books). */
  const [tags, setTags] = useState<Readonly<Record<string, string>>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const loadTags = () => void books.gstMatches().then(setTags);
  useEffect(() => {
    if (report === 'gst-purchases') loadTags();
  }, [report, books.vouchers]);
  const show2b = report === 'gst-purchases' && view === '2b' && file2b !== undefined;
  const rows2b = useMemo(
    () =>
      show2b && file2b
        ? gstr2bGridRows(matchGstr2b({ file: file2b, purchases: gstInvoices({ vouchers: books.vouchers, masters, side: 'purchase', range: {} }), range, tagged: new Map(Object.entries(tags)) }))
        : [],
    [show2b, file2b, books.vouchers, masters, period.from, period.to, tags],
  );

  const invoiceColumns = (): ColumnSpec<Gstr1Row>[] => [
    ...gstr1Columns(side),
    // a purchase found in a GSTR-2B says which
    ...(side === 'purchase' && books.canTagGst ? [{ id: 'gst2b', label: '2B', type: 'text', value: (r: Gstr1Row) => (tags[r.voucherId] ? gstr2bPeriodLabel(tags[r.voucherId] as string) : '') } satisfies ColumnSpec<Gstr1Row>] : []),
  ];
  const columns = (report === 'gstr3b' ? gstr3bColumns() : show2b ? gstr2bColumns() : view === 'hsn' ? hsnColumns() : invoiceColumns()) as readonly ColumnSpec<AnyRow>[];
  const baseRows = (report === 'gstr3b' ? (summary?.rows ?? []) : show2b ? rows2b : view === 'hsn' ? hsn : invoiceRows) as readonly AnyRow[];
  const rows = useMemo(() => applyGridQuery(baseRows, columns, query), [baseRows, columns, query]);
  const safeRow = Math.min(row, Math.max(0, rows.length - 1));
  const safeCol = Math.min(col, columns.length - 1);
  const column = columns[safeCol] as ColumnSpec<AnyRow>;

  const drill = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.rowType === 'gstr1') app.navigate({ type: 'voucher', mode: 'display', id: r.voucherId });
    else if (r.rowType === 'gstr2b') {
      // an invoice the books have opens it; one only the GST site has opens a new purchase for it
      if (r.voucherId) app.navigate({ type: 'voucher', mode: 'display', id: r.voucherId });
      else {
        const tax = r.file ? r.file.cgst + r.file.sgst + r.file.igst : 0n;
        app.navigate({
          type: 'voucher',
          mode: 'create',
          typeKey: 'purchase',
          from2b: {
            supplier: r.supplier,
            gstin: r.gstin,
            billNo: r.number,
            date: r.fileDate,
            note: `From GSTR-2B: ${r.supplier} (${r.gstin}), invoice ${r.number} — taxable ${formatMoney(r.file?.taxable ?? (0n as never))}, GST ${formatMoney(tax as never)}, invoice value ${formatMoney(r.fileValue ?? (0n as never))}. Add the items.`,
          },
        });
      }
    } else if (r.rowType === 'hsn') {
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
  // named for the return period: a month, or a quarter's last month (as the portal files a quarterly return)
  const stem = `GSTR1_${masters.company.gstin ?? 'GSTIN'}_${period.to.slice(5, 7)}${period.to.slice(0, 4)}`;
  const blocked = (): boolean => {
    if (errors.length === 0) return false;
    setNotice({ tone: 'error', text: `Nothing was exported: ${errors.length} thing${errors.length === 1 ? '' : 's'} to fix first (listed above). Warnings do not block.` });
    return true;
  };
  const exportJson = (): boolean => {
    if (blocked()) return true;
    const ex = gstr1Export({ masters, invoices, period, documents: gstr1Documents({ vouchers: books.vouchers, masters, range }) });
    downloadText(`${stem}.json`, JSON.stringify(ex.json, null, 2), 'application/json');
    setNotice({ tone: 'ok', text: `${stem}.json saved: ${invoices.length} invoice${invoices.length === 1 ? '' : 's'}, ${hsn.length} HSN line${hsn.length === 1 ? '' : 's'}.` });
    return true;
  };
  const exportCsv = (): boolean => {
    if (blocked()) return true;
    const ex = gstr1Export({ masters, invoices, period, documents: gstr1Documents({ vouchers: books.vouchers, masters, range }) });
    const name = view === 'hsn' ? `${stem}_hsn.csv` : `${stem}_invoices.csv`;
    downloadText(name, view === 'hsn' ? ex.hsnCsv : ex.invoicesCsv, 'text/csv');
    setNotice({ tone: 'ok', text: `${name} saved.` });
    return true;
  };
  /** The view Alt+V goes to next: invoices → HSN summary → (with a GSTR-2B loaded) its matching → invoices. */
  const nextView: View = view === 'invoices' ? 'hsn' : view === 'hsn' && report === 'gst-purchases' && file2b ? '2b' : 'invoices';
  const viewName = (v: View): string => (v === 'hsn' ? 'HSN summary' : v === '2b' ? 'GSTR-2B matching' : 'invoices');
  const toggleView = (): boolean => {
    setView(nextView);
    setQuery({ ...query, filters: {}, quick: '' });
    setCol(0);
    setRow(0);
    return true;
  };

  // ---- GSTR-2B: load the file, tag what matched ----
  const load2b = (): boolean => {
    fileRef.current?.click();
    return true;
  };
  const on2bFile = (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = ''; // the same file can be chosen again
    if (!file) return;
    void file.text().then((text) => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return setNotice({ tone: 'error', text: `${file.name} is not a JSON file: download the JSON from Returns › GSTR-2B on the GST portal.` });
      }
      const read = gstr2bFromJson(json);
      if (!read.ok) return setNotice({ tone: 'error', text: read.issues[0]?.message ?? 'That file could not be read' });
      const own = canonicalId(masters.company.gstin ?? '');
      if (own !== '' && read.value.gstin !== own) {
        return setNotice({ tone: 'error', text: `That GSTR-2B is of GSTIN ${read.value.gstin}; this company is ${own}. Nothing was loaded.` });
      }
      // the screen moves to the file's month, unless the period in front (a quarter, say) already holds it
      const m = /^(\d{2})(\d{4})$/.exec(read.value.period);
      const fileMonth = m ? periodOfYm(`${m[2]}-${m[1]}`) : undefined;
      const moved = fileMonth !== undefined && !(fileMonth.from >= period.from && fileMonth.to <= period.to);
      if (moved && fileMonth) {
        setPeriod(fileMonth);
        app.replace({ type: 'report', report, kind: fileMonth.ym });
      }
      setFile2b(read.value);
      setView('2b');
      setQuery({ ...query, filters: {}, quick: '' });
      setCol(0);
      setRow(0);
      const s = read.value.skipped;
      const left = [s.creditNotes > 0 ? `${s.creditNotes} credit / debit note${s.creditNotes === 1 ? '' : 's'}` : '', s.amendments > 0 ? `${s.amendments} amended invoice${s.amendments === 1 ? '' : 's'}` : '', s.imports > 0 ? `${s.imports} import${s.imports === 1 ? '' : 's'}` : ''].filter((x) => x !== '');
      setNotice({
        tone: 'ok',
        text: `GSTR-2B of ${gstr2bPeriodLabel(read.value.period)} loaded: ${read.value.invoices.length} invoice${read.value.invoices.length === 1 ? '' : 's'}.${left.length > 0 ? ` Not matched (the books do not hold them): ${left.join(', ')}.` : ''}${moved ? ` The period is now ${fileMonth?.label}: for a quarterly statement choose the quarter (F2).` : ''}`,
      });
    });
  };
  /** The matched purchases not yet tagged for this file's period. */
  const toTag = show2b && file2b ? rows2b.filter((r) => r.status === 'matched' && r.voucherId !== undefined && r.tagged !== file2b.period) : [];
  const tag2b = (): boolean => {
    if (!file2b || toTag.length === 0) return false;
    void books.tagGstMatched(toTag.map((r) => r.voucherId as string), file2b.period).then((r) => {
      if (!r.ok) return setNotice({ tone: 'error', text: r.issues[0]?.message ?? 'The purchases could not be tagged' });
      loadTags();
      setNotice({ tone: 'ok', text: `${r.value.tagged} purchase${r.value.tagged === 1 ? '' : 's'} tagged GST matched (2B ${gstr2bPeriodLabel(file2b.period)}).` });
    });
    return true;
  };
  const totals2b = show2b ? gstr2bTotals(rows2b) : undefined;

  // ---- GSTR-2B: every missing invoice of the supplier under the cursor, posted in one go (the same one line each) ----
  /** The GSTIN whose missing invoices are being posted (its window is open). */
  const [bulkOf, setBulkOf] = useState<string | undefined>(undefined);
  const [posting, setPosting] = useState(false);
  const cursorRow = show2b ? (rows[safeRow] as Gstr2bGridRow | undefined) : undefined;
  const canBulk = cursorRow?.rowType === 'gstr2b' && cursorRow.status === 'not-in-books' && !posting;
  const bulkRows = bulkOf === undefined ? [] : rows2b.filter((r) => r.status === 'not-in-books' && r.gstin === bulkOf);
  const bulkTemplate = useMemo(() => (bulkOf === undefined ? undefined : templateOf(books.vouchers, masters, bulkOf)), [bulkOf, books.vouchers, masters]);
  const purchaseLedgers = useMemo(() => salesLedgerOptions(masters, 'purchase'), [masters]);
  const payFrom = useMemo(() => paidFromOptions(masters), [masters]);
  /** What the window's fields, as typed, would post. */
  const bulkOfValues = (v: Record<string, string>) => {
    const ledger = optionByName(purchaseLedgers, v['ledger'] ?? '');
    return bulkPurchases({
      rows: bulkRows,
      entry: { text: v['text'] ?? '', unit: bulkTemplate?.unit ?? '', hsn: v['hsn'] ?? '', ledgerId: ledger?.id ?? '', ledgerLabel: ledger?.name ?? '' },
      masters,
      stock: books.stock,
      orders: books.orders,
      vouchers: books.vouchers,
      newId: () => crypto.randomUUID(),
    });
  };
  const postBulk = async (v: Record<string, string>) => {
    const { ready } = bulkOfValues(v);
    const from = optionByName(payFrom, v['paidFrom'] ?? '');
    const supplier = bulkRows[0]?.supplier ?? '';
    setBulkOf(undefined);
    setPosting(true);
    let posted = 0;
    let paid = 0;
    const refused: string[] = [];
    try {
      for (const one of ready) {
        const r = await books.post(one.draft);
        if (!r.ok) {
          refused.push(`${one.row.number}: ${r.issues[0]?.message ?? 'refused'}`);
          continue;
        }
        posted += 1;
        if (!from) continue;
        const payment = paymentForPurchase(masters, r.value.voucher, from.id, crypto.randomUUID());
        const p = payment ? await books.post(payment) : undefined;
        if (p?.ok) paid += 1;
        else refused.push(`${one.row.number}: saved, but NOT paid — ${p?.issues[0]?.message ?? 'there is no Payment voucher type'}`);
      }
    } finally {
      setPosting(false);
    }
    setRow(0);
    setNotice({
      tone: refused.length > 0 ? 'error' : 'ok',
      text: `${posted} purchase${posted === 1 ? '' : 's'} of ${supplier} posted${from ? ` and ${paid} paid from ${from.name}` : ''}.${refused.length > 0 ? ` Not done — ${refused.join('; ')}.` : ''}`,
    });
  };

  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];
  const title = report === 'gstr1' ? (view === 'hsn' ? 'GSTR-1: HSN summary' : 'GSTR-1') : report === 'gstr3b' ? 'GSTR-3B' : show2b && file2b ? `GST Purchases: GSTR-2B ${gstr2bPeriodLabel(file2b.period)} matching` : 'GST Purchases';

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
            · <Kbd chord={chord('gst.view') as string} /> {viewName(nextView)}
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
          {baseRows.length === 0 ? (show2b ? 'The file has no invoices, and there are no purchases with GST in this period.' : `No ${side === 'sales' ? 'sales' : 'purchase'} invoices in ${period.label}.`) : 'No rows match.'}
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
          rowClass={(r) => (r.rowType === 'gstr3b' ? (r.heading ? 'gst-heading' : r.review ? 'gst-review' : '') : r.rowType === 'gstr2b' && r.status !== 'matched' ? 'gst-review' : '')}
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
        ) : totals2b ? (
          <span data-testid="gst-2b-totals">
            {(['matched', 'mismatch', 'not-in-books', 'not-on-portal'] as const).map((s, n) => (
              <span key={s}>
                {n > 0 ? ' · ' : ''}
                {GSTR2B_STATUS_LABELS[s]} {totals2b[s].count} — GST <strong data-testid={`gst-2b-${s}`}>{formatAmount(totals2b[s].tax)}</strong>
              </span>
            ))}
            {books.canTagGst ? (toTag.length > 0 ? ` · ${toTag.length} matched to tag` : ' · every matched purchase is tagged') : ''}
          </span>
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
      {report === 'gst-purchases' && (
        <>
          <Only scope={SCOPE} command="gst.load2b" run={load2b} />
          {books.canTagGst && toTag.length > 0 && <Only scope={SCOPE} command="gst.tag2b" run={tag2b} />}
          {canBulk && bulkOf === undefined && <Only scope={SCOPE} command="gst.post2b" run={() => (setBulkOf(cursorRow?.gstin), true)} />}
          <input ref={fileRef} type="file" accept=".json,application/json" hidden data-testid="gst-2b-file" onChange={(e) => on2bFile((e.target as HTMLInputElement).files?.[0])} />
        </>
      )}

      {bulkOf !== undefined && bulkRows.length > 0 && (
        <FieldsDialog
          title={`Post ${bulkRows.length} purchase invoice${bulkRows.length === 1 ? '' : 's'} of ${bulkRows[0]?.supplier ?? ''}`}
          fields={[
            { key: 'text', label: 'Line', value: bulkTemplate?.text ?? '', hint: bulkTemplate ? `as on ${bulkTemplate.from}, this supplier’s last purchase` : 'what is bought — the one line every invoice gets' },
            { key: 'hsn', label: 'HSN / SAC', value: bulkTemplate?.hsn ?? '', hint: '4 to 8 digits' },
            { key: 'ledger', label: 'Purchase ledger', value: bulkTemplate?.ledgerLabel || (purchaseLedgers.length === 1 ? (purchaseLedgers[0]?.name ?? '') : ''), hint: 'type a few letters of the ledger', options: purchaseLedgers.map((o) => o.name) },
            { key: 'paidFrom', label: 'Paid from', value: '', hint: 'empty = on credit — or type a few letters of the cash or bank ledger', options: payFrom.map((o) => o.name) },
          ]}
          validate={(v) => {
            const errs: Record<string, string> = {};
            if ((v['text'] ?? '').trim() === '') errs['text'] = 'Write what is bought';
            if (!optionByName(purchaseLedgers, v['ledger'] ?? '')) errs['ledger'] = 'That is not a ledger under Purchase Accounts';
            if ((v['paidFrom'] ?? '').trim() !== '' && !optionByName(payFrom, v['paidFrom'] ?? '')) errs['paidFrom'] = 'That is not a cash or bank ledger';
            if (Object.keys(errs).length === 0 && bulkOfValues(v).ready.length === 0) errs['text'] = 'None of these invoices can be posted: the reasons are listed below';
            return errs;
          }}
          below={(v) => {
            const { ready, leftOut } = bulkOfValues(v);
            return (
              <div class="bulk-list" data-testid="gst-2b-bulk">
                {ready.length > 0 && (
                  <table class="data-grid">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Inv no.</th>
                        <th class="num">Taxable</th>
                        <th class="num">GST</th>
                        <th class="num">Total</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {ready.map((one) => (
                        <tr key={one.row.key}>
                          <td>{one.row.fileDate ? formatDate(one.row.fileDate) : ''}</td>
                          <td>{one.row.number}</td>
                          <td class="num">{formatAmount(one.taxable)}</td>
                          <td class="num">{one.tax === 0n ? '—' : formatAmount(one.tax)}</td>
                          <td class="num">{formatAmount(one.total)}</td>
                          <td>{one.row.reverseCharge ? 'reverse charge' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {leftOut.length > 0 && (
                  <p class="notice" data-testid="gst-2b-left-out">
                    <strong>Left out: {leftOut.length}</strong>
                    {leftOut.map((x) => (
                      <span key={x.row.key}>
                        <br />
                        {x.row.number} — {x.reason}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            );
          }}
          onDone={(v) => (v ? void postBulk(v) : setBulkOf(undefined))}
        />
      )}
      {asking && (
        <FieldsDialog
          title="Period"
          fields={[
            { key: 'fy', label: 'Financial year', value: year?.label ?? masters.financialYears.at(-1)?.label ?? '', hint: `like ${masters.financialYears.at(-1)?.label ?? '26-27'}` },
            { key: 'month', label: 'Month or quarter', value: period.quarter ? `Q${period.quarter}` : period.label.slice(0, 3), hint: 'Apr, or 4 — or Q1 (Apr–Jun) … Q4 (Jan–Mar) for a quarterly return' },
          ]}
          validate={(v) => {
            const errs: Record<string, string> = {};
            const fy = findFinancialYear(masters, v['fy'] ?? '');
            const text = v['month'] ?? '';
            const q = parseQuarter(text);
            const m = parseMonth(text);
            if (!fy) errs['fy'] = 'That is not one of this company’s financial years';
            if (q === undefined && m === undefined) errs['month'] = 'That is not a month or a quarter (Q1 to Q4)';
            else if (fy && !(q !== undefined ? quarterInYear(fy, q) : periodInYear(fy, m as number))) errs['month'] = `${text.trim()} is not in ${fy.label}`;
            return errs;
          }}
          onDone={(v) => {
            if (v) {
              const fy = findFinancialYear(masters, v['fy'] ?? '');
              const q = parseQuarter(v['month'] ?? '');
              const m = parseMonth(v['month'] ?? '');
              const p = !fy ? undefined : q !== undefined ? quarterInYear(fy, q) : m !== undefined ? periodInYear(fy, m) : undefined;
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
