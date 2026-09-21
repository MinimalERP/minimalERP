import type { Frame } from '@minimalerp/command';
import { type Statement, type StatementLine, balanceSheet, localDate, profitAndLoss } from '@minimalerp/domain';
import { useMemo, useState } from 'preact/hooks';
import { useCommandHandler, useFrameState, useServices, useSubscriptions } from '../shell/hooks';
import type { ReportKind, ScreenRef } from '../shell/router';
import { Kbd } from '../ui/Kbd';
import { formatAmount, formatDate, parseDateInput } from '../vouchers/format';
import { FieldsDialog } from './ReportDialogs';

const SCOPE = 'screen:report';

interface Pos {
  readonly side: 'left' | 'right';
  readonly row: number;
}

/**
 * Profit & Loss and the Balance Sheet: the two-sided statements. The figures come from the pure domain functions (`profitAndLoss`,
 * `balanceSheet`) — this screen only draws them under the report chrome (title, period, panel, Esc) and moves a cursor: ↑↓ down a side,
 * ←→ or Tab to the other side, Enter opens the group behind a line (the Trial Balance one level down; stock lines open the Stock Summary).
 */
export function StatementScreen({ frame, report }: { frame: Frame<ScreenRef>; report: ReportKind }) {
  const { books: host, app, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const books = host.current as NonNullable<typeof host.current>;
  useSubscriptions(books);
  const masters = books.masters;
  const isSheet = report === 'balance-sheet';

  const today = new Date().toISOString().slice(0, 10);
  const fy = masters.financialYears.find((y) => today >= y.start && today <= y.end) ?? masters.financialYears.at(-1);
  const [period, setPeriod] = useFrameState<{ from: string; to: string }>(frame, 'period', { from: fy?.start ?? '', to: isSheet && fy && today >= fy.start && today <= fy.end ? today : (fy?.end ?? '') });
  const [pos, setPos] = useFrameState<Pos>(frame, 'pos', { side: 'left', row: 0 });
  const [asking, setAsking] = useState(false);

  // the opening-stock vouchers: what the business started with (they reach the books through the stock, not a ledger — ADR-0014)
  const openingIds = useMemo(
    () => new Set<string>(books.vouchers.filter((v) => v.status === 'posted' && masters.voucherType(v.voucherTypeId)?.baseKind === 'stockOpening').map((v) => v.id)),
    [books.vouchers, masters],
  );
  const statement: Statement = useMemo(
    () =>
      isSheet
        ? balanceSheet({ masters, lines: books.lines, stock: books.stock, asOn: localDate(period.to), openingStockIds: openingIds })
        : profitAndLoss({ masters, lines: books.lines, stock: books.stock, range: { from: localDate(period.from), to: localDate(period.to) }, openingStockIds: openingIds }),
    [isSheet, masters, books.lines, books.stock, period.from, period.to, openingIds],
  );

  // every line of a side, top to bottom across the sections, is one list for the cursor
  const sideLines = (side: 'left' | 'right'): StatementLine[] => statement.sections.flatMap((s) => (side === 'left' ? s.left : s.right));
  const lefts = sideLines('left');
  const rights = sideLines('right');
  const count = (side: 'left' | 'right') => (side === 'left' ? lefts.length : rights.length);
  const safe: Pos = { side: pos.side, row: Math.min(pos.row, Math.max(0, count(pos.side) - 1)) };

  const drill = (line: StatementLine | undefined): boolean => {
    if (!line) return false;
    if (line.groupId) app.navigate({ type: 'report', report: 'trial-balance', groupId: line.groupId });
    else if (line.source === 'opening-stock' || line.source === 'closing-stock') app.navigate({ type: 'report', report: 'stock-summary' });
    else return false;
    return true;
  };
  const current = (safe.side === 'left' ? lefts : rights)[safe.row];

  const move = (delta: number): boolean => {
    const n = count(safe.side);
    if (n === 0) return false;
    setPos({ side: safe.side, row: Math.max(0, Math.min(n - 1, safe.row + delta)) });
    return true;
  };
  const cross = (): boolean => {
    const other = safe.side === 'left' ? 'right' : 'left';
    if (count(other) === 0) return false;
    setPos({ side: other, row: Math.min(safe.row, count(other) - 1) });
    return true;
  };
  useCommandHandler(SCOPE, 'nav.down', () => move(1));
  useCommandHandler(SCOPE, 'nav.up', () => move(-1));
  useCommandHandler(SCOPE, 'nav.left', () => (safe.side === 'right' ? cross() : false));
  useCommandHandler(SCOPE, 'nav.right', () => (safe.side === 'left' ? cross() : false));
  useCommandHandler(SCOPE, 'field.next', cross);
  useCommandHandler(SCOPE, 'field.prev', cross);
  useCommandHandler(SCOPE, 'nav.activate', () => drill(current));
  useCommandHandler(SCOPE, 'voucher.changeDate', () => (setAsking(true), true));

  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];
  const title = isSheet ? 'Balance Sheet' : 'Profit & Loss';
  const money = (m: bigint) => formatAmount(m);

  /** One side of one section; `offset` is where its first line sits in the side's whole list. */
  const side = (which: 'left' | 'right', lines: readonly StatementLine[], offset: number, heading: string, total: bigint, sectionId: string) => (
    <div class="stmt-side" data-testid={`stmt-${sectionId}-${which}`}>
      <div class="stmt-head">{heading}</div>
      {lines.map((l, i) => {
        const selected = safe.side === which && safe.row === offset + i;
        return (
          <div
            key={`${l.label}-${i}`}
            role="row"
            aria-selected={selected}
            data-testid="stmt-line"
            class={`stmt-row${selected ? ' selected' : ''}${l.groupId || l.source === 'opening-stock' || l.source === 'closing-stock' ? ' drillable' : ''}${l.source === 'result' || l.source === 'carried' ? ' derived' : ''}`}
            onClick={() => {
              setPos({ side: which, row: offset + i });
              drill(l);
            }}
          >
            <span class="stmt-label">{l.label}</span>
            <span class="stmt-amount amt">{money(l.amount)}</span>
          </div>
        );
      })}
      <div class="stmt-row stmt-total" data-testid={`stmt-${sectionId}-total-${which}`}>
        <span class="stmt-label">Total</span>
        <span class="stmt-amount amt">{money(total)}</span>
      </div>
    </div>
  );

  let leftAt = 0;
  let rightAt = 0;
  const sections = statement.sections.map((s) => {
    const el = (
      <div key={s.id} class="stmt" data-testid={`stmt-${s.id}`}>
        <h2 class="stmt-title">{s.title}</h2>
        <div class="stmt-sides">
          {side('left', s.left, leftAt, s.leftTitle, s.leftTotal, s.id)}
          {side('right', s.right, rightAt, s.rightTitle, s.rightTotal, s.id)}
        </div>
      </div>
    );
    leftAt += s.left.length;
    rightAt += s.right.length;
    return el;
  });

  const fmtResult = (m: bigint, profit: string, loss: string) => (m >= 0n ? `${profit} ${money(m)}` : `${loss} ${money(-m)}`);

  return (
    <section class="screen report-screen" aria-labelledby="report-title" data-testid="report">
      <h1 id="report-title">{title}</h1>
      <p class="lede" data-testid="report-period">
        {isSheet ? <>As on {formatDate(period.to)}</> : <>{formatDate(period.from)} → {formatDate(period.to)}</>}{' '}
        {chord('voucher.changeDate') && <Kbd chord={chord('voucher.changeDate') as string} />} {isSheet ? 'date' : 'period'} · <Kbd chord="Up" />
        <Kbd chord="Down" /> move · <Kbd chord="Tab" /> other side · <Kbd chord={chord('nav.activate') ?? 'Enter'} /> opens a group
      </p>
      {sections}
      <p class="report-foot" data-testid="report-foot">
        {isSheet ? (
          <>
            Total liabilities <strong data-testid="stmt-total-liabilities">{money(statement.sections[0]?.leftTotal ?? 0n)}</strong> = total assets <strong data-testid="stmt-total-assets">{money(statement.sections[0]?.rightTotal ?? 0n)}</strong>
            {' · '}
            <span data-testid="net-result">{fmtResult(statement.result, 'Profit to date', 'Loss to date')}</span>
          </>
        ) : (
          <>
            <span data-testid="gross-result">{fmtResult(statement.grossResult ?? 0n, 'Gross profit', 'Gross loss')}</span>
            {' · '}
            <span data-testid="net-result">{fmtResult(statement.result, 'Net profit', 'Net loss')}</span>
          </>
        )}
      </p>
      {asking && (
        <FieldsDialog
          title={isSheet ? 'As on' : 'Period'}
          fields={
            isSheet
              ? [{ key: 'to', label: 'As on', value: formatDate(period.to), hint: 'a date like 30-6-24' }]
              : [
                  { key: 'from', label: 'From', value: formatDate(period.from), hint: 'a date like 1-4-24' },
                  { key: 'to', label: 'To', value: formatDate(period.to) },
                ]
          }
          validate={(v) => {
            const errs: Record<string, string> = {};
            const ctx = { start: fy?.start ?? period.from, end: fy?.end ?? period.to, base: period.from };
            const from = isSheet ? localDate(period.from) : parseDateInput(v['from'] ?? '', ctx);
            const to = parseDateInput(v['to'] ?? '', ctx);
            if (!from) errs['from'] = 'That is not a date';
            if (!to) errs['to'] = 'That is not a date';
            if (from && to && from > to) errs['to'] = 'The end is before the start';
            return errs;
          }}
          onDone={(v) => {
            if (v) {
              const ctx = { start: fy?.start ?? period.from, end: fy?.end ?? period.to, base: period.from };
              setPeriod({ from: isSheet ? period.from : (parseDateInput(v['from'] ?? '', ctx) ?? period.from), to: parseDateInput(v['to'] ?? '', ctx) ?? period.to });
              setPos({ side: 'left', row: 0 });
            }
            setAsking(false);
          }}
        />
      )}
    </section>
  );
}
