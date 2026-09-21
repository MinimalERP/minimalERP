import { type Issue, IssueCode, issue } from '../errors';
import type { LedgerId, VoucherId } from '../ids';
import type { Masters } from '../masters/masters';
import { canonicalId, gstinProblem, GST_STATE_CODES, stateOfGstin } from '../masters/rules';
import { type Money, formatMoney, money } from '../money';
import type { LocalDate } from '../dates';
import type { BillAllocation, PartyDetails } from './drafts';
import { customerLedgerOf, vendorLedgerOf } from './kinds/documents';
import { gstOfContent, grandTotal } from './kinds/gstDoc';
import type { Voucher } from './voucher';

/**
 * Bill-wise details (which invoice/bill a payment settles, when a new one falls due) and the party-details snapshot. Both are
 * CAPTURED on vouchers now so the outstanding and ageing reports have their data when they arrive; the rules here keep what is
 * captured internally consistent.
 */

interface AllocatableLine {
  readonly ledgerId: LedgerId;
  readonly amount: bigint;
  readonly allocations?: readonly BillAllocation[] | undefined;
}

/** A ledger can carry bill-wise details only if it is a party ledger: Sundry Debtors / Sundry Creditors, or anything under them. */
export const isPartyLedger = (masters: Masters, ledgerId: LedgerId): boolean => {
  const ledger = masters.ledger(ledgerId);
  return ledger !== undefined && masters.groups.isWithinReserved(ledger.groupId, 'sundry-debtors', 'sundry-creditors');
};

/** The parts of each line's bill-wise breakdown must be positive, named where a name matters, and add up to the line. */
export function allocationProblems(lines: readonly AllocatableLine[], path: string, masters: Masters, options: { readonly allowTds?: boolean } = {}): Issue[] {
  const problems: Issue[] = [];
  lines.forEach((line, i) => {
    const parts = line.allocations;
    if (parts === undefined || parts.length === 0) return;
    const here = `${path}.${i}.allocations`;
    if (!isPartyLedger(masters, line.ledgerId)) {
      problems.push(issue(IssueCode.AllocationInvalid, 'Bill-wise details are only for customer and supplier ledgers', here));
      return;
    }
    let total = 0n;
    parts.forEach((p, j) => {
      total += p.amount;
      if (p.amount <= 0n) problems.push(issue(IssueCode.AllocationInvalid, 'Each bill amount must be above zero', `${here}.${j}.amount`));
      if ((p.kind === 'new' || p.kind === 'against') && (p.ref ?? '').trim() === '') {
        problems.push(
          issue(IssueCode.AllocationInvalid, p.kind === 'new' ? 'Give the new bill a reference' : 'Choose the bill this settles', `${here}.${j}.ref`),
        );
      }
      if (p.tds !== undefined) {
        const at = `${here}.${j}.tds`;
        if (options.allowTds !== true) problems.push(issue(IssueCode.TdsInvalid, 'TDS is deducted on a receipt', at));
        else if (p.kind !== 'against') problems.push(issue(IssueCode.TdsInvalid, 'TDS is deducted against a bill: choose the bill this settles', at));
        else if (p.tds <= 0n) problems.push(issue(IssueCode.TdsInvalid, 'TDS must be above zero (leave it empty when nothing was deducted)', at));
        else if (p.tds > p.amount) problems.push(issue(IssueCode.TdsInvalid, `TDS ${formatMoney(money(p.tds))} cannot exceed the ${formatMoney(money(p.amount))} of the bill it is deducted from`, at));
      }
      if (p.dueDate !== undefined && p.kind !== 'new') {
        problems.push(issue(IssueCode.AllocationInvalid, 'Only a new bill has a due date', `${here}.${j}.dueDate`));
      }
    });
    if (total !== line.amount) {
      problems.push(
        issue(IssueCode.AllocationInvalid, `The bills add up to ${formatMoney(money(total))} but this line is ${formatMoney(money(line.amount))}`, here),
      );
    }
  });
  return problems;
}

const validState = (code: string | undefined): boolean => code === undefined || code === '' || GST_STATE_CODES.has(code);

/** GSTIN, states and the party link of a voucher's party-details snapshot. */
export function partyDetailsProblems(details: PartyDetails | undefined, masters: Masters): Issue[] {
  if (details === undefined) return [];
  const problems: Issue[] = [];
  const bad = (message: string, path: string, code: string = IssueCode.PartyDetailsInvalid) => problems.push(issue(code, message, `partyDetails.${path}`));

  const gstin = canonicalId(details.gstin ?? '');
  if (gstin !== '') {
    const p = gstinProblem(gstin);
    if (p) bad(p, 'gstin', IssueCode.InvalidGstin);
    else if (details.gstRegistration === 'unregistered') bad('An unregistered party has no GSTIN', 'gstin');
    else if (details.billTo?.stateCode && details.billTo.stateCode !== stateOfGstin(gstin)) {
      bad(`The billing state ${details.billTo.stateCode} does not match the GSTIN (${stateOfGstin(gstin)})`, 'billTo.stateCode', IssueCode.InvalidGstin);
    }
  }
  if (!validState(details.billTo?.stateCode)) bad('That is not a GST state code', 'billTo.stateCode');
  if (!validState(details.shipTo?.stateCode)) bad('That is not a GST state code', 'shipTo.stateCode');
  if (!validState(details.placeOfSupply)) bad('That is not a GST state code', 'placeOfSupply');
  if (details.partyId !== undefined && masters.party(details.partyId as never) === undefined) bad('That party does not exist', 'partyId');
  return problems;
}

// ---- reading bill-wise data back out of posted vouchers -------------------------------------------------------------

/** The TDS deducted across the bills of a receipt's lines. */
export const tdsOfLines = (lines: readonly { readonly allocations?: readonly BillAllocation[] | undefined }[]): bigint =>
  lines.reduce((t, l) => t + (l.allocations ?? []).reduce((s, a) => s + (a.tds ?? 0n), 0n), 0n);

export interface AllocatedLine {
  readonly voucherId: VoucherId;
  readonly ledgerId: LedgerId;
  readonly side: 'debit' | 'credit';
  readonly allocations: readonly BillAllocation[];
}

/** The party lines of a voucher that carry bill-wise details, with the side each was posted on. */
export function allocatedLinesOf(voucher: Voucher, masters: Masters): AllocatedLine[] {
  const c = voucher.content as unknown as {
    accountLedgerId?: string;
    lines?: { ledgerId: LedgerId; allocations?: BillAllocation[] }[];
    entries?: { ledgerId: LedgerId; side: 'debit' | 'credit'; allocations?: BillAllocation[] }[];
    ledgerId?: LedgerId;
    side?: 'debit' | 'credit';
    allocations?: BillAllocation[];
  };
  const out: AllocatedLine[] = [];
  const push = (ledgerId: LedgerId, side: 'debit' | 'credit', allocations: BillAllocation[] | undefined) => {
    if (allocations && allocations.length > 0) out.push({ voucherId: voucher.id, ledgerId, side, allocations });
  };
  const kind = masters.voucherType(voucher.voucherTypeId)?.baseKind;
  if (kind === 'sales') {
    // The bill's reference is the invoice's own number, which is only known once it is posted — so it is derived here (and by the
    // database mirror), never stored in the draft.
    const s = voucher.content as unknown as { partyId?: string; dueDate?: string; lines?: { qty: string; rate: string }[] };
    if (typeof s.partyId === 'string' && Array.isArray(s.lines)) {
      const due = typeof s.dueDate === 'string' ? (s.dueDate as LocalDate) : undefined;
      push(customerLedgerOf(s.partyId as never), 'debit', [{ kind: 'new', ref: voucher.number, ...(due ? { dueDate: due } : {}), amount: grandTotal(s.lines, gstOfContent(voucher.content)) }]);
    }
    return out;
  }
  if (kind === 'purchase') {
    // The supplier's bill is named by THEIR invoice number, which is on the draft: a credit bill on the supplier's ledger.
    const p = voucher.content as unknown as { partyId?: string; dueDate?: string; billNo?: string; lines?: { qty: string; rate: string }[] };
    if (typeof p.partyId === 'string' && typeof p.billNo === 'string' && Array.isArray(p.lines)) {
      const due = typeof p.dueDate === 'string' ? (p.dueDate as LocalDate) : undefined;
      push(vendorLedgerOf(p.partyId as never), 'credit', [{ kind: 'new', ref: p.billNo.trim(), ...(due ? { dueDate: due } : {}), amount: grandTotal(p.lines, gstOfContent(voucher.content)) }]);
    }
    return out;
  }
  if (c.entries) for (const e of c.entries) push(e.ledgerId, e.side, e.allocations);
  else if (c.lines && kind !== 'contra') for (const l of c.lines) push(l.ledgerId, kind === 'receipt' ? 'credit' : 'debit', l.allocations);
  else if (c.ledgerId && c.side) push(c.ledgerId, c.side, c.allocations);
  return out;
}

export interface OpenBill {
  readonly ref: string;
  readonly ledgerId: LedgerId;
  readonly dueDate: LocalDate | undefined;
  /** What is still to be settled, always positive. */
  readonly pending: Money;
  /** The side the bill was raised on: a debit bill is owed TO us (receivable), a credit bill is owed BY us (payable). */
  readonly side: 'debit' | 'credit';
  readonly voucherId: VoucherId;
}

/**
 * The bills of one party ledger that are not yet fully settled, oldest first. A "new" allocation raises a bill; an "against"
 * allocation on the opposite side settles part of it. Cancelled vouchers count for nothing.
 */
export function openBills(vouchers: readonly Voucher[], masters: Masters, ledgerId: LedgerId, ignoreVoucher?: VoucherId): OpenBill[] {
  const bills = new Map<string, { ref: string; dueDate: LocalDate | undefined; side: 'debit' | 'credit'; net: bigint; voucherId: VoucherId }>();
  const pass = (kinds: readonly string[]) => {
    for (const v of vouchers) {
      if (v.status !== 'posted' || v.id === ignoreVoucher) continue;
      for (const line of allocatedLinesOf(v, masters)) {
        if (line.ledgerId !== ledgerId) continue;
        for (const a of line.allocations) {
          const ref = (a.ref ?? '').trim();
          if (ref === '' || !kinds.includes(a.kind)) continue;
          const delta = line.side === 'debit' ? a.amount : -a.amount;
          const bill = bills.get(ref);
          if (a.kind === 'new') {
            if (bill) bill.net += delta;
            else bills.set(ref, { ref, dueDate: a.dueDate, side: line.side, net: delta, voucherId: v.id });
          } else if (bill) {
            bill.net += delta;
          }
        }
      }
    }
  };
  pass(['new']); // raise every bill first, so a settlement dated before its bill (back-dating) still finds it
  pass(['against']);
  return [...bills.values()]
    .map((b) => ({ ...b, pending: money(b.side === 'debit' ? b.net : -b.net) }))
    .filter((b) => b.pending > 0n)
    .map((b) => ({ ref: b.ref, ledgerId, dueDate: b.dueDate, pending: b.pending, side: b.side, voucherId: b.voucherId }));
}

/**
 * Is this supplier bill number already one of that supplier's bills? A bill is named by the number a new-bill allocation gives it, on any
 * posted voucher (an opening balance, a journal, a purchase invoice). `ignoring` is the voucher being altered, which may keep its own number.
 */
export function billRefTaken(vouchers: readonly Voucher[], masters: Masters, ledgerId: LedgerId, ref: string, ignoring?: VoucherId): boolean {
  const wanted = ref.trim();
  if (wanted === '') return false;
  for (const v of vouchers) {
    if (v.status !== 'posted' || v.id === ignoring) continue;
    for (const line of allocatedLinesOf(v, masters)) {
      if (line.ledgerId !== ledgerId) continue;
      if (line.allocations.some((x) => x.kind === 'new' && (x.ref ?? '').trim() === wanted)) return true;
    }
  }
  return false;
}

/** A purchase invoice may not reuse a supplier invoice number that is already a bill of that supplier. Other kinds have no such rule. */
export function billRefProblems(baseKind: string | undefined, draft: unknown, masters: Masters, vouchers: readonly Voucher[], ignoring?: VoucherId): Issue[] {
  if (baseKind !== 'purchase') return [];
  const d = draft as { partyId?: string; billNo?: string };
  if (typeof d.partyId !== 'string' || typeof d.billNo !== 'string') return [];
  if (!billRefTaken(vouchers, masters, vendorLedgerOf(d.partyId as never), d.billNo, ignoring)) return [];
  return [issue(IssueCode.BillRefInUse, `Invoice ${d.billNo.trim()} is already a bill of this supplier: enter the number on this invoice`, 'billNo')];
}
