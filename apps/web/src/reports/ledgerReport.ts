import { type BillRow, type LedgerId, type LocalDate, type Masters, type OutstandingSide, type Voucher, outstandingBills } from '@minimalerp/domain';
import { formatAmount, formatDate } from '../vouchers/format';

/**
 * What a printed ledger carries beyond its rows: the party it is for and — for a customer or supplier — the bills still open on it. Pure
 * functions of the masters and the vouchers.
 */

/** The side a party ledger's bills are on — receivable under Sundry Debtors, payable under Sundry Creditors, none for any other ledger. */
export function billSideOf(masters: Masters, ledgerId: LedgerId): OutstandingSide | undefined {
  const ledger = masters.ledger(ledgerId);
  if (!ledger) return undefined;
  if (masters.groups.isWithinReserved(ledger.groupId, 'sundry-debtors')) return 'receivable';
  if (masters.groups.isWithinReserved(ledger.groupId, 'sundry-creditors')) return 'payable';
  return undefined;
}

/** Who a ledger is, as a statement's party box prints it: the name, then address, GSTIN, phone / email and credit terms (what it has). */
export function partyBlock(masters: Masters, ledgerId: LedgerId): { name: string; lines: string[] } {
  const ledger = masters.ledger(ledgerId);
  if (!ledger) return { name: '', lines: [] };
  const party = ledger.partyId ? masters.party(ledger.partyId) : undefined;
  const group = masters.groups.get(ledger.groupId)?.name;
  const contact = [party?.phone, party?.email].filter((s): s is string => !!s && s.trim() !== '').join(' · ');
  const lines = [
    [party?.address, party?.pincode].filter((s): s is string => !!s && s.trim() !== '').join(' – '),
    party?.gstin ? `GSTIN: ${party.gstin}` : '',
    contact,
    party?.creditDays ? `Credit: ${party.creditDays} days` : '',
    party ? '' : (group ?? ''),
  ];
  return { name: party?.name ?? ledger.name, lines: lines.filter((l) => l !== '') };
}

/** The open bills of a party ledger as on a date, oldest due first — none for a ledger that is not a party's. */
export function ledgerBills(vouchers: readonly Voucher[], masters: Masters, ledgerId: LedgerId, asOn: LocalDate): BillRow[] {
  const side = billSideOf(masters, ledgerId);
  return side ? outstandingBills({ vouchers, masters, side, asOn, ledgerId }) : [];
}

/** How a bill stands: nothing received yet, or part of it. */
export const billStatus = (b: BillRow): 'Unpaid' | 'Part paid' => (b.pending < b.amount ? 'Part paid' : 'Unpaid');

/** The bills table's columns: a customer's bills were received against, a supplier's paid. */
export const billColumnsFor = (side: OutstandingSide) => [
  { label: 'Bill' },
  { label: 'Date' },
  { label: 'Due on' },
  { label: 'Bill amount', align: 'right' as const },
  { label: side === 'receivable' ? 'Received' : 'Paid', align: 'right' as const },
  { label: 'Pending', align: 'right' as const },
  { label: 'Overdue', align: 'right' as const },
  { label: 'Status' },
];

/** One bill as its row reads, on screen and on paper (the columns above). */
export function billCells(b: BillRow): string[] {
  return [
    b.ref,
    formatDate(b.billDate),
    formatDate(b.dueDate),
    formatAmount(b.amount),
    formatAmount(b.amount - b.pending),
    formatAmount(b.pending),
    b.daysOverdue > 0 ? `${b.daysOverdue} days` : '',
    billStatus(b),
  ];
}
