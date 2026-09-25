import { type Masters, type OrderBook, type Proposal, type StockBook, canonicalPercent, customerLedgerOf, formatMoney, money, vendorLedgerOf } from '@minimalerp/domain';
import type { InboxItem } from '@minimalerp/ports';
import { formatDate } from './format';
import { type AllocForm, type LineForm, type VoucherForm, blankLine, toMinor } from './model';
import { type SalesForm, type SalesLineForm, blankSalesLine, dueDateFor, gstDefaults, invoiceFormFromOrder, partyDetailsOfParty } from './salesModel';

/**
 * An AI Inbox proposal (ADR-0023) as the voucher window's form: what was matched is chosen, what was not is the document's own text in the
 * field — the item cell shows "SS washer M8 as per DRG-221", the picker searches it, Alt+C creates the item from it. The form's id is the
 * inbox item's id, so accepting posts under it (and the proposal leaves the inbox with that post; accepting twice posts once).
 */

interface SalesArgs {
  readonly typeId: string;
  readonly newKey: () => string;
  readonly warehouse?: { id: string; label: string } | undefined;
  readonly salesLedger?: { id: string; label: string } | undefined;
  readonly orders: OrderBook;
  readonly stock?: StockBook | undefined;
  /** The posted voucher behind `fromOrderId`, if the books have it. */
  readonly order?: Parameters<typeof invoiceFormFromOrder>[0] | undefined;
}

/** The party, when the proposal names one that exists and is active (a stale id — deleted since — is treated as unmatched). */
const partyOf = (masters: Masters, p: Proposal) => {
  const party = p.party.partyId ? masters.party(p.party.partyId as never) : undefined;
  return party?.isActive ? party : undefined;
};

export function salesFormFromProposal(item: InboxItem, masters: Masters, a: SalesArgs): SalesForm {
  const p = item.proposal;
  const party = partyOf(masters, p);
  const isInvoice = p.kind !== 'salesOrder';
  const gstOn = isInvoice && masters.company.chargeGst === true;

  // An invoice mail quoting an open order of ours: the order's pending lines, exactly as Alt+I on the order would make them.
  if (p.kind === 'sales' && a.order && party) {
    const f = invoiceFormFromOrder(a.order, a.orders, masters, { id: item.id, typeId: a.typeId, date: p.date, newKey: a.newKey, warehouse: a.warehouse, salesLedger: a.salesLedger, stock: a.stock });
    if (f) return { ...f, id: item.id };
  }

  const due = p.dueDate ?? (party ? dueDateFor(masters, party.id, p.date) : p.date);
  const lines: SalesLineForm[] = p.lines.map((l) => {
    const known = l.itemId ? masters.stockItem(l.itemId as never) : undefined;
    const matched = known?.isActive ? known : undefined;
    const lineDue = l.dueDate ?? p.date;
    const fromItem = matched && gstOn ? gstDefaults(masters, matched.id) : {};
    return {
      ...blankSalesLine(a.newKey(), isInvoice ? a.warehouse : undefined, lineDue),
      itemId: matched?.id ?? '',
      // unmatched: the document's words, which the picker searches and Alt+C names the new item after
      itemLabel: matched?.name ?? l.text,
      qty: l.qty,
      rate: l.rate,
      ...(isInvoice ? { due: '', dueText: '' } : {}),
      // the rate and HSN the document printed win over the item's; with GST off neither is on the line
      gstRate: gstOn ? (l.gstRate !== undefined ? canonicalPercent(l.gstRate) : (fromItem.gstRate ?? '')) : '',
      hsn: gstOn ? (l.hsn ?? fromItem.hsn ?? '') : (l.hsn ?? ''),
    };
  });

  return {
    id: item.id,
    typeId: a.typeId,
    date: p.date,
    narration: '',
    partyId: party?.id ?? '',
    partyLabel: party?.name ?? p.party.name ?? '',
    reference: p.reference ?? '',
    ewayBillNo: '',
    partyDetails: party ? partyDetailsOfParty(party) : undefined,
    salesLedgerId: isInvoice ? (a.salesLedger?.id ?? '') : '',
    salesLedgerLabel: isInvoice ? (a.salesLedger?.label ?? '') : '',
    billNo: p.billNo ?? '',
    due,
    dueText: formatDate(due),
    dueTouched: p.dueDate !== undefined,
    closed: false,
    lines: lines.length > 0 ? lines : [blankSalesLine(a.newKey(), isInvoice ? a.warehouse : undefined, p.date)],
  };
}

/**
 * A Receipt or Payment proposal as the entry form: the bank, the party's line for the amount received (or paid), and that line split
 * against the open bills the advice named — a Receipt's bill line holding the TDS the customer deducted, as the Receipt window does — with
 * whatever is left over on account. Bills the party does not have open are left for the person (the proposal's notes say which).
 */
export function entryFormFromProposal(item: InboxItem, masters: Masters, typeId: string): VoucherForm {
  const p = item.proposal;
  const party = partyOf(masters, p);
  const receipt = p.kind === 'receipt';
  const ledgerId = party ? ((receipt ? customerLedgerOf : vendorLedgerOf)(party.id) as string) : '';
  const bank = p.accountLedgerId ? masters.ledger(p.accountLedgerId as never) : undefined;
  const total = toMinor(p.amount ?? '') ?? 0n;

  const allocations: AllocForm[] = [];
  let placed = 0n;
  for (const b of p.bills) {
    if (!b.open) continue;
    const settled = toMinor(b.amount) ?? 0n;
    const tds = receipt && b.tds ? (toMinor(b.tds) ?? 0n) : 0n;
    const cash = settled - tds; // the form shows what came in; the TDS sits beside it
    if (cash <= 0n || placed + cash > total) continue;
    allocations.push({ kind: 'against', ref: b.ref, dueDate: '', amount: formatMoney(money(cash)), ...(tds > 0n ? { tds: formatMoney(money(tds)) } : {}) });
    placed += cash;
  }
  if (ledgerId !== '' && total > placed && allocations.length > 0) {
    allocations.push({ kind: 'onAccount', ref: '', dueDate: '', amount: formatMoney(money(total - placed)) });
  }

  const line: LineForm = {
    ...blankLine(receipt ? 'credit' : 'debit'),
    ledgerId,
    label: party ? (masters.ledger(ledgerId as never)?.name ?? party.name) : (p.party.name ?? ''),
    amount: p.amount ?? '',
    allocations: ledgerId !== '' ? allocations : [],
  };
  return {
    id: item.id,
    typeId,
    date: p.date,
    narration: p.instrument ? `Ref ${p.instrument}` : '',
    accountId: bank?.id ?? '',
    accountLabel: bank?.name ?? '',
    lines: [line],
    ...(party ? { partyDetails: partyDetailsOfParty(party) } : {}),
  };
}

/** What a NEW stock item made with Alt+C from an unmatched line starts with: its name, HSN, GST rate and unit, as the document gave them. */
export function itemSeedOf(masters: Masters, line: { itemLabel: string; hsn?: string | undefined; gstRate?: string | undefined }, unit?: string): Record<string, string> {
  const seed: Record<string, string> = {};
  if (line.itemLabel.trim() !== '') seed['name'] = line.itemLabel.trim();
  // "<part number> - <description>": the part number is the item's code
  const part = /^([A-Za-z0-9][A-Za-z0-9./]*)\s+-\s+\S/.exec(line.itemLabel.trim())?.[1];
  if (part && /\d/.test(part)) seed['code'] = part;
  if (line.hsn && /^\d{4,8}$/.test(line.hsn)) seed['hsn'] = line.hsn;
  if (line.gstRate && line.gstRate !== '') {
    const want = canonicalPercent(line.gstRate);
    const rate = masters.gstRates.find((r) => canonicalPercent(r.ratePercent) === want);
    if (rate) seed['gstRateId'] = rate.id;
  }
  if (unit) {
    const u = unit.trim().toLowerCase().replace(/\.$/, '');
    const found = masters.units.find((x) => x.isActive && (x.symbol.toLowerCase() === u || x.name.toLowerCase() === u));
    if (found) seed['unitId'] = found.id;
  }
  return seed;
}

/** What a NEW party made with Alt+C from an unmatched name starts with: the name, GSTIN and address the document printed. */
export function partySeedOf(p: Proposal): Record<string, string> {
  return {
    ...(p.party.name ? { name: p.party.name } : {}),
    ...(p.party.gstin ? { gstin: p.party.gstin } : {}),
    ...(p.party.address ? { address: p.party.address } : {}),
  };
}

/** The note a window opened from the AI Inbox starts with: where it came from, and everything the reading could not settle. */
export function inboxBanner(item: InboxItem | undefined): { text: string; tone: 'note' } | undefined {
  if (!item) return undefined;
  const from = item.mailSubject ? `“${item.mailSubject}”` : 'a document you sent';
  const notes = item.proposal.notes;
  return {
    tone: 'note',
    text:
      notes.length === 0
        ? `Made from ${from}: everything was matched. Check it, then accept.`
        : `Made from ${from}. Check: ${notes.map((n) => n.message).join(' · ')}`,
  };
}
