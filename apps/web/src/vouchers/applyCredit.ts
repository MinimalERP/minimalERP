import { type BillAllocation, type Masters, type Money, type Voucher, allocatedLinesOf, money } from '@minimalerp/domain';

/**
 * "Apply credit" on a Purchase bill, "Apply to bills" on a Payment: an advance paid to a supplier (a Payment's Advance / On account row) is set against
 * the supplier's bills. No voucher is made: the Payment is altered — what is applied leaves its Advance / On account rows and becomes Against ref rows
 * naming the bills. Its amount and the ledgers do not move; only the bill-wise split does.
 */

const isCredit = (a: { kind: string }): boolean => a.kind === 'advance' || a.kind === 'onAccount';

export interface Credit {
  readonly voucher: Voucher;
  readonly unapplied: Money;
}

/** What a posted Payment still holds as Advance / On account on this ledger (0 if nothing, or it is not a Payment). */
export function unappliedOn(payment: Voucher, masters: Masters, ledgerId: string): Money {
  if (payment.status !== 'posted' || masters.voucherType(payment.voucherTypeId)?.baseKind !== 'payment') return money(0n);
  let sum = 0n;
  for (const l of allocatedLinesOf(payment, masters)) if (l.ledgerId === ledgerId) for (const a of l.allocations) if (isCredit(a)) sum += a.amount;
  return money(sum);
}

/** The first party ledger of a Payment that still holds an Advance / On account, and how much. */
export function unappliedOf(payment: Voucher, masters: Masters): { ledgerId: string; unapplied: Money } | undefined {
  for (const l of allocatedLinesOf(payment, masters)) {
    const unapplied = unappliedOn(payment, masters, l.ledgerId);
    if (unapplied > 0n) return { ledgerId: l.ledgerId, unapplied };
  }
  return undefined;
}

/** The Payments that still hold an Advance / On account for this ledger, oldest first. */
export function creditsOf(vouchers: readonly Voucher[], masters: Masters, ledgerId: string): Credit[] {
  return vouchers
    .map((voucher) => ({ voucher, unapplied: unappliedOn(voucher, masters, ledgerId) }))
    .filter((c) => c.unapplied > 0n)
    .sort((a, b) => (a.voucher.date < b.voucher.date ? -1 : a.voucher.date > b.voucher.date ? 1 : 0));
}

export interface Share {
  readonly id: string;
  readonly amount: bigint;
}

/** `need` taken from the sources in their order, each giving no more than it has: who gives how much (those that give nothing are left out). */
export function planCredit(sources: readonly Share[], need: bigint): Share[] {
  const out: Share[] = [];
  let left = need;
  for (const s of sources) {
    const take = s.amount < left ? s.amount : left;
    if (take > 0n) out.push({ id: s.id, amount: take });
    left -= take;
  }
  return out;
}

/**
 * The Payment's content with `parts` (a bill reference and an amount each) moved from its Advance / On account rows on this ledger — Advance first — to
 * Against ref rows; a row already against the same bill grows. Never more than the Payment holds: what does not fit is left out.
 */
export function withCreditApplied(payment: Voucher, ledgerId: string, parts: readonly { ref: string; amount: bigint }[]): unknown {
  const content = payment.content as unknown as { lines?: { ledgerId: string; allocations?: BillAllocation[] }[] };
  const todo = parts.map((p) => ({ ...p }));
  const lines = (content.lines ?? []).map((line) => {
    if (line.ledgerId !== ledgerId || !line.allocations?.some(isCredit)) return line;
    const rows = line.allocations.map((a) => ({ ...a }));
    const credits = [...rows.filter((a) => a.kind === 'advance'), ...rows.filter((a) => a.kind === 'onAccount')];
    const added: BillAllocation[] = [];
    for (const part of todo) {
      for (const c of credits) {
        const take = c.amount < part.amount ? c.amount : part.amount;
        if (take <= 0n) continue;
        c.amount = money(c.amount - take);
        part.amount -= take;
        const row = rows.find((a) => a.kind === 'against' && (a.ref ?? '').trim() === part.ref) ?? added.find((a) => a.ref === part.ref);
        if (row) row.amount = money(row.amount + take);
        else added.push({ kind: 'against', ref: part.ref, amount: money(take) });
      }
    }
    return { ...line, allocations: [...rows.filter((a) => !isCredit(a)), ...added, ...rows.filter((a) => isCredit(a) && a.amount > 0n)] };
  });
  return { ...content, lines };
}
