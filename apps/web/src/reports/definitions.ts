import type { ColumnFilter, ColumnSpec, DayBookRow, StatementRow } from '@minimalerp/domain';
import { formatAmount, formatBalance, formatDate } from '../vouchers/format';

/**
 * A report is only a definition: its columns. Sorting, filtering and the keys that drive them come from the grid and the
 * column specs, so a report added later is sortable and filterable without writing any of that.
 */

const money = (m: bigint): string => (m === 0n ? '' : formatAmount(m));

export interface TypeChoice {
  readonly value: string;
  readonly label: string;
}

export function dayBookColumns(types: readonly TypeChoice[]): ColumnSpec<DayBookRow>[] {
  return [
    { id: 'date', label: 'Date', type: 'date', value: (r) => r.date, text: (r) => formatDate(r.date) },
    { id: 'number', label: 'Voucher no.', type: 'text', value: (r) => r.number },
    { id: 'type', label: 'Type', type: 'choice', value: (r) => r.voucherType, choices: types },
    {
      id: 'particulars',
      label: 'Particulars',
      type: 'text',
      value: (r) => r.particulars,
      text: (r) => (r.status === 'cancelled' ? `${r.particulars} — CANCELLED` : r.particulars),
    },
    { id: 'narration', label: 'Narration', type: 'text', value: (r) => r.narration },
    { id: 'debit', label: 'Debit', type: 'money', align: 'right', value: (r) => r.debit, text: (r) => money(r.debit) },
    { id: 'credit', label: 'Credit', type: 'money', align: 'right', value: (r) => r.credit, text: (r) => money(r.credit) },
  ];
}

export function ledgerColumns(types: readonly TypeChoice[]): ColumnSpec<StatementRow>[] {
  return [
    { id: 'date', label: 'Date', type: 'date', value: (r) => r.date, text: (r) => formatDate(r.date) },
    { id: 'particulars', label: 'Particulars', type: 'text', value: (r) => r.particulars },
    { id: 'type', label: 'Type', type: 'choice', value: (r) => r.voucherType, choices: types },
    { id: 'number', label: 'Voucher no.', type: 'text', value: (r) => r.number },
    { id: 'debit', label: 'Debit', type: 'money', align: 'right', value: (r) => r.debit, text: (r) => money(r.debit) },
    { id: 'credit', label: 'Credit', type: 'money', align: 'right', value: (r) => r.credit, text: (r) => money(r.credit) },
    { id: 'balance', label: 'Balance', type: 'money', align: 'right', value: (r) => r.balance, text: (r) => formatBalance(r.balance) },
  ];
}

/** "Type: Payment, Receipt", "Amount ≥ 10,000.00" — what a filter chip says. */
export function describeFilter<R>(col: ColumnSpec<R>, filter: ColumnFilter): string {
  const show = (v: unknown): string => (typeof v === 'bigint' ? formatAmount(v) : col.type === 'date' && typeof v === 'string' ? formatDate(v) : String(v));
  switch (filter.kind) {
    case 'contains':
      return `${col.label} contains “${filter.text}”`;
    case 'range':
      if (filter.min !== undefined && filter.min !== null && filter.max !== undefined && filter.max !== null) return `${col.label} ${show(filter.min)} – ${show(filter.max)}`;
      if (filter.min !== undefined && filter.min !== null) return `${col.label} ≥ ${show(filter.min)}`;
      return `${col.label} ≤ ${show(filter.max)}`;
    case 'in':
      return `${col.label}: ${filter.values.join(', ')}`;
    case 'notIn':
      return `${col.label}: not ${filter.values.join(', ')}`;
  }
}
