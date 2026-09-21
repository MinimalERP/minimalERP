import { type ColumnSpec, type DateRange, type GroupId, type GroupRow, type JournalLine, type Masters, groupRows } from '@minimalerp/domain';
import { formatAmount, formatBalance } from '../vouchers/format';

/**
 * The Trial Balance and the Cash / Bank Book, as definitions on the one grid: the children of a group of the chart of accounts — sub-groups (each
 * rolled up) and ledgers — with Opening, Debit, Credit and Closing for the period. Enter opens a group (the same report, one level down) or a ledger
 * (its running statement). Pure functions of the journal: nothing here is stored.
 */

export interface TbRow extends GroupRow {
  readonly rowType: 'tb';
  /** Unique per row. */
  readonly key: string;
}

/** The groups a book is made of: the Cash Book is Cash-in-Hand; the Bank Book is Bank Accounts and Bank OD. */
export function bookGroupIds(masters: Masters, book: 'cash' | 'bank'): GroupId[] {
  const keys = book === 'cash' ? ['cash-in-hand'] : ['bank-accounts', 'bank-od'];
  return masters.groups.all.filter((g) => g.reservedKey !== undefined && keys.includes(g.reservedKey)).map((g) => g.id);
}

export interface TbInput {
  readonly masters: Masters;
  readonly lines: Iterable<JournalLine>;
  readonly range: DateRange;
  /** Whose children to list: a group (a level down), several (a book), or omitted (the primary groups). */
  readonly parentIds?: readonly GroupId[] | undefined;
  /** Show ledgers with nothing on them: a book lists every cash or bank ledger, used or not. */
  readonly includeEmpty?: boolean | undefined;
}

export function tbRows({ masters, lines, range, parentIds, includeEmpty }: TbInput): TbRow[] {
  return groupRows(masters, lines, range, { parentIds, includeEmpty }).map((r) => ({ ...r, rowType: 'tb' as const, key: `${r.kind}:${r.id}` }));
}

const money0 = (m: bigint): string => (m === 0n ? '' : formatAmount(m));

export function tbColumns(): ColumnSpec<TbRow>[] {
  return [
    { id: 'name', label: 'Particulars', type: 'text', value: (r) => r.name, text: (r) => (r.kind === 'group' ? `${r.name}  ▸` : r.name) },
    { id: 'kind', label: 'Type', type: 'choice', value: (r) => (r.kind === 'group' ? 'Group' : 'Ledger'), choices: [{ value: 'Group', label: 'Group' }, { value: 'Ledger', label: 'Ledger' }] },
    { id: 'opening', label: 'Opening', type: 'money', align: 'right', value: (r) => r.opening, text: (r) => formatBalance(r.opening) },
    { id: 'debit', label: 'Debit', type: 'money', align: 'right', value: (r) => r.debit, text: (r) => money0(r.debit) },
    { id: 'credit', label: 'Credit', type: 'money', align: 'right', value: (r) => r.credit, text: (r) => money0(r.credit) },
    { id: 'closing', label: 'Closing', type: 'money', align: 'right', value: (r) => r.closing, text: (r) => formatBalance(r.closing) },
  ];
}
