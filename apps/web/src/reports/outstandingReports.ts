import {
  BUCKETS,
  BUCKET_LABELS,
  type BillRow,
  type Bucket,
  type ColumnSpec,
  type JournalLine,
  type LedgerId,
  type LocalDate,
  type Masters,
  type Money,
  type OutstandingSide,
  type PartyOutstanding,
  type Voucher,
  money,
  outstandingBills,
  outstandingByParty,
} from '@minimalerp/domain';
import { formatAmount, formatDate } from '../vouchers/format';

/**
 * Outstanding receivables and payables on the one grid: a row per party (its open bills, the ageing buckets counted from each bill's DUE date,
 * advances, and what was never put in a bill — reconciled to the ledger), and, one level down, a row per bill. Pure functions of the vouchers
 * and the journal: nothing is stored, so a receipt, a cancellation or a back-dated entry is simply what the next read shows.
 */

export interface PartyRow extends PartyOutstanding {
  readonly rowType: 'party';
  readonly key: string;
}

export interface OutstandingBillRow extends BillRow {
  readonly rowType: 'bill';
  readonly key: string;
}

export interface OutstandingInputs {
  readonly vouchers: readonly Voucher[];
  readonly lines: Iterable<JournalLine>;
  readonly masters: Masters;
  readonly side: OutstandingSide;
  readonly asOn: LocalDate;
}

export function partyRows({ vouchers, lines, masters, side, asOn }: OutstandingInputs): PartyRow[] {
  return outstandingByParty({ vouchers, lines, masters, side, asOn }).map((p) => ({ ...p, rowType: 'party' as const, key: p.ledgerId }));
}

export function billRows({ vouchers, masters, side, asOn, ledgerId }: Omit<OutstandingInputs, 'lines'> & { ledgerId?: LedgerId | undefined }): OutstandingBillRow[] {
  return outstandingBills({ vouchers, masters, side, asOn, ledgerId }).map((b) => ({ ...b, rowType: 'bill' as const, key: `${b.ledgerId}|${b.ref}` }));
}

const money0 = (m: bigint): string => (m === 0n ? '' : formatAmount(m));

export function partyColumns(side: OutstandingSide): ColumnSpec<PartyRow>[] {
  const bucket = (b: Bucket): ColumnSpec<PartyRow> => ({ id: b, label: BUCKET_LABELS[b], type: 'money', align: 'right', value: (r) => r.buckets[b], text: (r) => money0(r.buckets[b]) });
  return [
    { id: 'name', label: side === 'receivable' ? 'Customer' : 'Supplier', type: 'text', value: (r) => r.name, text: (r) => `${r.name}  ▸` },
    { id: 'bills', label: 'Bills', type: 'number', align: 'right', value: (r) => r.bills },
    { id: 'pending', label: 'Pending', type: 'money', align: 'right', value: (r) => r.pending, text: (r) => money0(r.pending) },
    ...BUCKETS.map(bucket),
    { id: 'advances', label: 'Advance / on account', type: 'money', align: 'right', value: (r) => r.advances, text: (r) => money0(r.advances) },
    { id: 'notInBills', label: 'Not in bills', type: 'money', align: 'right', value: (r) => r.notInBills, text: (r) => money0(r.notInBills) },
    { id: 'balance', label: 'Balance', type: 'money', align: 'right', value: (r) => r.balance, text: (r) => formatAmount(r.balance) },
    { id: 'oldest', label: 'Oldest overdue (days)', type: 'number', align: 'right', value: (r) => r.oldest, text: (r) => (r.oldest === 0 ? '' : String(r.oldest)) },
  ];
}

export function billColumns(): ColumnSpec<OutstandingBillRow>[] {
  return [
    { id: 'ref', label: 'Bill / ref', type: 'text', value: (r) => r.ref },
    { id: 'party', label: 'Party', type: 'text', value: (r) => r.party },
    { id: 'billDate', label: 'Bill date', type: 'date', value: (r) => r.billDate, text: (r) => formatDate(r.billDate) },
    { id: 'dueDate', label: 'Due', type: 'date', value: (r) => r.dueDate, text: (r) => formatDate(r.dueDate) },
    { id: 'pending', label: 'Pending', type: 'money', align: 'right', value: (r) => r.pending, text: (r) => formatAmount(r.pending) },
    { id: 'daysOverdue', label: 'Days overdue', type: 'number', align: 'right', value: (r) => r.daysOverdue, text: (r) => (r.daysOverdue === 0 ? '' : String(r.daysOverdue)) },
    {
      id: 'bucket',
      label: 'Ageing',
      type: 'choice',
      value: (r) => BUCKET_LABELS[r.bucket],
      choices: BUCKETS.map((b) => ({ value: BUCKET_LABELS[b], label: BUCKET_LABELS[b] })),
    },
  ];
}

/** What the shown parties add up to. */
export function partyTotals(rows: readonly PartyRow[]): { pending: Money; balance: Money; overdue: Money; bills: number } {
  let pending = 0n;
  let balance = 0n;
  let overdue = 0n;
  let bills = 0;
  for (const r of rows) {
    pending += r.pending;
    balance += r.balance;
    bills += r.bills;
    overdue += r.pending - r.buckets.notDue;
  }
  return { pending: money(pending), balance: money(balance), overdue: money(overdue), bills };
}

/** The row's look: a party or bill with something past due is bold. */
export const outstandingRowClass = (r: PartyRow | OutstandingBillRow): string => (r.rowType === 'bill' ? (r.daysOverdue > 0 ? 'open-line' : '') : r.oldest > 0 ? 'open-line' : '');
