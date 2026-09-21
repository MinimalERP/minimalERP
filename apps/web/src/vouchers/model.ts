import {
  type Masters,
  type PartyDetails,
  type Voucher,
  type VoucherKindRegistry,
  defaultVoucherKinds,
  formatMoney,
  isPartyLedger,
  money,
  prepareVoucher,
} from '@minimalerp/domain';
import { normalizeAmount } from './format';

/**
 * The voucher form as the screen holds it: plain strings, so it can be kept in the screen-stack frame and saved as a draft.
 * Everything else here is pure — turning the form into the draft the engine understands, previewing the result with the SAME
 * engine the server runs, and mapping each problem back to the field it belongs to.
 */

export type Layout = 'single-entry' | 'double-entry';
export type Side = 'debit' | 'credit';

export interface AllocForm {
  kind: 'new' | 'against' | 'advance' | 'onAccount';
  ref: string;
  dueDate: string;
  amount: string;
  /** Receipt, against a bill: the TDS the customer deducted from THIS bill (the bill is still settled for the whole `amount`). */
  tds?: string;
}

export interface LineForm {
  ledgerId: string;
  /** What the ledger field shows (its name, or what is being typed). */
  label: string;
  side: Side;
  amount: string;
  allocations: AllocForm[];
}

export interface VoucherForm {
  /** The voucher's id: generated once per form, so pressing accept twice cannot post twice (it is the idempotency key). */
  id: string;
  typeId: string;
  date: string;
  narration: string;
  /** Payment / Receipt / Contra: the cash or bank account. */
  accountId: string;
  accountLabel: string;
  lines: LineForm[];
  partyDetails?: PartyDetails | undefined;
}

export const blankLine = (side: Side = 'debit'): LineForm => ({ ledgerId: '', label: '', side, amount: '', allocations: [] });

export const blankForm = (id: string, typeId: string, date: string): VoucherForm => ({
  id,
  typeId,
  date,
  narration: '',
  accountId: '',
  accountLabel: '',
  lines: [blankLine('debit')],
});

export function layoutOf(masters: Masters, typeId: string, registry: VoucherKindRegistry = defaultVoucherKinds()): Layout | undefined {
  const type = masters.voucherType(typeId as never);
  const kind = type ? registry.get(type.baseKind) : undefined;
  if (!kind) return undefined;
  return kind.layout === 'double-entry' ? 'double-entry' : kind.layout === 'single-entry' ? 'single-entry' : undefined;
}

// ---- amounts -----------------------------------------------------------------------------------------------------

export const toMinor = (text: string): bigint | undefined => {
  const n = normalizeAmount(text);
  if (n === undefined) return undefined;
  const [whole = '0', frac = '00'] = n.split('.');
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
};

// ---- form → draft ------------------------------------------------------------------------------------------------

const isEmptyLine = (l: LineForm): boolean => l.ledgerId === '' && l.label.trim() === '' && l.amount.trim() === '';

/**
 * A Receipt is entered the way the customer's payment advice reads: what was RECEIVED against each bill, and the TDS deducted from it as a separate figure
 * (850 received + 5 TDS). The books settle the bill by BOTH (855) — that is what the engine is given: the allocation and the line carry received + TDS,
 * and the bank gets the received part. `tdsOfAllocation` is the TDS a row states (0 when it states none, or not as an amount).
 */
const tdsOfAllocation = (a: AllocForm): bigint => (a.kind === 'against' && (a.tds ?? '').trim() !== '' ? (toMinor(a.tds ?? '') ?? 0n) : 0n);
export const tdsOfLine = (l: LineForm): bigint => l.allocations.reduce((sum, a) => sum + tdsOfAllocation(a), 0n);
/** `text` (an amount) plus `extra` paise, as an amount; text that is not an amount is returned as typed so the form can say so. */
function plusMinor(text: string, extra: bigint): string {
  const n = toMinor(text);
  return n === undefined || extra === 0n ? (normalizeAmount(text) ?? text.trim()) : formatMoney(money(n + extra));
}

function allocationsOf(l: LineForm): Record<string, unknown>[] | undefined {
  const parts = l.allocations
    .filter((a) => a.amount.trim() !== '' || a.ref.trim() !== '')
    .map((a) => ({
      kind: a.kind,
      ...(a.ref.trim() !== '' ? { ref: a.ref.trim() } : {}),
      ...(a.kind === 'new' && a.dueDate.trim() !== '' ? { dueDate: a.dueDate.trim() } : {}),
      amount: plusMinor(a.amount, tdsOfAllocation(a)),
      ...(a.kind === 'against' && (a.tds ?? '').trim() !== '' ? { tds: normalizeAmount(a.tds ?? '') ?? (a.tds ?? '').trim() } : {}),
    }));
  return parts.length > 0 ? parts : undefined;
}

export interface BuiltDraft {
  readonly draft: Record<string, unknown>;
  /** kept[i] = the form line index of draft line i (empty lines are left out, so indexes shift). */
  readonly kept: readonly number[];
}

export function formToDraft(form: VoucherForm, layout: Layout): BuiltDraft {
  const kept: number[] = [];
  form.lines.forEach((l, i) => {
    if (!isEmptyLine(l)) kept.push(i);
  });
  const base = {
    id: form.id,
    voucherTypeId: form.typeId,
    date: form.date,
    ...(form.narration.trim() !== '' ? { narration: form.narration.trim() } : {}),
    ...(form.partyDetails ? { partyDetails: form.partyDetails } : {}),
  };
  const line = (l: LineForm) => {
    const allocations = allocationsOf(l);
    return { ledgerId: l.ledgerId, amount: plusMinor(l.amount, tdsOfLine(l)), ...(allocations ? { allocations } : {}) };
  };
  if (layout === 'double-entry') {
    return { draft: { ...base, entries: kept.map((i) => ({ ...line(form.lines[i] as LineForm), side: (form.lines[i] as LineForm).side })) }, kept };
  }
  return { draft: { ...base, accountLedgerId: form.accountId, lines: kept.map((i) => line(form.lines[i] as LineForm)) }, kept };
}

// ---- preview -----------------------------------------------------------------------------------------------------

/** Where a problem is shown: a named field, one cell of a line, or the whole voucher. */
export type FieldKey = 'date' | 'account' | 'narration' | 'general' | `line.${number}.${'ledger' | 'amount' | 'side' | 'alloc'}` | `party.${string}`;
export interface FormIssue {
  readonly field: FieldKey;
  readonly message: string;
  readonly code?: string | undefined;
}

export interface Preview {
  /** True when the engine accepts the voucher as it stands. */
  readonly ok: boolean;
  readonly issues: readonly FormIssue[];
  readonly debit: bigint;
  readonly credit: bigint;
  /** Journal: debit and credit agree (and are above zero). Single-entry vouchers are balanced by construction. */
  readonly balanced: boolean;
  readonly draft: Record<string, unknown>;
}

const LEAF: Readonly<Record<string, 'ledger' | 'amount' | 'side' | 'alloc'>> = {
  ledgerId: 'ledger',
  amount: 'amount',
  side: 'side',
  allocations: 'alloc',
};

/** `lines.2.amount` → line 2's amount cell; `accountLedgerId` → the account field; anything unrecognised → the whole voucher. */
export function fieldOfPath(path: string | undefined, kept: readonly number[]): FieldKey {
  if (path === undefined || path === '') return 'general';
  const parts = path.split('.');
  if (parts[0] === 'date') return 'date';
  if (parts[0] === 'narration') return 'narration';
  if (parts[0] === 'accountLedgerId') return 'account';
  if (parts[0] === 'partyDetails') return `party.${parts.slice(1).join('.')}`;
  if ((parts[0] === 'lines' || parts[0] === 'entries') && parts[1] !== undefined && /^\d+$/.test(parts[1])) {
    const formIndex = kept[Number(parts[1])];
    const leaf = LEAF[parts[2] ?? ''];
    if (formIndex !== undefined && leaf) return `line.${formIndex}.${leaf}`;
  }
  return 'general';
}

/** Problems a person can see without asking the engine — said kindly, on the right field. */
function localIssues(form: VoucherForm, layout: Layout, kept: readonly number[]): FormIssue[] {
  const out: FormIssue[] = [];
  if (layout === 'single-entry' && form.accountId === '') out.push({ field: 'account', message: 'Choose the account (cash or bank)' });
  for (const i of kept) {
    const l = form.lines[i] as LineForm;
    if (l.ledgerId === '') out.push({ field: `line.${i}.ledger`, message: 'Choose a ledger' });
    if (l.amount.trim() === '') out.push({ field: `line.${i}.amount`, message: 'Enter an amount' });
    else if (normalizeAmount(l.amount) === undefined) out.push({ field: `line.${i}.amount`, message: 'That is not an amount (like 1,250.50)' });
    for (const a of l.allocations) {
      if (a.amount.trim() !== '' && normalizeAmount(a.amount) === undefined) out.push({ field: `line.${i}.alloc`, message: 'A bill amount is not an amount' });
      if (a.kind === 'against' && (a.tds ?? '').trim() !== '' && normalizeAmount(a.tds ?? '') === undefined) out.push({ field: `line.${i}.alloc`, message: 'The TDS is not an amount' });
    }
  }
  if (kept.length === 0) out.push({ field: 'general', message: 'Enter at least one line' });
  return out;
}

export function totalsOf(form: VoucherForm, layout: Layout): { debit: bigint; credit: bigint } {
  let debit = 0n;
  let credit = 0n;
  for (const l of form.lines) {
    const v = toMinor(l.amount);
    if (v === undefined) continue;
    if (layout === 'double-entry') {
      if (l.side === 'debit') debit += v;
      else credit += v;
    } else {
      debit += v;
      credit += v;
    }
  }
  return { debit, credit };
}

/** The engine's verdict on the form as it stands, with each problem placed on its field. */
export function previewVoucher(form: VoucherForm, layout: Layout, masters: Masters, registry: VoucherKindRegistry = defaultVoucherKinds()): Preview {
  const { draft, kept } = formToDraft(form, layout);
  const { debit, credit } = totalsOf(form, layout);
  const balanced = layout === 'single-entry' ? debit > 0n : debit > 0n && debit === credit;

  const local = localIssues(form, layout, kept);
  if (local.length > 0) return { ok: false, issues: local, debit, credit, balanced, draft };

  const result = prepareVoucher(draft, masters, registry);
  if (result.ok) return { ok: true, issues: [], debit, credit, balanced, draft };
  return {
    ok: false,
    issues: result.issues.map((i) => ({ field: fieldOfPath(i.path, kept), message: i.message, code: i.code })),
    debit,
    credit,
    balanced,
    draft,
  };
}

// ---- switching type ----------------------------------------------------------------------------------------------

export interface Switched {
  readonly form: VoucherForm;
  /** Said to the user when something could not be carried over. */
  readonly note?: string | undefined;
}

/**
 * Moving to another voucher type keeps the date, narration, party details and lines. Between two layouts the cash/bank account
 * cannot come along (a Journal may not use cash or bank, and a Journal has no account), so it is cleared — and the user is told.
 */
export function switchType(form: VoucherForm, from: Layout, to: Layout, typeId: string): Switched {
  const next: VoucherForm = { ...form, typeId };
  if (from === to) return { form: next };
  const hadAccount = from === 'single-entry' && form.accountId !== '';
  return {
    form: { ...next, accountId: '', accountLabel: '' },
    ...(hadAccount ? { note: `The account (${form.accountLabel}) was cleared: a ${to === 'double-entry' ? 'Journal' : 'voucher with an account'} works differently.` } : {}),
  };
}

// ---- ledger choices for the pickers -----------------------------------------------------------------------------

export interface LedgerChoice {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  /** For a party's own ledger: which party and which side of it (a party that is both has one of each). */
  readonly partyId?: string | undefined;
  readonly partyRole?: 'customer' | 'vendor' | undefined;
}

/** Which ledgers a field may offer: the rules the engine enforces, applied up front so the picker never offers a wrong one. */
export type LedgerRole = 'account' | 'particular' | 'contra-particular' | 'journal';

export function ledgerChoices(masters: Masters, role: LedgerRole, exclude?: string): LedgerChoice[] {
  return masters.ledgers
    .filter((l) => l.isActive && l.reservedKey === undefined && l.id !== exclude)
    .filter((l) => {
      const cashBank = masters.isCashOrBank(l.id);
      if (role === 'account' || role === 'contra-particular') return cashBank;
      if (role === 'journal') return !cashBank;
      return true;
    })
    .map((l) => ({ id: l.id, name: l.name, group: masters.groups.get(l.groupId)?.name ?? '', partyId: l.partyId, partyRole: l.partyRole }));
}

/** Which side of a party a voucher is about: money in (receipt) is from a customer, money out (payment) to a vendor. */
export const preferredRole = (kind: string | undefined): 'customer' | 'vendor' | undefined =>
  kind === 'receipt' ? 'customer' : kind === 'payment' ? 'vendor' : undefined;

/**
 * When both ledgers of one party match what was typed, the one this voucher is about comes first (a receipt offers the customer
 * ledger, a payment the vendor one). Everything else keeps its order.
 */
export function preferSiblings(hits: readonly LedgerChoice[], prefer: 'customer' | 'vendor' | undefined): LedgerChoice[] {
  if (prefer === undefined) return [...hits];
  const out: LedgerChoice[] = [];
  const placed = new Set<string>();
  for (const h of hits) {
    if (placed.has(h.id)) continue;
    if (h.partyId !== undefined && h.partyRole !== undefined && h.partyRole !== prefer) {
      const sibling = hits.find((x) => x.partyId === h.partyId && x.partyRole === prefer && !placed.has(x.id));
      if (sibling) {
        out.push(sibling);
        placed.add(sibling.id);
      }
    }
    out.push(h);
    placed.add(h.id);
  }
  return out;
}

export const isPartyLine = (masters: Masters, ledgerId: string): boolean => ledgerId !== '' && isPartyLedger(masters, ledgerId as never);

// ---- voucher → form (display / alter) ---------------------------------------------------------------------------

const asText = (v: unknown): string => (typeof v === 'bigint' ? formatMoney(v as never) : v === undefined || v === null ? '' : String(v));

export function formFromVoucher(voucher: Voucher, masters: Masters): VoucherForm {
  const c = voucher.content as unknown as {
    narration?: string;
    accountLedgerId?: string;
    lines?: { ledgerId: string; amount: unknown; allocations?: { kind: AllocForm['kind']; ref?: string; dueDate?: string; amount: unknown; tds?: unknown }[] }[];
    entries?: { ledgerId: string; side: Side; amount: unknown; allocations?: { kind: AllocForm['kind']; ref?: string; dueDate?: string; amount: unknown; tds?: unknown }[] }[];
    partyDetails?: PartyDetails;
  };
  const name = (id: string) => masters.ledger(id as never)?.name ?? '';
  const kind = masters.voucherType(voucher.voucherTypeId)?.baseKind;
  const defaultSide: Side = kind === 'receipt' ? 'credit' : 'debit';
  // a stored Receipt settles each bill by received + TDS; the form shows what was received and the TDS beside it
  const received = (amount: unknown, tds: unknown): string => {
    const total = toMinor(asText(amount));
    const cut = tds === undefined ? undefined : toMinor(asText(tds));
    return total !== undefined && cut !== undefined ? formatMoney(money(total - cut)) : asText(amount);
  };
  const allocs = (a?: { kind: AllocForm['kind']; ref?: string; dueDate?: string; amount: unknown; tds?: unknown }[]): AllocForm[] =>
    (a ?? []).map((x) => ({ kind: x.kind, ref: x.ref ?? '', dueDate: x.dueDate ?? '', amount: received(x.amount, x.tds), ...(x.tds !== undefined ? { tds: asText(x.tds) } : {}) }));
  const tdsIn = (a?: { tds?: unknown }[]): bigint => (a ?? []).reduce((sum, x) => sum + (x.tds === undefined ? 0n : (toMinor(asText(x.tds)) ?? 0n)), 0n);
  const lineAmount = (amount: unknown, a?: { tds?: unknown }[]): string => received(amount, tdsIn(a) === 0n ? undefined : formatMoney(money(tdsIn(a))));
  const lines: LineForm[] = c.entries
    ? c.entries.map((e) => ({ ledgerId: e.ledgerId, label: name(e.ledgerId), side: e.side, amount: lineAmount(e.amount, e.allocations), allocations: allocs(e.allocations) }))
    : (c.lines ?? []).map((l) => ({ ledgerId: l.ledgerId, label: name(l.ledgerId), side: defaultSide, amount: lineAmount(l.amount, l.allocations), allocations: allocs(l.allocations) }));
  return {
    id: voucher.id,
    typeId: voucher.voucherTypeId,
    date: voucher.date,
    narration: c.narration ?? '',
    accountId: c.accountLedgerId ?? '',
    accountLabel: c.accountLedgerId ? name(c.accountLedgerId) : '',
    lines: lines.length > 0 ? lines : [blankLine()],
    ...(c.partyDetails ? { partyDetails: c.partyDetails } : {}),
  };
}

/** A form with nothing entered (used to decide whether a saved draft is worth keeping). */
export function isBlank(form: VoucherForm): boolean {
  return form.accountId === '' && form.narration.trim() === '' && form.lines.every(isEmptyLine) && form.partyDetails === undefined;
}
