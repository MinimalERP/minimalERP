import { useMemo, useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { fillText, registerCounts } from '../reports/salesReports';
import { formatDate, formatQuantity } from '../vouchers/format';
import { dayBook, orderRegister } from './data';
import type { MobileNav } from './nav';
import { Empty, Frame, Group, Row, Search, matches, rupees } from './ui';

/**
 * Reports on the phone: the ones a person looks at away from the desk. Each is the desktop report's own rows (mobile/data.ts), drawn as
 * rows for a thumb — filter as you type, tap a row for the voucher behind it.
 */

export function ReportsMenu({ nav }: { nav: MobileNav }) {
  return (
    <Frame nav={nav} title="Reports">
      <Group title="Orders">
        <Row title="Sales Order Register" sub="Every order line: delivered, pending, due" onOpen={() => nav.open({ page: 'orderRegister', side: 'sales' })} testId="report-sales-orders" />
        <Row title="Purchase Order Register" sub="What we have ordered and not yet received" onOpen={() => nav.open({ page: 'orderRegister', side: 'purchase' })} testId="report-purchase-orders" />
      </Group>
      <Group title="Money">
        <Row title="Receivable" sub="What customers owe, by party" onOpen={() => nav.open({ page: 'outstanding', side: 'receivable' })} />
        <Row title="Payable" sub="What we owe suppliers, by party" onOpen={() => nav.open({ page: 'outstanding', side: 'payable' })} />
      </Group>
      <Group title="Books">
        <Row title="Day Book" sub="Every voucher of a day" onOpen={() => nav.open({ page: 'dayBook' })} testId="report-day-book" />
        <Row title="Stock" sub="What is in the godowns" onOpen={() => nav.open({ page: 'items' })} />
      </Group>
    </Frame>
  );
}

const PAGE = 60;

/** One row per order line. It opens on what is still to be delivered (received), earliest due first — the lines to act on. */
export function OrderRegister({ books, nav, side, today }: { books: Books; nav: MobileNav; side: 'sales' | 'purchase'; today: string }) {
  const [text, setText] = useState('');
  const [all, setAll] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const rows = useMemo(() => orderRegister(books, side, today), [books.vouchers, books.masters, side, today]);
  const counts = registerCounts(rows);
  const listed = (all ? rows : rows.filter((r) => r.actionable).sort((a, b) => (a.due !== b.due ? (a.due < b.due ? -1 : 1) : a.number.localeCompare(b.number)))).filter((r) =>
    matches(text, r.item, r.party, r.reference, r.number),
  );
  const done = side === 'sales' ? 'delivered' : 'received';
  return (
    <Frame nav={nav} title={side === 'sales' ? 'Sales Order Register' : 'Purchase Order Register'}>
      <Search value={text} onInput={setText} label={side === 'sales' ? 'Filter: item, customer, PO' : 'Filter: item, supplier, order'} />
      <div class="m-field m-field-bare">
        <span class="m-seg" role="group" aria-label="Which lines">
          <button type="button" class={all ? '' : 'm-seg-on'} aria-pressed={!all} data-testid="register-open" onClick={() => setAll(false)}>
            Pending ({counts.open})
          </button>
          <button type="button" class={all ? 'm-seg-on' : ''} aria-pressed={all} data-testid="register-all" onClick={() => setAll(true)}>
            All ({counts.lines})
          </button>
        </span>
      </div>
      {counts.overdue > 0 && !all ? (
        <p class="m-note bad" data-testid="register-overdue">
          {counts.overdue} line{counts.overdue === 1 ? ' is' : 's are'} past the due date.
        </p>
      ) : null}
      {listed.length === 0 ? (
        <Empty>{rows.length === 0 ? 'No orders yet.' : all ? 'No match.' : text.trim() === '' ? `Nothing pending: everything ordered has been ${done}.` : 'No match.'}</Empty>
      ) : (
        listed.slice(0, shown).map((r) => (
          <Row
            key={r.key}
            title={r.item}
            sub={[side === 'sales' && r.reference ? r.reference : r.number, r.party, `${fillText(r)} ${done}`].filter(Boolean).join(' · ')}
            value={r.actionable ? `${formatQuantity(r.pending, r.decimals)} ${r.unit}`.trim() : r.status === 'Closed' && !r.filled ? 'Closed' : 'Done'}
            note={`due ${formatDate(r.due)}`}
            tone={r.overdue ? 'bad' : r.actionable ? undefined : 'muted'}
            onOpen={() => nav.open({ page: 'doc', voucherId: r.orderId })}
            testId="register-row"
          />
        ))
      )}
      {listed.length > shown ? (
        <button type="button" class="m-more" onClick={() => setShown(shown + PAGE)}>
          Show more ({listed.length - shown} more)
        </button>
      ) : null}
    </Frame>
  );
}

/** Every voucher of one day (today, until another is chosen), newest first. */
export function DayBook({ books, nav, today }: { books: Books; nav: MobileNav; today: string }) {
  const [date, setDate] = useState(today);
  const rows = useMemo(() => dayBook(books, date), [books.vouchers, books.lines, books.masters, date]);
  return (
    <Frame nav={nav} title="Day Book">
      <label class="m-field">
        <span class="m-field-label">Date</span>
        <input type="date" class="m-input" aria-label="Day" value={date} max={today} onChange={(e) => (e.target as HTMLInputElement).value && setDate((e.target as HTMLInputElement).value)} />
      </label>
      {rows.length === 0 ? (
        <Empty>Nothing was entered on {formatDate(date)}.</Empty>
      ) : (
        <Group title={`${rows.length} voucher${rows.length === 1 ? '' : 's'}`}>
          {rows.map((r) => (
            <Row
              key={r.voucherId}
              title={r.status === 'cancelled' ? `${r.number} — cancelled` : r.number}
              sub={[r.voucherType, r.particulars].filter(Boolean).join(' · ')}
              value={r.debit === 0n ? undefined : rupees(r.debit)}
              tone={r.status === 'cancelled' ? 'muted' : undefined}
              onOpen={() => nav.open({ page: 'doc', voucherId: r.voucherId })}
              testId="daybook-row"
            />
          ))}
        </Group>
      )}
    </Frame>
  );
}
