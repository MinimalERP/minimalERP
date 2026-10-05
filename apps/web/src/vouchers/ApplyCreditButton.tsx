import type { Voucher } from '@minimalerp/domain';
import { useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { MultiSelectDialog } from '../screens/ReportDialogs';
import { Only } from '../shell/Only';
import { creditsOf, planCredit, unappliedOf, withCreditApplied } from './applyCredit';
import { settleableBills } from './bills';
import { formatAmount, formatDate } from './format';
import { pendingBillOf } from './settleBill';

export type CreditOutcome = { readonly text: string; readonly tone: 'ok' | 'error' };

/**
 * "Apply credit" on a posted Purchase bill still to be paid, "Apply to bills" on a posted Payment that holds an Advance / On account: a list to tick —
 * the supplier's advances (its open bills), oldest first, ticked as far as they are needed — and on accept the Payments are altered so that the advance
 * is against the bills (see applyCredit.ts). Neither is offered when there is nothing to apply.
 */
export function ApplyCredit({ books, voucher, scope, onDone, onAltered }: { books: Books; voucher: Voucher | undefined; scope: string; onDone: (outcome: CreditOutcome) => void; onAltered?: (payment: Voucher) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const masters = books.masters;
  const base = voucher ? masters.voucherType(voucher.voucherTypeId)?.baseKind : undefined;
  if (!voucher || voucher.status !== 'posted' || busy) return null;

  /** Alters the Payments one after another; the first refusal stops it and is what is said. */
  const run = (work: () => Promise<CreditOutcome>) => {
    setOpen(false);
    setBusy(true);
    void work().then(
      (outcome) => (setBusy(false), onDone(outcome)),
      (error: unknown) => (setBusy(false), onDone({ text: `Could not apply it: ${String(error instanceof Error ? error.message : error)}`, tone: 'error' })),
    );
  };

  if (base === 'purchase') {
    const bill = pendingBillOf(voucher, books.vouchers, masters);
    const credits = bill ? creditsOf(books.vouchers, masters, bill.ledgerId) : [];
    if (!bill || credits.length === 0) return null;
    const shares = (ids: readonly string[]) => planCredit(credits.filter((c) => ids.length === 0 || ids.includes(c.voucher.id)).map((c) => ({ id: c.voucher.id, amount: c.unapplied })), bill.pending);
    const apply = (ids: readonly string[]) =>
      run(async () => {
        let applied = 0n;
        for (const s of shares(ids)) {
          const payment = credits.find((c) => c.voucher.id === s.id)?.voucher as Voucher;
          const r = await books.alter(payment.id, payment.version, withCreditApplied(payment, bill.ledgerId, [{ ref: bill.ref, amount: s.amount }]));
          if (!r.ok) return { text: `${masters.voucherType(payment.voucherTypeId)?.name ?? 'Payment'} ${payment.number} could not be applied: ${r.issues[0]?.message ?? 'it was refused'}`, tone: 'error' };
          applied += s.amount;
        }
        return { text: `${formatAmount(applied as never)} of credit applied to bill ${bill.ref}.`, tone: 'ok' };
      });
    return (
      <>
        {!open && <Only scope={scope} command="voucher.applyCredit" run={() => (setOpen(true), true)} />}
        {open && (
          <MultiSelectDialog
            title={`Apply credit to bill ${bill.ref} · pending ${formatAmount(bill.pending)}`}
            options={credits.map((c) => ({ value: c.voucher.id, label: `${masters.voucherType(c.voucher.voucherTypeId)?.name ?? 'Payment'} ${c.voucher.number} · ${formatDate(c.voucher.date)} · ${formatAmount(c.unapplied)}` }))}
            selected={shares([]).map((s) => s.id)}
            onDone={(ids) => (ids ? apply(ids) : setOpen(false))}
          />
        )}
      </>
    );
  }

  if (base === 'payment') {
    const credit = unappliedOf(voucher, masters);
    const bills = credit ? settleableBills(books.vouchers, masters, credit.ledgerId, 'debit') : [];
    if (!credit || bills.length === 0) return null;
    const shares = (refs: readonly string[]) => planCredit(bills.filter((b) => refs.length === 0 || refs.includes(b.ref)).map((b) => ({ id: b.ref, amount: b.pending })), credit.unapplied);
    const apply = (refs: readonly string[]) =>
      run(async () => {
        const parts = shares(refs).map((s) => ({ ref: s.id, amount: s.amount }));
        const r = await books.alter(voucher.id, voucher.version, withCreditApplied(voucher, credit.ledgerId, parts));
        if (!r.ok) return { text: r.issues[0]?.message ?? 'It could not be applied', tone: 'error' };
        onAltered?.(r.value.voucher);
        return { text: `${formatAmount(parts.reduce((t, p) => t + p.amount, 0n) as never)} applied to ${parts.length === 1 ? `bill ${parts[0]?.ref}` : `${parts.length} bills`}.`, tone: 'ok' };
      });
    return (
      <>
        {!open && <Only scope={scope} command="voucher.applyToBills" run={() => (setOpen(true), true)} />}
        {open && (
          <MultiSelectDialog
            title={`Apply advance of ${voucher.number} · ${formatAmount(credit.unapplied)} unapplied`}
            options={bills.map((b) => ({ value: b.ref, label: `${b.ref}${b.dueDate ? ` · due ${formatDate(b.dueDate)}` : ''} · pending ${formatAmount(b.pending)}` }))}
            selected={shares([]).map((s) => s.id)}
            onDone={(refs) => (refs ? apply(refs) : setOpen(false))}
          />
        )}
      </>
    );
  }
  return null;
}
