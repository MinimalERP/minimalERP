import type { Frame } from '@minimalerp/command';
import {
  type ColumnFilter,
  type ColumnSpec,
  type BaseKind,
  type DayBookRow,
  type GridQuery,
  type StatementRow,
  type StockItemId,
  EMPTY_QUERY,
  applyGridQuery,
  cycleSort,
  dayBookRows,
  hasActiveFilters,
  ledgerStatement,
  localDate,
  onlyVoucherTypes,
  statementView,
  withFilter,
} from '@minimalerp/domain';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { describeFilter, dayBookColumns, ledgerColumns } from '../reports/definitions';
import { type TbRow, bookGroupIds, tbColumns, tbRows } from '../reports/booksReports';
import { type OutstandingBillRow, type PartyRow, billColumns, billRows, outstandingRowClass, partyColumns, partyRows, partyTotals } from '../reports/outstandingReports';
import { StatementScreen } from './StatementScreen';
import { GstScreen } from './GstScreen';
import { type VoucherListRow, listTitle, listTotals, voucherListColumns, voucherListRows, voucherRowClass } from '../reports/voucherLists';
import { type OrderRow, orderRegisterColumns, newestOrdersFirst, orderRegisterRows, orderRowClass, registerCounts } from '../reports/salesReports';
import {
  type StockLedgerRow,
  type StockSummaryRow,
  stockLedgerColumns,
  stockLedgerOf,
  stockSummaryColumns,
  stockSummaryRows,
  summaryTotals,
} from '../reports/stockReports';
import { useCommandHandler, useFrameState, useListNavigation, useServices, useSubscriptions } from '../shell/hooks';
import { Only } from '../shell/Only';
import type { ReportKind, ScreenRef } from '../shell/router';
import { DataGrid } from '../ui/DataGrid';
import { Kbd } from '../ui/Kbd';
import { formatAmount, formatBalance, formatDate, formatQuantity, normalizeAmount, parseDateInput } from '../vouchers/format';
import { FieldsDialog, LedgerDialog, MultiSelectDialog } from './ReportDialogs';

const SCOPE = 'screen:report';

interface Period {
  readonly from: string;
  readonly to: string;
}
type Dialog = 'filter' | 'types' | 'period' | 'ledger' | undefined;

const minor = (text: string): bigint | undefined => {
  const n = normalizeAmount(text);
  if (n === undefined) return undefined;
  const [w = '0', f = '00'] = n.split('.');
  return BigInt(w) * 100n + BigInt(f);
};

interface Props {
  readonly frame: Frame<ScreenRef>;
  readonly report: ReportKind;
  readonly ledgerId?: string | undefined;
  readonly itemId?: string | undefined;
  /** The vouchers list: which voucher kind ("sales", "payment"…). */
  readonly kind?: string | undefined;
  /** The Trial Balance opened on one group of the chart of accounts. */
  readonly groupId?: string | undefined;
}

type AnyRow = DayBookRow | StatementRow | StockSummaryRow | StockLedgerRow | OrderRow | VoucherListRow | TbRow | PartyRow | OutstandingBillRow;
/** What identifies a row: a voucher (Day Book, Ledger), an item (Stock Summary), one movement (Stock Ledger) or one order line (Sales Order Register). */
const rowKeyOf = (r: AnyRow): string => ('key' in r ? r.key : 'voucherId' in r ? r.voucherId : r.itemId);

/** What a report is called before a company is open (the screen only asks you to open one). */
function titleWithoutBooks(report: ReportKind, kind: string | undefined): string {
  switch (report) {
    case 'daybook': return 'Day Book';
    case 'stock-summary': return 'Stock Summary';
    case 'stock-item': return 'Stock Ledger';
    case 'sales-orders': return 'Sales Order Register';
    case 'purchase-orders': return 'Purchase Order Register';
    case 'trial-balance': return 'Trial Balance';
    case 'profit-loss': return 'Profit & Loss';
    case 'balance-sheet': return 'Balance Sheet';
    case 'book': return kind === 'bank' ? 'Bank Book' : 'Cash Book';
    case 'gstr1': return 'GSTR-1';
    case 'gstr3b': return 'GSTR-3B';
    case 'gst-purchases': return 'GST Purchases';
    case 'outstanding': return kind === 'payable' ? 'Outstanding Payables' : 'Outstanding Receivables';
    default: return 'Ledger';
  }
}

/**
 * Day Book and Ledger, on the one grid. This screen owns no report logic: the rows come from the pure book functions, the columns from the
 * report's definition, and sorting / filtering / moving are the grid's generic commands — so every report built later gets them too.
 */
export function ReportScreen({ frame, report, ledgerId: ledgerFromAddress, itemId: itemFromAddress, kind, groupId }: Props) {
  const { books: host, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const books = host.current;
  if (!books) {
    return (
      <section class="screen" aria-labelledby="report-title">
        <h1 id="report-title">{titleWithoutBooks(report, kind)}</h1>
        <p class="lede">Open a company first: press Alt+G and choose “Create Company” or “Load Demo Company”.</p>
      </section>
    );
  }
  // the two-sided statements have their own drawing; everything else is a list on the one grid
  if (report === 'profit-loss' || report === 'balance-sheet') return <StatementScreen frame={frame} report={report} />;
  if (report === 'gstr1' || report === 'gstr3b' || report === 'gst-purchases') return <GstScreen frame={frame} report={report} kind={kind} />;
  return <ReportBody frame={frame} report={report} ledgerFromAddress={ledgerFromAddress} itemFromAddress={itemFromAddress} kind={kind} groupFromAddress={groupId} />;
}

function ReportBody({
  frame,
  report,
  ledgerFromAddress,
  itemFromAddress,
  kind,
  groupFromAddress,
}: {
  frame: Frame<ScreenRef>;
  report: ReportKind;
  ledgerFromAddress: string | undefined;
  itemFromAddress: string | undefined;
  kind: string | undefined;
  groupFromAddress: string | undefined;
}) {
  const { books: host, app, keymapStore } = useServices();
  const books = host.current as NonNullable<typeof host.current>;
  useSubscriptions(books);
  const masters = books.masters;

  const fy = masters.financialYears.find((y) => {
    const t = new Date().toISOString().slice(0, 10);
    return t >= y.start && t <= y.end;
  }) ?? masters.financialYears.at(-1);
  const [query, setQuery] = useFrameState<GridQuery>(frame, 'query', EMPTY_QUERY);
  // Outstanding is AS ON a date (today, unless changed with F2); the rest cover the financial year.
  const today = new Date().toISOString().slice(0, 10);
  const asOnReport = report === 'outstanding';
  const [period, setPeriod] = useFrameState<Period>(frame, 'period', { from: fy?.start ?? '', to: asOnReport && fy && today >= fy.start && today <= fy.end ? today : (fy?.end ?? '') });
  const [types, setTypes] = useFrameState<string[]>(frame, 'types', []);
  const [chosenLedger, setChosenLedger] = useFrameState<string | undefined>(frame, 'ledger', undefined);
  const [col, setCol] = useFrameState<number>(frame, 'col', 0);
  const [row, setRow] = useFrameState<number>(frame, 'row', 0);
  const [dialog, setDialog] = useState<Dialog>(report === 'ledger' && !ledgerFromAddress ? 'ledger' : undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dialog === undefined) inputRef.current?.focus();
  }, [dialog]);

  const ledgerId = ledgerFromAddress ?? chosenLedger;
  const range = { from: localDate(period.from), to: localDate(period.to) };
  const typeChoices = useMemo(() => masters.voucherTypes.filter((t) => t.isActive !== false).map((t) => ({ value: t.name, label: t.name })), [masters]);
  const typeIdOfName = (name: string) => masters.voucherTypes.find((t) => t.name === name)?.id ?? name;

  // ---- the data ----
  const day = useMemo(
    () => (report === 'daybook' ? dayBookRows({ vouchers: books.vouchers, lines: books.lines, masters, range }) : []),
    [report, books.vouchers, books.lines, masters, period.from, period.to],
  );
  const statement = useMemo(
    () => (report === 'ledger' && ledgerId ? ledgerStatement({ ledgerId: ledgerId as never, vouchers: books.vouchers, lines: books.lines, masters, range }) : undefined),
    [report, ledgerId, books.vouchers, books.lines, masters, period.from, period.to],
  );

  // the stock reports
  const itemId = itemFromAddress as StockItemId | undefined;
  const stockRows = useMemo(
    () => (report === 'stock-summary' ? stockSummaryRows(masters, books.stock, range.from, range.to, books.orders) : []),
    [report, masters, books.stock, books.orders, period.from, period.to],
  );
  const stockLedger = useMemo(
    () => (report === 'stock-item' && itemId ? stockLedgerOf(masters, books.stock, books.vouchers, itemId, range.from, range.to, books.orders) : undefined),
    [report, itemId, masters, books.stock, books.vouchers, books.orders, period.from, period.to],
  );

  // the Sales Order Register: one row per order line (for one item, when the address names it)
  const orderRows = useMemo(
    () => (report === 'sales-orders' || report === 'purchase-orders' ? orderRegisterRows(books.orders, masters, range.from, range.to, { itemId: itemFromAddress, side: report === 'purchase-orders' ? 'purchase' : 'sales', asOf: localDate(new Date().toISOString().slice(0, 10)) }) : []),
    [report, books.orders, masters, itemFromAddress, period.from, period.to],
  );

  // A voucher type's list (Transactions › Sales › Sales Vouchers): one row per voucher of that kind
  const listKind = kind as BaseKind | undefined;
  const voucherRows = useMemo(
    () => (report === 'vouchers' && listKind ? voucherListRows({ vouchers: books.vouchers, lines: books.lines, masters, orders: books.orders, kind: listKind, range, asOf: localDate(new Date().toISOString().slice(0, 10)) }) : []),
    [report, listKind, books.vouchers, books.lines, books.orders, masters, period.from, period.to],
  );

  // Trial Balance / Cash Book / Bank Book: the children of a group of the chart of accounts
  const bookKind = report === 'book' && (kind === 'cash' || kind === 'bank') ? kind : undefined;
  const tbBase = useMemo(() => {
    if (report === 'trial-balance') return tbRows({ masters, lines: books.lines, range, parentIds: groupFromAddress ? [groupFromAddress as never] : undefined });
    if (bookKind) return tbRows({ masters, lines: books.lines, range, parentIds: bookGroupIds(masters, bookKind), includeEmpty: true });
    return [];
  }, [report, bookKind, groupFromAddress, masters, books.lines, period.from, period.to]);

  // Outstanding receivables / payables: a row per party, or — with a party in the address — a row per bill
  const side = kind === 'payable' ? 'payable' : 'receivable';
  const asOn = range.to;
  const partyBase = useMemo(
    () => (report === 'outstanding' && !ledgerFromAddress ? partyRows({ vouchers: books.vouchers, lines: books.lines, masters, side, asOn }) : []),
    [report, ledgerFromAddress, side, books.vouchers, books.lines, masters, period.to],
  );
  const billBase = useMemo(
    () => (report === 'outstanding' && ledgerFromAddress ? billRows({ vouchers: books.vouchers, masters, side, asOn, ledgerId: ledgerFromAddress as never }) : []),
    [report, ledgerFromAddress, side, books.vouchers, masters, period.to],
  );

  const typeIds = types.map(typeIdOfName);
  const dayRows = onlyVoucherTypes(day, typeIds);
  const view = statement ? statementView(statement, typeIds) : undefined;

  const dayCols = useMemo(() => dayBookColumns(typeChoices), [typeChoices]);
  const ledCols = useMemo(() => ledgerColumns(typeChoices), [typeChoices]);
  const sumCols = useMemo(() => stockSummaryColumns(), []);
  const itemCols = useMemo(() => stockLedgerColumns(typeChoices), [typeChoices]);
  const orderCols = useMemo(() => orderRegisterColumns(report === 'purchase-orders' ? 'purchase' : 'sales'), [report]);
  const listCols = useMemo(() => voucherListColumns(listKind ?? 'journal'), [listKind]);
  const tbCols = useMemo(() => tbColumns(), []);
  const partyCols = useMemo(() => partyColumns(side), [side]);
  const billCols = useMemo(() => billColumns(), []);
  const columns = (
    report === 'daybook'
      ? dayCols
      : report === 'ledger'
        ? ledCols
        : report === 'stock-summary'
          ? sumCols
          : report === 'sales-orders' || report === 'purchase-orders'
            ? orderCols
            : report === 'vouchers'
              ? listCols
              : report === 'trial-balance' || report === 'book'
                ? tbCols
                : report === 'outstanding'
                  ? ledgerFromAddress
                    ? billCols
                    : partyCols
                  : itemCols
  ) as readonly ColumnSpec<AnyRow>[];
  const baseRows = (
    report === 'daybook' ? dayRows : report === 'ledger' ? (view?.rows ?? []) : report === 'stock-summary' ? stockRows : report === 'sales-orders' || report === 'purchase-orders' ? orderRows : report === 'vouchers' ? voucherRows : report === 'trial-balance' || report === 'book' ? tbBase : report === 'outstanding' ? (ledgerFromAddress ? billBase : partyBase) : onlyVoucherTypes(stockLedger?.rows ?? [], typeIds)
  ) as readonly AnyRow[];
  // Every list opens NEWEST FIRST (the running balances stay true: they were worked out oldest first). A column sort replaces it; clearing the sort returns to it.
  const newestFirst = useMemo(
    () => (report === 'stock-summary' || report === 'trial-balance' || report === 'book' || report === 'outstanding' ? baseRows : report === 'sales-orders' || report === 'purchase-orders' ? newestOrdersFirst(baseRows as readonly OrderRow[]) : [...baseRows].reverse()),
    [report, baseRows],
  );
  const rows = useMemo(() => applyGridQuery(newestFirst, columns, query), [newestFirst, columns, query]);
  const safeRow = Math.min(row, Math.max(0, rows.length - 1));
  const safeCol = Math.min(col, columns.length - 1);
  const column = columns[safeCol] as ColumnSpec<AnyRow>;

  const drill = (i: number) => {
    const r = rows[i];
    if (!r) return;
    // the books: a group opens one level down, a ledger its statement, a party its bills, a bill the voucher that raised it
    if ('rowType' in r) {
      if (r.rowType === 'tb') app.navigate(r.kind === 'group' ? { type: 'report', report: 'trial-balance', groupId: r.id } : { type: 'report', report: 'ledger', ledgerId: r.id });
      else if (r.rowType === 'party') app.navigate({ type: 'report', report: 'outstanding', kind: side, ledgerId: r.ledgerId });
      else {
        // a bill brought forward as an opening balance has no voucher to show: its party's ledger is where it lives
        const raised = books.voucher(r.voucherId);
        if (raised && masters.voucherType(raised.voucherTypeId)?.baseKind === 'opening') app.navigate({ type: 'report', report: 'ledger', ledgerId: r.ledgerId });
        else app.navigate({ type: 'voucher', mode: 'display', id: r.voucherId });
      }
      return;
    }
    // an order line opens its order; a summary row opens that item's ledger; every other row opens its voucher
    if ('orderId' in r) app.navigate({ type: 'voucher', mode: 'display', id: r.orderId });
    else if ('itemId' in r && !('voucherId' in r)) app.navigate({ type: 'report', report: 'stock-item', itemId: r.itemId });
    else if ('voucherId' in r) app.navigate({ type: 'voucher', mode: 'display', id: (r as { voucherId: string }).voucherId });
  };
  useListNavigation(SCOPE, { count: rows.length, index: safeRow, setIndex: setRow, onActivate: drill, homeEnd: false, pageSize: 10 });

  const moveCol = (delta: number) => setCol((safeCol + delta + columns.length) % columns.length);
  useCommandHandler(SCOPE, 'field.next', () => (moveCol(1), true));
  useCommandHandler(SCOPE, 'field.prev', () => (moveCol(-1), true));
  // ←/→ move the column too — unless something is typed in the quick filter, where they must move its caret.
  useCommandHandler(SCOPE, 'nav.left', () => (query.quick === '' ? (moveCol(-1), true) : false));
  useCommandHandler(SCOPE, 'nav.right', () => (query.quick === '' ? (moveCol(1), true) : false));
  useCommandHandler(SCOPE, 'grid.sort', () => {
    if (column.sortable === false) return true;
    setQuery(cycleSort(query, column.id));
    return true;
  });
  useCommandHandler(SCOPE, 'grid.filter', () => {
    if (column.filterable === false) return true;
    setDialog('filter');
    return true;
  });
  useCommandHandler(SCOPE, 'grid.clear', () => {
    setQuery({ ...query, filters: {}, quick: '' });
    setTypes([]);
    setRow(0);
    return true;
  });
  useCommandHandler(SCOPE, 'voucher.changeDate', () => (setDialog('period'), true));

  // ---- a voucher list: New opens the create window ON TOP; when it saves it closes back here and hands over what it made ----
  const [notice, setNotice] = useFrameState<string | undefined>(frame, 'notice', undefined);
  const newVoucher = (): boolean => {
    if (!listKind) return false;
    setNotice(undefined);
    void app.navigateForResult<{ id: string; number: string; typeName: string }>({ type: 'voucher', mode: 'create', typeKey: listKind }).then((made) => {
      if (!made) return;
      frame.state.set('notice', `${made.typeName} ${made.number} saved.`);
      frame.state.set('select', made.id);
    });
    return true;
  };
  // the voucher just made is the row under the cursor
  const selectId = frame.state.get('select') as string | undefined;
  useEffect(() => {
    if (!selectId) return;
    const i = rows.findIndex((r) => 'voucherId' in r && (r as { voucherId: string }).voucherId === selectId);
    if (i >= 0) {
      setRow(i);
      frame.state.delete('select');
    }
  }, [selectId, rows.length]);

  // ---- header pieces ----
  const ledger = ledgerId ? masters.ledger(ledgerId as never) : undefined;
  const group = ledger ? masters.groups.get(ledger.groupId)?.name : undefined;
  const stockItem = itemId ? masters.stockItem(itemId) : undefined;
  const listTypeName = listKind ? (masters.voucherTypes.find((t) => t.baseKind === listKind && t.isSystem)?.name ?? masters.voucherTypes.find((t) => t.baseKind === listKind)?.name ?? listKind) : '';
  const groupOpened = groupFromAddress ? masters.groups.get(groupFromAddress as never) : undefined;
  const partyOpened = ledgerFromAddress && report === 'outstanding' ? masters.ledger(ledgerFromAddress as never) : undefined;
  const title =
    report === 'trial-balance'
      ? groupOpened
        ? `Trial Balance: ${groupOpened.name}`
        : 'Trial Balance'
      : report === 'book'
        ? bookKind === 'cash'
          ? 'Cash Book'
          : 'Bank Book'
        : report === 'outstanding'
          ? partyOpened
            ? `Outstanding: ${partyOpened.name}`
            : side === 'payable'
              ? 'Outstanding Payables'
              : 'Outstanding Receivables'
          : report === 'vouchers'
      ? listTitle(listTypeName)
      : report === 'daybook'
      ? 'Day Book'
      : report === 'stock-summary'
        ? 'Stock Summary'
        : report === 'stock-item'
          ? stockItem
            ? `Stock: ${stockItem.name}`
            : 'Stock Ledger'
          : report === 'sales-orders' || report === 'purchase-orders'
            ? stockItem
              ? `${report === 'purchase-orders' ? 'Purchase' : 'Sales'} orders: ${stockItem.name}`
              : report === 'purchase-orders'
                ? 'Purchase Order Register'
                : 'Sales Order Register'
            : ledger
              ? `Ledger: ${ledger.name}`
              : 'Ledger';
  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];

  const chips: { key: string; text: string; clear: () => void }[] = [
    ...(types.length > 0 ? [{ key: '__types', text: `Type: ${types.join(', ')}`, clear: () => setTypes([]) }] : []),
    ...Object.entries(query.filters).flatMap(([id, f]) => {
      const c = columns.find((x) => x.id === id);
      return c ? [{ key: id, text: describeFilter(c, f), clear: () => setQuery(withFilter(query, id, undefined)) }] : [];
    }),
  ];

  // ---- totals of what is shown ----
  let shownDebit = 0n;
  let shownCredit = 0n;
  for (const r of rows) {
    if ('debit' in r) {
      shownDebit += r.debit;
      shownCredit += r.credit;
    }
  }
  const totals = report === 'stock-summary' ? summaryTotals(rows as readonly StockSummaryRow[]) : undefined;
  let shownIn = 0n;
  let shownOut = 0n;
  if (report === 'stock-item') {
    for (const r of rows as readonly StockLedgerRow[]) {
      shownIn += r.inValue;
      shownOut += r.outValue;
    }
  }

  const filterDialog = () => {
    const c = column;
    const existing = query.filters[c.id];
    const done = (f: ColumnFilter | undefined) => {
      setQuery(withFilter(query, c.id, f));
      setRow(0);
      setDialog(undefined);
    };
    if (c.type === 'choice') {
      const options = c.choices ?? [];
      return (
        <MultiSelectDialog
          title={`Filter ${c.label}`}
          options={options}
          selected={existing?.kind === 'in' ? existing.values : []}
          onDone={(values) => (values === undefined ? setDialog(undefined) : done(values.length === 0 ? undefined : { kind: 'in', values }))}
        />
      );
    }
    if (c.type === 'text') {
      return (
        <FieldsDialog
          title={`Filter ${c.label}`}
          fields={[{ key: 'text', label: `${c.label} contains`, value: existing?.kind === 'contains' ? existing.text : '' }]}
          onDone={(v) => (v === undefined ? setDialog(undefined) : done((v['text'] ?? '').trim() === '' ? undefined : { kind: 'contains', text: (v['text'] ?? '').trim() }))}
        />
      );
    }
    const isDate = c.type === 'date';
    const isNumber = c.type === 'number';
    const parse = (t: string): string | bigint | number | undefined => {
      if (isDate) return parseDateInput(t, { start: period.from, end: period.to, base: period.from });
      if (isNumber) return /^\d+(\.\d+)?$/.test(t.trim().replace(/,/g, '')) ? Number(t.trim().replace(/,/g, '')) : undefined;
      return minor(t);
    };
    const shown = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'bigint' ? formatAmount(v) : isDate ? formatDate(String(v)) : String(v));
    return (
      <FieldsDialog
        title={`Filter ${c.label}`}
        fields={[
          { key: 'min', label: 'From', value: existing?.kind === 'range' ? shown(existing.min) : '', hint: isDate ? 'a date like 10-5-24' : isNumber ? 'a quantity like 25' : 'an amount like 10,000' },
          { key: 'max', label: 'To', value: existing?.kind === 'range' ? shown(existing.max) : '' },
        ]}
        validate={(v) => {
          const errs: Record<string, string> = {};
          for (const k of ['min', 'max']) if ((v[k] ?? '').trim() !== '' && parse(v[k] ?? '') === undefined) errs[k] = isDate ? 'That is not a date' : isNumber ? 'That is not a number' : 'That is not an amount';
          return errs;
        }}
        onDone={(v) => {
          if (v === undefined) return setDialog(undefined);
          const min = (v['min'] ?? '').trim() === '' ? undefined : parse(v['min'] ?? '');
          const max = (v['max'] ?? '').trim() === '' ? undefined : parse(v['max'] ?? '');
          done(min === undefined && max === undefined ? undefined : { kind: 'range', min, max });
        }}
      />
    );
  };

  return (
    <section class="screen report-screen" aria-labelledby="report-title" data-testid="report">
      <h1 id="report-title">{title}</h1>
      <p class="lede" data-testid="report-period">
        {asOnReport ? <>As on {formatDate(period.to)}</> : <>{formatDate(period.from)} → {formatDate(period.to)}</>}{' '}
        {chord('voucher.changeDate') && <Kbd chord={chord('voucher.changeDate') as string} />} {asOnReport ? 'date' : 'period'}
        {group && <> · under {group}</>}
      </p>

      {report === 'ledger' && statement && (
        <p class="report-figures" data-testid="ledger-opening">
          Opening balance <strong>{formatBalance(statement.opening)}</strong>
        </p>
      )}
      {report === 'stock-item' && stockLedger && stockItem && (
        <p class="report-figures" data-testid="stock-opening">
          Opening <strong>{formatQuantity(stockLedger.opening.qty, masters.unit(stockItem.unitId)?.decimals ?? 0)} {masters.unit(stockItem.unitId)?.symbol}</strong> worth <strong>{formatAmount(stockLedger.opening.value)}</strong>
        </p>
      )}
      {report === 'vouchers' && notice && (
        <p class="notice" role="status" data-testid="list-notice">
          {notice}
        </p>
      )}
      {report === 'stock-item' && !stockItem && <p class="empty">Choose an item from the Stock Summary (Enter on a row), or find it with Go To.</p>}

      <div class="chips" data-testid="chips">
        {chips.map((c) => (
          <span key={c.key} class="chip" data-testid="chip">
            {c.text}
            <button type="button" class="chip-x" aria-label={`Remove filter ${c.text}`} onClick={c.clear}>
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
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
          {baseRows.length === 0 ? 'Nothing in this period.' : 'No rows match the filters.'}
        </p>
      ) : (
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={rowKeyOf}
          activeRow={safeRow}
          activeCol={safeCol}
          query={query}
          label={title}
          rowClass={(r) =>
            'rowType' in r
              ? r.rowType === 'tb'
                ? ''
                : outstandingRowClass(r)
              : 'cancelled' in r
              ? voucherRowClass(r)
              : 'orderId' in r
              ? orderRowClass(r)
              : 'isOrder' in r && r.isOrder
                ? r.actionable
                  ? 'open-line'
                  : r.orderStatus === 'Closed'
                    ? 'closed-order'
                    : ''
                : 'status' in r && r.status === 'cancelled'
                  ? 'cancelled'
                  : ''
          }
          onPickRow={(i) => (setRow(i), drill(i))}
          onPickColumn={setCol}
          onSortColumn={(i) => {
            const c = columns[i] as ColumnSpec<AnyRow>;
            if (c.sortable !== false) setQuery(cycleSort(query, c.id));
          }}
        />
      )}

      {report === 'stock-item' && stockLedger && stockItem && (
        <p class="report-figures" data-testid="stock-position">
          Current stock{' '}
          <strong data-testid="stock-current">
            {formatQuantity(stockLedger.current.qty, masters.unit(stockItem.unitId)?.decimals ?? 0)} {masters.unit(stockItem.unitId)?.symbol}
          </strong>{' '}
          worth <strong>{formatAmount(stockLedger.current.value)}</strong> · Committed to open sales orders{' '}
          <strong data-testid="stock-committed">
            {formatQuantity(stockLedger.committed, masters.unit(stockItem.unitId)?.decimals ?? 0)} {masters.unit(stockItem.unitId)?.symbol}
          </strong>{' '}
          {stockLedger.onOrder > 0n && (
            <>
              · On order from suppliers{' '}
              <strong data-testid="stock-on-order">
                {formatQuantity(stockLedger.onOrder, masters.unit(stockItem.unitId)?.decimals ?? 0)} {masters.unit(stockItem.unitId)?.symbol}
              </strong>{' '}
            </>
          )}
          · Available{' '}
          <strong data-testid="stock-available">
            {formatQuantity(stockLedger.available as never, masters.unit(stockItem.unitId)?.decimals ?? 0)} {masters.unit(stockItem.unitId)?.symbol}
          </strong>
        </p>
      )}
      <p class="report-foot" data-testid="report-foot">
        {rows.length} shown of {baseRows.length}
        {' · '}
        {(report === 'trial-balance' || report === 'book') &&
          (() => {
            let debit = 0n;
            let credit = 0n;
            let closingDebit = 0n;
            let closingCredit = 0n;
            for (const x of rows as readonly TbRow[]) {
              debit += x.debit;
              credit += x.credit;
              if (x.closing > 0n) closingDebit += x.closing;
              else closingCredit -= x.closing;
            }
            return (
              <span data-testid="tb-totals">
                Total debit <strong data-testid="tb-debit">{formatAmount(debit)}</strong> credit <strong data-testid="tb-credit">{formatAmount(credit)}</strong> · closing Dr <strong data-testid="tb-closing-dr">{formatAmount(closingDebit)}</strong> Cr{' '}
                <strong data-testid="tb-closing-cr">{formatAmount(closingCredit)}</strong>
                {report === 'trial-balance' && !groupFromAddress && closingDebit === closingCredit ? ' ✓ the books balance' : ''}
              </span>
            );
          })()}
        {report === 'outstanding' &&
          !ledgerFromAddress &&
          (() => {
            const t = partyTotals(rows as readonly PartyRow[]);
            return (
              <span data-testid="outstanding-totals">
                Pending <strong data-testid="out-pending">{formatAmount(t.pending)}</strong> · overdue <strong data-testid="out-overdue">{formatAmount(t.overdue)}</strong> · ledger balance <strong data-testid="out-balance">{formatAmount(t.balance)}</strong>
              </span>
            );
          })()}
        {report === 'outstanding' && ledgerFromAddress && (
          <span data-testid="outstanding-totals">
            Pending <strong data-testid="out-pending">{formatAmount((rows as readonly OutstandingBillRow[]).reduce((s, b) => s + b.pending, 0n))}</strong>
          </span>
        )}
        {report === 'vouchers' &&
          (() => {
            const t = listTotals(rows as readonly VoucherListRow[]);
            return (
              <>
                {t.amount > 0n && (
                  <>
                    Total <strong data-testid="list-total">{formatAmount(t.amount)}</strong>
                    {t.cancelled > 0 ? ` · ${t.cancelled} cancelled` : ''}
                  </>
                )}
                {t.amount === 0n && t.cancelled > 0 ? `${t.cancelled} cancelled` : ''}
              </>
            );
          })()}
        {report === 'stock-summary' && totals && (
          <>
            {hasActiveFilters(query) ? 'Filtered total' : 'Total'} — opening <strong>{formatAmount(totals.opening)}</strong> · inward <strong>{formatAmount(totals.inward)}</strong> · outward <strong>{formatAmount(totals.outward)}</strong> · closing stock value <strong data-testid="stock-closing-value">{formatAmount(totals.closing)}</strong>
          </>
        )}
        {(report === 'sales-orders' || report === 'purchase-orders') && (
          <span data-testid="order-counts">
            {(() => {
              const c = registerCounts(rows as readonly OrderRow[]);
              return `${c.orders} order${c.orders === 1 ? '' : 's'} · ${c.open} open line${c.open === 1 ? '' : 's'}${c.overdue > 0 ? ` (${c.overdue} overdue)` : ''} — bold lines are still to ${report === 'purchase-orders' ? 'receive' : 'deliver'}`;
            })()}
          </span>
        )}
        {report === 'stock-item' && stockLedger && stockItem && (
          <>
            {hasActiveFilters(query) ? 'Filtered' : 'Total'} inward value <strong>{formatAmount(shownIn)}</strong> · outward value <strong>{formatAmount(shownOut)}</strong> · closing{' '}
            <strong data-testid="stock-closing">
              {formatQuantity(stockLedger.closing.qty, masters.unit(stockItem.unitId)?.decimals ?? 0)} {masters.unit(stockItem.unitId)?.symbol} · {formatAmount(stockLedger.closing.value)}
            </strong>
          </>
        )}
        {(report === 'daybook' || report === 'ledger') && (
          <>
            {report === 'daybook' ? 'Totals' : hasActiveFilters(query) || types.length > 0 ? 'Filtered total' : 'Total'} debit <strong>{formatAmount(shownDebit)}</strong> credit <strong>{formatAmount(shownCredit)}</strong>
          </>
        )}
        {report === 'ledger' && statement && (
          <>
            {' · '}Closing balance <strong data-testid="ledger-closing">{formatBalance(statement.closing)}</strong>
          </>
        )}
      </p>

      {report === 'vouchers' && listKind && <Only scope={SCOPE} command={`list.new.${listKind}`} run={newVoucher} />}
      {(report === 'daybook' || report === 'ledger' || report === 'stock-item') && <Only scope={SCOPE} command="report.types" run={() => (setDialog('types'), true)} />}
      {dialog === 'filter' && filterDialog()}
      {dialog === 'types' && (
        <MultiSelectDialog
          title="Voucher types"
          options={typeChoices}
          selected={types}
          onDone={(values) => {
            if (values) {
              setTypes(values);
              setRow(0);
            }
            setDialog(undefined);
          }}
        />
      )}
      {dialog === 'period' && (
        <FieldsDialog
          title={asOnReport ? 'As on' : 'Period'}
          fields={
            asOnReport
              ? [{ key: 'to', label: 'As on', value: formatDate(period.to), hint: 'a date like 30-6-24' }]
              : [
                  { key: 'from', label: 'From', value: formatDate(period.from), hint: 'a date like 1-4-24' },
                  { key: 'to', label: 'To', value: formatDate(period.to) },
                ]
          }
          validate={(v) => {
            const errs: Record<string, string> = {};
            const ctx = { start: fy?.start ?? period.from, end: fy?.end ?? period.to, base: period.from };
            const from = asOnReport ? localDate(period.from) : parseDateInput(v['from'] ?? '', ctx);
            const to = parseDateInput(v['to'] ?? '', ctx);
            if (!from) errs['from'] = 'That is not a date';
            if (!to) errs['to'] = 'That is not a date';
            if (from && to && from > to) errs['to'] = 'The end is before the start';
            return errs;
          }}
          onDone={(v) => {
            if (v) {
              const ctx = { start: fy?.start ?? period.from, end: fy?.end ?? period.to, base: period.from };
              setPeriod({ from: asOnReport ? period.from : (parseDateInput(v['from'] ?? '', ctx) ?? period.from), to: parseDateInput(v['to'] ?? '', ctx) ?? period.to });
              setRow(0);
            }
            setDialog(undefined);
          }}
        />
      )}
      {dialog === 'ledger' && (
        <LedgerDialog
          ledgers={masters.ledgers.filter((l) => l.isActive).map((l) => ({ id: l.id, name: l.name, group: masters.groups.get(l.groupId)?.name ?? '' }))}
          onDone={(id) => {
            setDialog(undefined);
            if (id) setChosenLedger(id);
            else if (!ledgerId) app.back();
          }}
        />
      )}
    </section>
  );
}
