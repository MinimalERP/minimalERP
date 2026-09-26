import { type Masters, type Money, type Voucher, allocatedLinesOf, formatMoney, openBills } from '@minimalerp/domain';
import { formatDate } from './format';
import { type VoucherForm, blankLine } from './model';
import { partyDetailsOfParty } from './salesModel';

/**
 * F6 on a Sales invoice (F5 on a Purchase bill): the Receipt (Payment) that settles it, filled in — the party's ledger, what is still pending on the
 * bill, set against it, and a narration naming it. The account is the one the party's last voucher of that type used (or anyone's). Nothing is saved: the person checks it,
 * changes the amount for a part payment, and accepts.
 */

/** The bill an invoice raised on its party and what is still pending on it — undefined when it raised none or it is settled. */
export function pendingBillOf(invoice: Voucher, vouchers: readonly Voucher[], masters: Masters): { ledgerId: string; ref: string; pending: Money } | undefined {
  if (invoice.status !== 'posted') return undefined;
  for (const line of allocatedLinesOf(invoice, masters)) {
    const raised = line.allocations.find((a) => a.kind === 'new' && (a.ref ?? '').trim() !== '');
    if (!raised) continue;
    const ref = (raised.ref ?? '').trim();
    const open = openBills(vouchers, masters, line.ledgerId).find((b) => b.ref === ref && b.voucherId === invoice.id);
    return open ? { ledgerId: line.ledgerId, ref, pending: open.pending } : undefined;
  }
  return undefined;
}

export function settleFormFor(
  invoice: Voucher,
  vouchers: readonly Voucher[],
  masters: Masters,
  typeId: string,
  date: string,
): VoucherForm | undefined {
  const bill = pendingBillOf(invoice, vouchers, masters);
  const type = masters.voucherType(typeId as never);
  if (!bill || !type || (type.baseKind !== 'receipt' && type.baseKind !== 'payment')) return undefined;
  const receipt = type.baseKind === 'receipt';
  const ledger = masters.ledger(bill.ledgerId as never);
  const party = ledger?.partyId ? masters.party(ledger.partyId) : undefined;
  // the account this party's last voucher of this type went through — or, the first time, anyone's (a business receives into the same bank, mostly)
  const latest = (vs: readonly Voucher[]) => vs.reduce<Voucher | undefined>((a, v) => (a === undefined || v.date >= a.date ? v : a), undefined);
  const ofType = vouchers.filter((v) => v.status === 'posted' && v.voucherTypeId === typeId);
  const last = latest(ofType.filter((v) => allocatedLinesOf(v, masters).some((l) => l.ledgerId === bill.ledgerId))) ?? latest(ofType);
  const accountId = (last?.content as { accountLedgerId?: string } | undefined)?.accountLedgerId ?? '';
  const account = accountId ? masters.ledger(accountId as never) : undefined;
  const amount = formatMoney(bill.pending);
  return {
    id: crypto.randomUUID(),
    typeId,
    date,
    narration: `${receipt ? 'Received against invoice' : 'Paid against bill'} ${bill.ref} dated ${formatDate(invoice.date)}`,
    accountId: account?.isActive ? account.id : '',
    accountLabel: account?.isActive ? account.name : '',
    lines: [{ ...blankLine(receipt ? 'credit' : 'debit'), ledgerId: bill.ledgerId, label: ledger?.name ?? '', amount, allocations: [{ kind: 'against', ref: bill.ref, dueDate: '', amount }] }],
    ...(party ? { partyDetails: partyDetailsOfParty(party) } : {}),
  };
}
