import { type Masters, type OpenBill, type Voucher, formatMoney, money, openBills } from '@minimalerp/domain';
import { addDays, normalizeAmount } from './format';
import type { AllocForm, Side } from './model';

/** The side a party ledger normally carries: a supplier (liability) is credited when a bill is raised, a customer (asset) debited. */
export function naturalSide(masters: Masters, ledgerId: string): Side {
  return masters.natureOfLedger(ledgerId as never) === 'liability' ? 'credit' : 'debit';
}

/** Days of credit the party behind this ledger allows (0 if none is recorded). */
export function creditDaysOf(masters: Masters, ledgerId: string): number {
  const partyId = masters.ledger(ledgerId as never)?.partyId;
  return (partyId ? masters.party(partyId)?.creditDays : undefined) ?? 0;
}

/** The party's bills this line could settle: raised on the opposite side to the line, oldest due first. */
export function settleableBills(vouchers: readonly Voucher[], masters: Masters, ledgerId: string, side: Side, ignoreVoucher?: string): OpenBill[] {
  return openBills(vouchers, masters, ledgerId as never, ignoreVoucher as never)
    .filter((b) => b.side !== side)
    .sort((a, b) => (a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : (a.dueDate ?? '9999') > (b.dueDate ?? '9999') ? 1 : 0);
}

/** An amount as paise; 0 if it is not an amount. */
const toMinor = (text: string): bigint => {
  const n = normalizeAmount(text);
  if (n === undefined) return 0n;
  const [w = '0', f = '00'] = n.split('.');
  return BigInt(w) * 100n + BigInt(f);
};

/**
 * The breakdown a party line starts with: ONE BLANK ROW for the whole amount, of the type that fits — Against ref when the party has open bills this line could
 * settle, otherwise a New ref (a line on the party's normal side raises a bill, due after the party's credit days) or On account. No bill is chosen for the
 * person: the row starts at its type list, and for Against ref the reference is searched among the open bills.
 */
export function defaultAllocations(args: {
  masters: Masters;
  vouchers: readonly Voucher[];
  ledgerId: string;
  side: Side;
  /** The line's amount, as typed. */
  amount: string;
  date: string;
  ignoreVoucher?: string | undefined;
}): AllocForm[] {
  const { masters, vouchers, ledgerId, side, date } = args;
  const amount = toMinor(args.amount);
  if (amount <= 0n) return [];
  const settles = settleableBills(vouchers, masters, ledgerId, side, args.ignoreVoucher).length > 0;
  const raising = side === naturalSide(masters, ledgerId);
  const kind: AllocForm['kind'] = settles ? 'against' : raising ? 'new' : 'onAccount';
  return [{ kind, ref: '', dueDate: kind === 'new' ? addDays(date, creditDaysOf(masters, ledgerId)) : '', amount: formatMoney(money(amount)) }];
}

/** How far the parts are from the line: positive = still to allocate, negative = over-allocated. */
export function unallocated(lineAmount: string, parts: readonly AllocForm[]): bigint {
  const line = /^[\d,.\s]+$/.test(lineAmount) ? toMinor(lineAmount) : 0n;
  const sum = parts.reduce((s, p) => s + (/^[\d,.\s]+$/.test(p.amount) ? toMinor(p.amount) : 0n), 0n);
  return line - sum;
}

/**
 * The open bills a row of the bill-wise panel could name: everything the line could settle, leaving out the bills ANOTHER row of the same line already
 * names (one bill is settled by one row; a second amount against it would just be a bigger first one). `exceptPart` is the row being edited.
 */
export function billsToOffer(args: {
  vouchers: readonly Voucher[];
  masters: Masters;
  ledgerId: string;
  side: Side;
  allocations: readonly AllocForm[];
  exceptPart?: number | undefined;
  ignoreVoucher?: string | undefined;
}): OpenBill[] {
  const used = new Set(args.allocations.filter((a, k) => k !== args.exceptPart && a.kind === 'against').map((a) => a.ref.trim()));
  return settleableBills(args.vouchers, args.masters, args.ledgerId, args.side, args.ignoreVoucher).filter((b) => !used.has(b.ref));
}

/**
 * What a row settling `bill` should start with: what is still to allocate on the line (counting the row's own amount as free), never more than the bill
 * has pending. A bill may be settled in part: the rest stays open, and a later receipt settles it.
 */
export function amountToSettle(bill: OpenBill, lineAmount: string, allocations: readonly AllocForm[], part?: number): string {
  const others = allocations.reduce((sum, a, k) => (k === part ? sum : sum + (/^[\d,.\s]+$/.test(a.amount) ? toMinor(a.amount) : 0n)), 0n);
  const room = (/^[\d,.\s]+$/.test(lineAmount) ? toMinor(lineAmount) : 0n) - others;
  const take = room > 0n && room < bill.pending ? room : bill.pending;
  return formatMoney(money(take));
}
