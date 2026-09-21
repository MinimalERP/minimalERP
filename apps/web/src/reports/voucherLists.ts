import { type BaseKind, type ColumnSpec, type LocalDate, type Masters, type Money, type OrderBook, type Voucher, customerLedgerOf, dayBookRows, daysOverdue, lineValue, money, openBills, vendorLedgerOf } from '@minimalerp/domain';
import type { JournalLine } from '@minimalerp/domain';
import { formatAmount, formatDate } from '../vouchers/format';

/**
 * The list behind each voucher type (Transactions › Sales › "Sales Vouchers"): one row per voucher, on the one grid, so it sorts and filters like
 * every report. A pure function of the books — the Day Book's rows for that kind, enriched with what the kind is about (a sales document's
 * customer and Cust PO, an order's lines and whether it is still open, a stock journal's items).
 */

export interface VoucherListRow {
  /** The voucher (also the row's identity: one row per voucher). */
  readonly voucherId: string;
  readonly voucherTypeId: string;
  readonly date: LocalDate;
  readonly number: string;
  readonly typeName: string;
  /** Customer / ledgers / items — whatever the voucher is about. */
  readonly particulars: string;
  /** The customer's PO number (sales documents); the supplier's own reference on a purchase order. */
  readonly reference: string;
  /** Purchase invoices: the supplier's invoice number — the name of the bill. */
  readonly billNo: string;
  readonly narration: string;
  /** Debit total of the journal; a sales order's value (it has no journal). */
  readonly amount: Money;
  readonly cancelled: boolean;
  /** Invoices: what the customer still owes on it, and when it falls due. */
  readonly pending: Money;
  readonly due: string;
  /**
   * One overall word per voucher (the line-by-line story is in the reports): a sales order is Open, Partially filled or Closed; an invoice is
   * Open (not yet paid), Paid or Overdue; anything cancelled is Cancelled. Blank for kinds with no lifecycle.
   */
  readonly status: string;
}

export interface VoucherListInput {
  readonly vouchers: readonly Voucher[];
  readonly lines: readonly JournalLine[];
  readonly masters: Masters;
  readonly orders: OrderBook;
  readonly kind: BaseKind;
  /** Today, for what is overdue. */
  readonly asOf?: LocalDate | undefined;
  readonly range?: { readonly from?: LocalDate | undefined; readonly to?: LocalDate | undefined } | undefined;
}

/** The plural-ish name a list goes by: "Sales Vouchers", "Sales Orders", "Payment Vouchers". */
export const listTitle = (typeName: string): string => (/order$/i.test(typeName) ? `${typeName}s` : `${typeName} Vouchers`);

/** Oldest first (the Day Book's order); the screen turns it newest first. */
export function voucherListRows({ vouchers, lines, masters, orders, kind, range, asOf }: VoucherListInput): VoucherListRow[] {
  const byId = new Map(vouchers.map((v) => [v.id as string, v]));
  const today = asOf ?? (new Date().toISOString().slice(0, 10) as LocalDate);
  // What each party still owes (or is owed), by bill: a sales invoice's bill is named by its own number, a purchase invoice's by the supplier's
  // (paid = no longer open).
  const isInvoice = kind === 'sales' || kind === 'purchase';
  const isOrder = kind === 'salesOrder' || kind === 'purchaseOrder';
  const owed = new Map<string, Map<string, bigint>>();
  if (isInvoice) {
    for (const v of vouchers) {
      const partyId = (v.content as unknown as { partyId?: string }).partyId;
      if (v.status !== 'posted' || partyId === undefined || owed.has(partyId)) continue;
      if (masters.voucherType(v.voucherTypeId)?.baseKind !== kind) continue;
      const ledger = kind === 'sales' ? customerLedgerOf(partyId as never) : vendorLedgerOf(partyId as never);
      owed.set(partyId, new Map(openBills(vouchers, masters, ledger).map((b) => [b.ref, b.pending])));
    }
  }
  return dayBookRows({ vouchers, lines, masters, range: range ?? {} })
    .filter((r) => r.baseKind === kind)
    .map((r): VoucherListRow => {
      const v = byId.get(r.voucherId) as Voucher;
      const c = v.content as unknown as { reference?: string; billNo?: string; partyId?: string; dueDate?: string; lines?: { qty: string; rate: string }[] };
      const cancelled = r.status === 'cancelled';
      const state = isOrder && !cancelled ? orders.state(v.id) : undefined;
      const value = isOrder ? money((c.lines ?? []).reduce((sum, l) => sum + lineValue(l), 0n)) : r.debit;
      // an invoice: what is still owed on its bill, and whether it has fallen due
      const billRef = kind === 'purchase' ? (c.billNo ?? '').trim() : v.number;
      const pending = isInvoice && !cancelled ? money(owed.get(c.partyId ?? '')?.get(billRef) ?? 0n) : money(0n);
      const due = isInvoice ? (c.dueDate ?? '') : '';
      const status = cancelled
        ? 'Cancelled'
        : state
          ? state.status === 'closed'
            ? 'Closed'
            : state.lines.some((l) => l.delivered > 0n)
              ? 'Partially filled'
              : 'Open'
          : isInvoice
            ? pending === 0n
              ? 'Paid'
              : due !== '' && daysOverdue(due as LocalDate, today) > 0
                ? 'Overdue'
                : 'Open'
            : '';
      return {
        voucherId: r.voucherId,
        voucherTypeId: r.voucherTypeId,
        date: r.date,
        number: r.number,
        typeName: r.voucherType,
        particulars: r.particulars,
        reference: c.reference ?? '',
        billNo: kind === 'purchase' ? (c.billNo ?? '') : '',
        narration: r.narration,
        amount: cancelled ? money(0n) : value,
        cancelled,
        pending,
        due,
        status,
      };
    });
}

const money0 = (m: bigint): string => (m === 0n ? '' : formatAmount(m));

export function voucherListColumns(kind: BaseKind): ColumnSpec<VoucherListRow>[] {
  const date: ColumnSpec<VoucherListRow> = { id: 'date', label: 'Date', type: 'date', value: (r) => r.date, text: (r) => formatDate(r.date) };
  const number: ColumnSpec<VoucherListRow> = { id: 'number', label: 'Voucher no.', type: 'text', value: (r) => r.number };
  const particulars = (label: string): ColumnSpec<VoucherListRow> => ({
    id: 'particulars',
    label,
    type: 'text',
    value: (r) => r.particulars,
    text: (r) => (r.cancelled ? `${r.particulars} — CANCELLED` : r.particulars),
  });
  const narration: ColumnSpec<VoucherListRow> = { id: 'narration', label: 'Narration', type: 'text', value: (r) => r.narration };
  const reference: ColumnSpec<VoucherListRow> = { id: 'reference', label: kind === 'purchaseOrder' ? 'Supplier ref' : 'Cust PO / ref', type: 'text', value: (r) => r.reference };
  const billNo: ColumnSpec<VoucherListRow> = { id: 'billNo', label: 'Supplier inv no.', type: 'text', value: (r) => r.billNo };
  const amount = (label: string): ColumnSpec<VoucherListRow> => ({ id: 'amount', label, type: 'money', align: 'right', value: (r) => r.amount, text: (r) => money0(r.amount) });
  const choice = (values: string[]) => values.map((value) => ({ value, label: value }));

  const statusOf = (values: string[]): ColumnSpec<VoucherListRow> => ({ id: 'status', label: 'Status', type: 'choice', value: (r) => r.status, choices: choice(values) });
  if (kind === 'sales') {
    return [
      date,
      number,
      particulars('Customer'),
      reference,
      amount('Amount'),
      { id: 'pending', label: 'Pending', type: 'money', align: 'right', value: (r) => r.pending, text: (r) => money0(r.pending) },
      { id: 'due', label: 'Due', type: 'date', value: (r) => (r.due === '' ? null : r.due), text: (r) => (r.due === '' ? '' : formatDate(r.due)) },
      statusOf(['Open', 'Paid', 'Overdue', 'Cancelled']),
    ];
  }
  if (kind === 'purchase') {
    return [
      date,
      number,
      particulars('Supplier'),
      billNo,
      amount('Amount'),
      { id: 'pending', label: 'Pending', type: 'money', align: 'right', value: (r) => r.pending, text: (r) => money0(r.pending) },
      { id: 'due', label: 'Due', type: 'date', value: (r) => (r.due === '' ? null : r.due), text: (r) => (r.due === '' ? '' : formatDate(r.due)) },
      statusOf(['Open', 'Paid', 'Overdue', 'Cancelled']),
    ];
  }
  if (kind === 'salesOrder') return [date, number, particulars('Customer'), reference, amount('Order value'), statusOf(['Open', 'Partially filled', 'Closed', 'Cancelled'])];
  if (kind === 'purchaseOrder') return [date, number, particulars('Supplier'), reference, amount('Order value'), statusOf(['Open', 'Partially filled', 'Closed', 'Cancelled'])];
  if (kind === 'stockJournal') return [date, number, particulars('Items'), narration];
  return [date, number, particulars('Particulars'), narration, amount('Amount')];
}

/** The row's look: a cancelled voucher is struck out; an order that still has something to deliver is bold (as in the register). */
export const voucherRowClass = (r: VoucherListRow): string =>
  r.cancelled ? 'cancelled' : r.status === 'Open' || r.status === 'Partially filled' || r.status === 'Overdue' ? 'open-line' : r.status === 'Closed' || r.status === 'Paid' ? 'closed-order' : '';

/** What the shown rows come to, for the footer. */
export function listTotals(rows: readonly VoucherListRow[]): { count: number; amount: Money; cancelled: number } {
  let amount = 0n;
  let cancelled = 0;
  for (const r of rows) {
    if (r.cancelled) cancelled++;
    else amount += r.amount;
  }
  return { count: rows.length, amount: money(amount), cancelled };
}
