import type { LocalDate } from '../dates';
import type { JournalLine } from '../posting/plan';
import type { Masters } from '../masters/masters';
import { type Money, money } from '../money';
import type { OrderBook } from '../orders/orderBook';
import { formatQty } from '../stock/quantity';
import type { Voucher } from '../vouchers/voucher';
import { dayBookRows } from './books';
import { gstr3b } from './gst';
import { outstandingBills, outstandingByParty } from './outstanding';

/**
 * The daily report (ADR-0023): what a proprietor wants to see at eight in the morning, taken from the same reports the screens show, so a
 * figure in the mail always agrees with the books. Pure: the caller loads the books and sends the mail.
 */
export interface DailyDigest {
  readonly company: string;
  readonly asOn: LocalDate;
  /** The day before `asOn`: what happened. */
  readonly yesterday: LocalDate;
  readonly day: { readonly sales: Money; readonly purchases: Money; readonly receipts: Money; readonly payments: Money; readonly vouchers: number; readonly orders: number };
  readonly receivables: { readonly total: Money; readonly overdue: Money; readonly topOverdue: readonly { readonly name: string; readonly overdue: Money; readonly oldestDays: number }[] };
  readonly payablesDue: { readonly total: Money; readonly bills: readonly { readonly party: string; readonly ref: string; readonly dueDate: LocalDate; readonly pending: Money }[] };
  /** Every customer order line still pending that is late or due within the week, earliest first. */
  readonly orders: { readonly overdueLines: number; readonly dueThisWeek: number; readonly lines: readonly DueItem[] };
  /** Output tax less eligible input tax, this month so far — only when the company charges GST. */
  readonly gstNetThisMonth: Money | undefined;
  readonly inboxWaiting: number;
}

/** One order line to deliver: when, against which customer PO, what and how much is still pending. */
export interface DueItem {
  readonly dueDate: LocalDate;
  /** The customer's PO number (the order's reference), or '' when the order has none. */
  readonly custPo: string;
  /** Our order number. */
  readonly number: string;
  readonly party: string;
  readonly item: string;
  /** What is still to deliver, with its unit ("40 Nos"). */
  readonly pending: string;
  readonly overdue: boolean;
  readonly daysLate: number;
}

/** At most this many due lines in the mail (the sheet gets them all). */
const MAIL_ITEMS = 40;

export interface DigestInput {
  readonly vouchers: readonly Voucher[];
  readonly lines: readonly JournalLine[];
  readonly masters: Masters;
  readonly orders: OrderBook;
  readonly asOn: LocalDate;
  readonly inboxWaiting: number;
}

const DAY_MS = 86_400_000;
const shift = (d: LocalDate, days: number): LocalDate => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10) as LocalDate;
const sum = (xs: Iterable<bigint>): Money => {
  let t = 0n;
  for (const x of xs) t += x;
  return money(t);
};
const TOP = 5;

export function dailyDigest({ vouchers, lines, masters, orders, asOn, inboxWaiting }: DigestInput): DailyDigest {
  const yesterday = shift(asOn, -1);
  const weekEnd = shift(asOn, 7);

  // ---- yesterday, by kind (the Day Book's own amounts) ----
  const rows = dayBookRows({ vouchers, lines, masters, range: { from: yesterday, to: yesterday } }).filter((r) => r.status === 'posted');
  const of = (kind: string) => sum(rows.filter((r) => r.baseKind === kind).map((r) => (r.debit > r.credit ? r.debit : r.credit)));
  const day = {
    sales: of('sales'),
    purchases: of('purchase'),
    receipts: of('receipt'),
    payments: of('payment'),
    vouchers: rows.length,
    orders: vouchers.filter((v) => v.status === 'posted' && v.date === yesterday && masters.voucherType(v.voucherTypeId)?.baseKind === 'salesOrder').length,
  };

  // ---- who owes us, and how late ----
  const parties = outstandingByParty({ vouchers, lines, masters, side: 'receivable', asOn });
  const overdueOf = (p: (typeof parties)[number]) => money(p.pending - p.buckets.notDue);
  const receivables = {
    total: sum(parties.map((p) => p.pending)),
    overdue: sum(parties.map(overdueOf)),
    topOverdue: parties
      .filter((p) => overdueOf(p) > 0n)
      .sort((a, b) => (overdueOf(b) > overdueOf(a) ? 1 : overdueOf(b) < overdueOf(a) ? -1 : 0))
      .slice(0, TOP)
      .map((p) => ({ name: p.name, overdue: overdueOf(p), oldestDays: p.oldest })),
  };

  // ---- what we must pay within the week (and anything already late) ----
  const due = outstandingBills({ vouchers, masters, side: 'payable', asOn })
    .filter((b) => b.dueDate <= weekEnd)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  const payablesDue = { total: sum(due.map((b) => b.pending)), bills: due.slice(0, TOP).map((b) => ({ party: b.party, ref: b.ref, dueDate: b.dueDate, pending: b.pending })) };

  // ---- customer order lines that are late or due this week ----
  const open = orders
    .all()
    .filter((s) => s.order.side === 'sales' && !s.order.closed)
    .flatMap((s) =>
      s.lines
        .filter((l) => l.pending > 0n && l.line.dueDate <= weekEnd)
        .map((l): DueItem => {
          const item = masters.stockItem(l.line.itemId);
          const unit = item ? masters.unit(item.unitId) : undefined;
          return {
            dueDate: l.line.dueDate,
            custPo: s.order.reference ?? '',
            number: s.order.number,
            party: masters.party(s.order.partyId)?.name ?? '',
            item: item?.name ?? '',
            pending: `${formatQty(l.pending, unit?.decimals ?? 0)}${unit ? ` ${unit.symbol}` : ''}`,
            overdue: l.line.dueDate < asOn,
            daysLate: l.line.dueDate < asOn ? Math.round((Date.parse(asOn) - Date.parse(l.line.dueDate)) / DAY_MS) : 0,
          };
        }),
    )
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.custPo.localeCompare(b.custPo)));

  const gst = masters.company.chargeGst === true ? gstr3b({ vouchers, lines, masters, range: { from: `${asOn.slice(0, 8)}01` as LocalDate, to: asOn } }).net.tax : undefined;

  return {
    company: masters.company.name,
    asOn,
    yesterday,
    day,
    receivables,
    payablesDue,
    orders: { overdueLines: open.filter((o) => o.overdue).length, dueThisWeek: open.filter((o) => !o.overdue).length, lines: open },
    gstNetThisMonth: gst,
    inboxWaiting,
  };
}

// ---- how it reads in a mail ----------------------------------------------------------------------------------------------

/** ₹ 1,23,456.00 — Indian grouping, always two decimals. */
export function inr(m: Money | bigint): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = (abs / 100n).toString();
  const paise = (abs % 100n).toString().padStart(2, '0');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}₹ ${rest ? `${rest},` : ''}${last3}.${paise}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dmy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;

/** The mail: a few short tables, inline styles only (mail clients drop style sheets). */
export function digestHtml(d: DailyDigest): string {
  const td = 'padding:4px 10px;border-bottom:1px solid #e0e0e0';
  const num = `${td};text-align:right;white-space:nowrap`;
  const table = (head: string, body: string) =>
    `<h3 style="margin:18px 0 6px;font:600 15px system-ui,sans-serif">${head}</h3><table style="border-collapse:collapse;font:14px system-ui,sans-serif">${body}</table>`;
  const row = (label: string, value: string) => `<tr><td style="${td}">${esc(label)}</td><td style="${num}">${esc(value)}</td></tr>`;
  const parts = [
    `<p style="font:14px system-ui,sans-serif;margin:0 0 4px">${esc(d.company)} — as on ${dmy(d.asOn)}</p>`,
    table(
      `Yesterday (${dmy(d.yesterday)})`,
      [row('Sales', inr(d.day.sales)), row('Purchases', inr(d.day.purchases)), row('Received', inr(d.day.receipts)), row('Paid', inr(d.day.payments)), row('Sales orders taken', String(d.day.orders))].join(''),
    ),
    table(
      'Receivables',
      [row('Outstanding', inr(d.receivables.total)), row('Of which overdue', inr(d.receivables.overdue)), ...d.receivables.topOverdue.map((p) => row(`${p.name} (oldest ${p.oldestDays} days)`, inr(p.overdue)))].join(''),
    ),
    table(
      'To pay in the next 7 days',
      d.payablesDue.bills.length === 0 ? row('Nothing due', '') : [row('Total', inr(d.payablesDue.total)), ...d.payablesDue.bills.map((b) => row(`${b.party} · ${b.ref} · due ${dmy(b.dueDate)}`, inr(b.pending)))].join(''),
    ),
    dueItemsTable(d),
    ...(d.gstNetThisMonth !== undefined ? [table('GST this month', row('Net payable so far (before any input credit under review)', inr(d.gstNetThisMonth)))] : []),
    ...(d.inboxWaiting > 0 ? [`<p style="font:14px system-ui,sans-serif;margin-top:18px">${d.inboxWaiting} document${d.inboxWaiting === 1 ? '' : 's'} waiting in the AI Inbox.</p>`] : []),
  ];
  return parts.join('\n');
}

/** Items to deliver: a row per order line with its due date and the customer's PO, late ones marked. */
function dueItemsTable(d: DailyDigest): string {
  const head = `Items due — ${d.orders.overdueLines} late, ${d.orders.dueThisWeek} due in the next 7 days`;
  const h3 = `<h3 style="margin:18px 0 6px;font:600 15px system-ui,sans-serif">${head}</h3>`;
  if (d.orders.lines.length === 0) return `${h3}<p style="font:14px system-ui,sans-serif;margin:0">Nothing late or due this week.</p>`;
  const cell = 'padding:4px 10px;border-bottom:1px solid #e0e0e0;white-space:nowrap';
  const th = `${cell};text-align:left;font-weight:600;background:#f5f5f5`;
  const shown = d.orders.lines.slice(0, MAIL_ITEMS);
  const body = shown
    .map((o) => {
      const late = o.overdue ? ';color:#b3261e;font-weight:600' : '';
      return `<tr><td style="${cell}${late}">${dmy(o.dueDate)}${o.overdue ? ` (${o.daysLate}d late)` : ''}</td><td style="${cell}">${esc(o.custPo || '—')}</td><td style="${cell}">${esc(o.party)}</td><td style="${cell}">${esc(o.item)}</td><td style="${cell};text-align:right">${esc(o.pending)}</td><td style="${cell}">${esc(o.number)}</td></tr>`;
    })
    .join('');
  const more = d.orders.lines.length > shown.length ? `<p style="font:13px system-ui,sans-serif">…and ${d.orders.lines.length - shown.length} more (all of them are in the sheet).</p>` : '';
  return `${h3}<table style="border-collapse:collapse;font:14px system-ui,sans-serif"><tr><th style="${th}">Due</th><th style="${th}">Cust PO</th><th style="${th}">Customer</th><th style="${th}">Item</th><th style="${th}">Pending</th><th style="${th}">Order</th></tr>${body}</table>${more}`;
}

/** The due items as sheet rows: report date, due date, cust PO, customer, item, pending, order, status. */
export function dueItemRows(d: DailyDigest): string[][] {
  return d.orders.lines.map((o) => [d.asOn, o.dueDate, o.custPo, o.party, o.item, o.pending, o.number, o.overdue ? `${o.daysLate} days late` : 'due']);
}

/** One row per figure, for the Google Sheet: date, what, amount (rupees as a plain number) or count. */
export function digestSheetRows(d: DailyDigest): (string | number)[][] {
  const rupees = (m: Money) => Number(m) / 100;
  return [
    [d.asOn, 'Sales yesterday', rupees(d.day.sales)],
    [d.asOn, 'Purchases yesterday', rupees(d.day.purchases)],
    [d.asOn, 'Received yesterday', rupees(d.day.receipts)],
    [d.asOn, 'Paid yesterday', rupees(d.day.payments)],
    [d.asOn, 'Receivables outstanding', rupees(d.receivables.total)],
    [d.asOn, 'Receivables overdue', rupees(d.receivables.overdue)],
    [d.asOn, 'Payables due in 7 days', rupees(d.payablesDue.total)],
    [d.asOn, 'Order lines overdue', d.orders.overdueLines],
    [d.asOn, 'Order lines due this week', d.orders.dueThisWeek],
    ...(d.gstNetThisMonth !== undefined ? [[d.asOn, 'GST net this month', rupees(d.gstNetThisMonth)]] : []),
    [d.asOn, 'AI Inbox waiting', d.inboxWaiting],
  ];
}

