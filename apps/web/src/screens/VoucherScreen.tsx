import { type EntityDoc, type Frame, searchEntities } from '@minimalerp/command';
import { type OpenBill, type Voucher, type VoucherKindRegistry, defaultVoucherKinds, formatMoney, partyLedgerId } from '@minimalerp/domain';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { useCommandHandler, useFrameState, useServices, useSubscriptions } from '../shell/hooks';
import { Only } from '../shell/Only';
import { WindowClose } from '../shell/WindowClose';
import { useIdleOnBlankClick } from '../shell/idle';
import { useLeaveGuard } from '../shell/useLeaveGuard';
import type { ScreenRef, VoucherMode } from '../shell/router';
import { Kbd } from '../ui/Kbd';
import { ListView } from '../ui/ListView';
import { defaultDate, fyOf, resolveTypeId } from '../vouchers/entryHelpers';
import { PartyDetailsDialog } from './PartyDetailsDialog';
import { ChooseOneDialog } from './ReportDialogs';
import { type EntryKind, SALES_KINDS, kindTitle } from '../vouchers/kinds';
import { SalesVoucherEntry } from './SalesVoucherScreen';
import { StockVoucherEntry } from './StockVoucherScreen';
import { useOtherVoucherHandlers } from '../vouchers/otherVoucher';
import { amountToSettle, billsToOffer, defaultAllocations, settleableBills, unallocated } from '../vouchers/bills';
import { formatAmount, formatBalance, formatCashBalance, formatDate, parseDateInput } from '../vouchers/format';
import type { LedgerDoc } from '../ui/PrintView';
import {
  type AllocForm,
  type FieldKey,
  type Layout,
  type LedgerChoice,
  type LedgerRole,
  type VoucherForm,
  blankForm,
  blankLine,
  formFromVoucher,
  isBlank,
  isPartyLine,
  layoutOf,
  ledgerChoices,
  preferSiblings,
  preferredRole,
  previewVoucher,
  switchType,
  toMinor,
} from '../vouchers/model';
import type { CreatedMaster } from './MasterFormScreen';

const SCOPE = 'screen:voucher';
const MAX_OPTIONS = 8;
const kinds: VoucherKindRegistry = defaultVoucherKinds();

export { resolveTypeId };



// ---- the field list: what Enter / Tab walk through ---------------------------------------------------------------

type FieldKind = 'date' | 'account' | 'ledger' | 'side' | 'amount' | 'narration' | 'a-kind' | 'a-ref' | 'a-due' | 'a-amount' | 'a-tds';
interface Field {
  readonly key: string;
  readonly kind: FieldKind;
  readonly line?: number;
  readonly part?: number;
}

function fieldsOf(form: VoucherForm, layout: Layout, openBillsFor: number | undefined, receipt = false): Field[] {
  const out: Field[] = [{ key: 'date', kind: 'date' }];
  if (layout === 'single-entry') out.push({ key: 'account', kind: 'account' });
  form.lines.forEach((l, i) => {
    if (layout === 'double-entry') out.push({ key: `l${i}.side`, kind: 'side', line: i });
    out.push({ key: `l${i}.ledger`, kind: 'ledger', line: i }, { key: `l${i}.amount`, kind: 'amount', line: i });
    if (openBillsFor === i) {
      l.allocations.forEach((a, j) => {
        out.push({ key: `a${i}.${j}.kind`, kind: 'a-kind', line: i, part: j }, { key: `a${i}.${j}.ref`, kind: 'a-ref', line: i, part: j });
        if (a.kind === 'new') out.push({ key: `a${i}.${j}.due`, kind: 'a-due', line: i, part: j });
        out.push({ key: `a${i}.${j}.amount`, kind: 'a-amount', line: i, part: j });
        // a Receipt settling a bill can say how much TDS the customer deducted from it
        if (receipt && a.kind === 'against') out.push({ key: `a${i}.${j}.tds`, kind: 'a-tds', line: i, part: j });
      });
    }
  });
  out.push({ key: 'narration', kind: 'narration' });
  return out;
}

/** The order of the type list: what settles something first, raising a new bill last. */
const ALLOC_KINDS: readonly AllocForm['kind'][] = ['against', 'advance', 'onAccount', 'new'];
const ALLOC_LABELS: Readonly<Record<AllocForm['kind'], string>> = { new: 'New ref', against: 'Against ref', advance: 'Advance', onAccount: 'On account' };

// ---- outer: figure out what to show ------------------------------------------------------------------------------

interface Props {
  readonly frame: Frame<ScreenRef>;
  readonly mode: VoucherMode;
  /** create: a base kind ("payment") or a voucher type id. */
  readonly typeKey?: string | undefined;
  /** display / alter: the voucher. */
  readonly id?: string | undefined;
  /** create, sales invoice: the sales order whose pending lines it starts with. */
  readonly fromOrder?: string | undefined;
}

export function VoucherScreen({ frame, mode, typeKey, id, fromOrder }: Props) {
  const { books: host, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const books = host.current;
  const heading = mode === 'create' ? `New ${kindTitle(typeKey ?? '') ?? 'Voucher'} Voucher` : 'Voucher';

  if (!books) {
    return (
      <section class="screen" aria-labelledby="voucher-title">
        <h1 id="voucher-title">{heading}</h1>
        <p class="lede">Open a company first: press Alt+G and choose “Create Company” or “Load Demo Company”.</p>
      </section>
    );
  }
  const voucher = mode === 'create' ? undefined : books.voucher(id ?? '');
  if (mode !== 'create' && !voucher) {
    return (
      <section class="screen" aria-labelledby="voucher-title">
        <h1 id="voucher-title">Voucher</h1>
        <p class="empty">That voucher does not exist.</p>
      </section>
    );
  }
  const typeId = voucher ? voucher.voucherTypeId : resolveTypeId(books.masters, typeKey ?? '');
  // A stock voucher (Stock Journal) has its own columns but the same worksheet: it is drawn by StockVoucherEntry.
  if (typeId && kinds.get(books.masters.voucherType(typeId as never)?.baseKind as never)?.layout === 'stock') {
    return <StockVoucherEntry frame={frame} books={books} mode={mode} typeId={typeId} voucher={voucher} />;
  }
  // The sales documents (Sales Order, Sales Invoice) are item lines: they have their own columns on the same worksheet.
  if (typeId && kinds.get(books.masters.voucherType(typeId as never)?.baseKind as never)?.layout === 'item-invoice') {
    return <SalesVoucherEntry frame={frame} books={books} mode={mode} typeId={typeId} voucher={voucher} fromOrder={fromOrder} />;
  }
  if (!typeId || !layoutOf(books.masters, typeId, kinds)) {
    return (
      <section class="screen" aria-labelledby="voucher-title">
        <h1 id="voucher-title">{heading}</h1>
        <p class="empty">This voucher type cannot be entered on this screen yet.</p>
      </section>
    );
  }
  return <VoucherEntry frame={frame} books={books} mode={mode} typeId={typeId} voucher={voucher} />;
}

// ---- the entry window --------------------------------------------------------------------------------------------

interface EntryProps {
  readonly frame: Frame<ScreenRef>;
  readonly books: Books;
  readonly mode: VoucherMode;
  readonly typeId: string;
  readonly voucher: Voucher | undefined;
}

function VoucherEntry({ frame, books, mode, typeId, voucher }: EntryProps) {
  const { app, keymapStore, print } = useServices();
  useSubscriptions(books);
  const masters = books.masters;
  const readOnly = mode === 'display';
  const startForm = (): VoucherForm => (voucher ? formFromVoucher(voucher, masters) : blankForm(crypto.randomUUID(), typeId, defaultDate(masters)));

  const [form, setFormState] = useFrameState<VoucherForm>(frame, 'form', startForm());
  const [focusKey, setFocusKey] = useFrameState<string>(
    frame,
    'focus',
    mode === 'create' ? (layoutOf(masters, typeId, kinds) === 'double-entry' ? 'l0.side' : 'account') : 'date',
  );
  const [billsFor, setBillsFor] = useFrameState<number | undefined>(frame, 'bills', undefined);
  const [dateText, setDateText] = useFrameState<string>(frame, 'dateText', formatDate(form.date));
  const [showErrors, setShowErrors] = useFrameState<boolean>(frame, 'showErrors', false);
  const [partyOpen, setPartyOpen] = useState(false);
  const [createAsking, setCreateAsking] = useState(false);
  const [pick, setPick] = useState({ index: 0, touched: false });
  /** The field whose popup list was closed with Esc. Typing, ↓ or moving to another field opens a list again. */
  const [pickerClosed, setPickerClosed] = useState<string | undefined>(undefined);
  /** The open-bills list of an "Against ref" row: which ref field it belongs to, and whether something was typed or moved since (then it filters). It opens on typing or ↓. */
  const [billList, setBillList] = useState<{ key: string; touched: boolean } | undefined>(undefined);
  const [billIndex, setBillIndex] = useState(0);
  const [banner, setBanner] = useState<{ text: string; tone: 'error' | 'ok' | 'note' } | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<'cancel' | undefined>(undefined);
  const leave = useLeaveGuard('This voucher has not been saved.');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Clicking blank space deactivates the active field until a field is clicked or a key pressed. */
  const { idle, wake } = useIdleOnBlankClick(rootRef);
  const draftReady = useRef(mode !== 'create');

  const layout = layoutOf(masters, form.typeId, kinds) as Layout;
  const type = masters.voucherType(form.typeId as never);
  /** A Receipt can say how much TDS the customer deducted from each bill it settles. */
  const isReceipt = type?.baseKind === 'receipt';
  const fields = fieldsOf(form, layout, billsFor, isReceipt);
  const at = Math.max(0, fields.findIndex((f) => f.key === focusKey));
  const current = fields[at] as Field;

  // Always read the newest form (a result from Alt+C can arrive after this instance was replaced).
  const fresh = (): VoucherForm => (frame.state.get('form') as VoucherForm | undefined) ?? form;
  const update = (fn: (f: VoucherForm) => VoucherForm) => setFormState(fn(fresh()));
  const setLine = (i: number, patch: Partial<VoucherForm['lines'][number]>) =>
    update((f) => ({ ...f, lines: f.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) }));

  // ---- drafts: a half-entered voucher survives a reload ----
  const draftKey = `type:${form.typeId}`;

  // Leaving the window — Esc, ×, saving, another screen on top — leaves nothing behind: the next New voucher opens clean. (A page reload never runs
  // this, so a half-entered document still survives a reload.)
  const draftKeyNow = useRef(draftKey);
  draftKeyNow.current = draftKey;
  useEffect(
    () => () => {
      if (mode === 'create') void books.clearDraft(draftKeyNow.current);
    },
    [],
  );
  useEffect(() => {
    if (mode !== 'create' || frame.state.has('form-loaded')) {
      draftReady.current = true;
      return;
    }
    frame.state.set('form-loaded', true);
    void books.loadDraft(draftKey).then((saved) => {
      const d = saved as VoucherForm | undefined;
      if (d && isBlank(fresh()) && d.typeId === typeId) {
        setFormState(d);
        setDateText(formatDate(d.date));
      }
      draftReady.current = true;
    });
  }, []);
  useEffect(() => {
    if (mode !== 'create' || !draftReady.current) return;
    const t = setTimeout(() => void (isBlank(form) ? books.clearDraft(draftKey) : books.saveDraft(draftKey, form)), 350);
    return () => clearTimeout(t);
  }, [form]);

  // ---- what each problem says, and where ----
  const preview = useMemo(() => previewVoucher(form, layout, masters, kinds), [form, layout, masters]);
  const issueAt = (field: FieldKey): string | undefined => fieldErrors[field] || (showErrors ? preview.issues.find((i) => i.field === field)?.message : undefined);
  const general = showErrors ? preview.issues.filter((i) => i.field === 'general').map((i) => i.message) : [];

  // ---- focus ----
  useEffect(() => {
    if (idle || partyOpen || createAsking) return; // idle: a blank click deactivated the field. A dialog is asking: it has the focus; the field gets it back when the dialog closes
    const el = rootRef.current?.querySelector<HTMLInputElement>(`[data-vf="${current.key}"]`);
    el?.focus();
    if (el && el.type === 'text') el.select();
  }, [focusKey, billsFor, mode, partyOpen, createAsking, idle]);
  const go = (key: string) => {
    wake();
    setPick({ index: 0, touched: false });
    setPickerClosed(undefined);
    setBillList(undefined);
    setBillIndex(0);
    setFocusKey(key);
  };
  const nextKey = (from = at): string | undefined => fields[from + 1]?.key;
  const prevKey = (from = at): string | undefined => fields[from - 1]?.key;

  // ---- ledger pickers ----
  const roleOf = (f: Field): LedgerRole | undefined => {
    if (f.kind === 'account') return 'account';
    if (f.kind !== 'ledger') return undefined;
    if (layout === 'double-entry') return 'journal';
    return type?.baseKind === 'contra' ? 'contra-particular' : 'particular';
  };
  const role = roleOf(current);
  const pickerOn = !readOnly && role !== undefined;
  const pickerDismissed = pickerClosed !== undefined && pickerClosed === current.key;
  const choices: LedgerChoice[] = useMemo(
    () => (role ? ledgerChoices(masters, role, layout === 'single-entry' && role !== 'account' ? form.accountId : undefined) : []),
    [masters, role, layout, form.accountId],
  );
  const typedLabel = current.kind === 'account' ? form.accountLabel : current.line !== undefined ? (form.lines[current.line]?.label ?? '') : '';
  const storedId = current.kind === 'account' ? form.accountId : current.line !== undefined ? (form.lines[current.line]?.ledgerId ?? '') : '';
  const storedName = masters.ledger(storedId as never)?.name ?? '';
  const hits: LedgerChoice[] = useMemo(() => {
    if (!pickerOn) return [];
    const typed = typedLabel.trim();
    if (typed === '' || typed === storedName) return []; // a list opens when something is typed, and offers only what matches
    const docs: EntityDoc[] = choices.map((c) => ({ key: c.id, kind: '', scope: 'v', title: c.name, subtitle: c.group, commandId: '', args: c.id }));
    const found = searchEntities(docs, typed, { limit: MAX_OPTIONS }).map((h) => choices.find((c) => c.id === h.key) as LedgerChoice);
    return preferSiblings(found, preferredRole(type?.baseKind));
  }, [pickerOn, choices, typedLabel, storedName, type?.baseKind]);
  const pickIndex = Math.min(pick.index, Math.max(0, hits.length - 1));

  // ---- the open bills an "Against ref" row can name (a party line's bill-wise panel) ----
  const refAlloc = current.kind === 'a-ref' && current.line !== undefined && current.part !== undefined ? form.lines[current.line]?.allocations[current.part] : undefined;
  const refRow = !readOnly && refAlloc?.kind === 'against';
  const billListOn = refRow && billList?.key === current.key;
  const billSideOf = (l: VoucherForm['lines'][number]) => (layout === 'double-entry' ? l.side : isReceipt ? 'credit' : ('debit' as const));
  const offeredBills = (f: VoucherForm): OpenBill[] => {
    const l = f.lines[current.line ?? 0];
    if (!l || current.line === undefined) return [];
    return billsToOffer({ vouchers: books.vouchers, masters, ledgerId: l.ledgerId, side: billSideOf(l), allocations: l.allocations, exceptPart: current.part, ignoreVoucher: voucher?.id });
  };
  const billHits: OpenBill[] = (() => {
    if (!billListOn) return [];
    const all = offeredBills(form);
    const typed = billList?.touched ? (refAlloc?.ref ?? '').trim().toLowerCase() : '';
    return typed === '' ? all : all.filter((b) => b.ref.toLowerCase().includes(typed));
  })();
  const billIdx = Math.min(billIndex, Math.max(0, billHits.length - 1));
  const chooseBill = (b: OpenBill) => {
    if (current.line === undefined || current.part === undefined) return;
    const l = fresh().lines[current.line] as VoucherForm['lines'][number];
    const j = current.part;
    setLine(current.line, { allocations: l.allocations.map((p, k) => (k === j ? { ...p, ref: b.ref, amount: amountToSettle(b, l.amount, l.allocations, j) } : p)) });
    go(`a${current.line}.${j}.amount`);
  };
  const moveBill = (delta: number): boolean => {
    if (!refRow) return false;
    if (!billListOn) {
      if (offeredBills(fresh()).length === 0) return false; // nothing to offer: ↓ just moves on
      setBillList({ key: current.key, touched: false });
      setBillIndex(0);
      return true;
    }
    if (billHits.length === 0) return false;
    setBillIndex((billIdx + delta + billHits.length) % billHits.length);
    return true;
  };

  const choose = (c: LedgerChoice, f: Field = current) => {
    if (f.kind === 'account') update((x) => ({ ...x, accountId: c.id, accountLabel: c.name }));
    else if (f.line !== undefined) setLine(f.line, { ledgerId: c.id, label: c.name, allocations: [] });
    setFieldErrors((e) => ({ ...e, [f.kind === 'account' ? 'account' : `line.${f.line}.ledger`]: '' }));
  };

  /** Leaves the current field: resolves a half-typed ledger, reads a typed date. False (with a message) if it cannot be left. */
  const settle = (): boolean => {
    if (readOnly) return true;
    const errKey = current.kind === 'account' ? 'account' : `line.${current.line}.ledger`;
    if (current.kind === 'date') {
      const y = fyOf(masters, fresh().date);
      const parsed = parseDateInput(dateText, { start: y?.start ?? fresh().date, end: y?.end ?? fresh().date, base: fresh().date });
      if (!parsed) {
        setFieldErrors((e) => ({ ...e, date: 'That is not a date — try 10, 10-5 or 10-5-24' }));
        return false;
      }
      update((f) => ({ ...f, date: parsed }));
      setDateText(formatDate(parsed));
      setFieldErrors((e) => ({ ...e, date: '' }));
      return true;
    }
    if (pickerOn) {
      const typed = typedLabel.trim();
      const choice = hits[pickIndex];
      if (pick.touched && choice) {
        choose(choice);
        return true;
      }
      if (typed === '') {
        if (storedId !== '') update((f) => (current.kind === 'account' ? { ...f, accountId: '', accountLabel: '' } : f));
        if (current.kind !== 'account' && current.line !== undefined && storedId !== '') setLine(current.line, { ledgerId: '', label: '' });
        return true;
      }
      if (typed === storedName) return true;
      if (choice) {
        choose(choice);
        return true;
      }
      setFieldErrors((e) => ({ ...e, [errKey]: 'No match — press Alt+C to create it' }));
      return false;
    }
    return true;
  };

  // ---- moving around ----
  const next = (): boolean => {
    if (!settle()) return true;
    const k = nextKey();
    if (k) go(k);
    return true;
  };

  const journalNextSide = (f: VoucherForm): 'debit' | 'credit' => {
    let d = 0n;
    let c = 0n;
    for (const l of f.lines) {
      const v = BigInt(Math.round(Number((l.amount || '0').replace(/,/g, '')) * 100) || 0);
      if (l.side === 'debit') d += v;
      else c += v;
    }
    return d > c ? 'credit' : d < c ? 'debit' : 'debit';
  };

  const addLine = (afterIndex: number) => {
    const f = fresh();
    const side = layout === 'double-entry' ? journalNextSide(f) : 'debit';
    const line = blankLine(side);
    update((x) => ({ ...x, lines: [...x.lines.slice(0, afterIndex + 1), line, ...x.lines.slice(afterIndex + 1)] }));
    go(layout === 'double-entry' ? `l${afterIndex + 1}.side` : `l${afterIndex + 1}.ledger`);
  };

  const enter = (): boolean => {
    if (readOnly) return next();
    if (current.kind === 'narration') {
      void accept();
      return true;
    }
    if (!settle()) return true;

    // An open-bills list is showing on a ref: Enter takes the highlighted bill (its ref, and what it can be settled for) and moves on to the amount.
    if (billListOn && billHits.length > 0) {
      chooseBill(billHits[billIdx] as OpenBill);
      return true;
    }

    // Enter on an EMPTY bill reference (Against ref) opens the search box: the party's open bills, narrowing as it is typed; the next Enter takes the highlighted one.
    if (refRow && !billListOn && (refAlloc?.ref ?? '').trim() === '' && offeredBills(fresh()).length > 0) {
      setBillList({ key: current.key, touched: false });
      setBillIndex(0);
      return true;
    }

    // Enter on an empty ledger of the LAST line means "that is all the lines": drop it and go to the narration.
    if (current.kind === 'ledger' && current.line !== undefined) {
      const i = current.line;
      const f = fresh();
      const l = f.lines[i] as VoucherForm['lines'][number];
      if (i > 0 && i === f.lines.length - 1 && l.ledgerId === '' && l.label.trim() === '' && l.amount.trim() === '') {
        update((x) => ({ ...x, lines: x.lines.slice(0, -1) }));
        go('narration');
        return true;
      }
    }

    // Bill-wise panel: after the amount of a party line, offer the breakdown once.
    if (current.kind === 'amount' && current.line !== undefined) {
      const i = current.line;
      const line = fresh().lines[i] as VoucherForm['lines'][number];
      const lastIndex = fresh().lines.length - 1;
      if (isPartyLine(masters, line.ledgerId) && line.amount.trim() !== '' && billsFor !== i) {
        // The panel is offered every time the amount is left, not once: what was chosen before comes back as it was while it still adds up to the amount; a changed amount starts again.
        const keep = line.allocations.length > 0 && unallocated(line.amount, line.allocations) === 0n;
        const parts = keep ? line.allocations : defaultAllocations({
          masters, vouchers: books.vouchers, ledgerId: line.ledgerId, side: layout === 'double-entry' ? line.side : type?.baseKind === 'receipt' ? 'credit' : 'debit',
          amount: line.amount, date: fresh().date, ignoreVoucher: voucher?.id,
        });
        if (parts.length > 0) {
          if (!keep) setLine(i, { allocations: parts });
          setBillsFor(i);
          go(`a${i}.0.kind`);
          return true;
        }
      }
      if (billsFor === i) setBillsFor(undefined);
      if (i === lastIndex) {
        if (line.amount.trim() === '') {
          if (line.ledgerId === '' && lastIndex > 0) update((x) => ({ ...x, lines: x.lines.slice(0, -1) }));
          go('narration');
        } else addLine(i);
        return true;
      }
      go(layout === 'double-entry' ? `l${i + 1}.side` : `l${i + 1}.ledger`);
      return true;
    }

    // Inside the bill panel: Enter on the amount goes to its TDS when the bill has one (a receipt against a bill); otherwise it closes the loop.
    if (current.kind === 'a-amount' && current.line !== undefined && current.part !== undefined && isReceipt && fresh().lines[current.line]?.allocations[current.part]?.kind === 'against') return next();
    if ((current.kind === 'a-amount' || current.kind === 'a-tds') && current.line !== undefined) {
      const i = current.line;
      const line = fresh().lines[i] as VoucherForm['lines'][number];
      // Enter walks through EVERY row of the panel, in order: only after the last row does it decide whether to add another row, or leave for the next line.
      if (current.part !== undefined && current.part < line.allocations.length - 1) {
        go(`a${i}.${current.part + 1}.kind`);
        return true;
      }
      const left = unallocated(line.amount, line.allocations);
      if (left > 0n) {
        // More is received than the rows so far take: another row for the rest — an EMPTY one, so the person chooses what it is (Against ref, Advance, On account with ↑↓ on its
        // first field) and, for Against ref, searches the open bills by typing. Rows keep being added until the line is used up. With no open bill left to name, it is on account.
        const anyBillLeft = billsToOffer({ vouchers: books.vouchers, masters, ledgerId: line.ledgerId, side: billSideOf(line), allocations: line.allocations, ignoreVoucher: voucher?.id }).length > 0;
        const row: AllocForm = { kind: anyBillLeft ? 'against' : 'onAccount', ref: '', dueDate: '', amount: formatMoney(left as never) };
        setLine(i, { allocations: [...line.allocations, row] });
        go(`a${i}.${line.allocations.length}.kind`);
        return true;
      }
      if (left < 0n) {
        setFieldErrors((e) => ({ ...e, [`line.${i}.alloc`]: 'The bills add up to more than the line' }));
        return true;
      }
      setBillsFor(undefined);
      const lastIndex = fresh().lines.length - 1;
      if (i === lastIndex) addLine(i);
      else go(layout === 'double-entry' ? `l${i + 1}.side` : `l${i + 1}.ledger`);
      return true;
    }
    return next();
  };

  // ---- commands (the keymap decides which keys) ----
  const cycleSide = (delta: number): boolean => {
    if (current.kind !== 'side' || current.line === undefined || readOnly) return false;
    setLine(current.line, { side: fresh().lines[current.line]?.side === 'debit' ? 'credit' : 'debit' });
    void delta;
    return true;
  };
  /** Sets a row's type; what only belongs to another type goes (a due date is for a new bill, TDS for a bill being settled). */
  const setKind = (i: number, j: number, kind: AllocForm['kind']) => {
    const l = fresh().lines[i] as VoucherForm['lines'][number];
    setLine(i, { allocations: l.allocations.map((p, k) => (k === j ? { ...p, kind, ...(kind === 'new' ? {} : { dueDate: '' }), ...(kind === 'against' ? {} : { tds: '' }) } : p)) });
  };
  const cycleAllocKind = (delta: number): boolean => {
    if (current.kind !== 'a-kind' || current.line === undefined || current.part === undefined || readOnly) return false;
    const l = fresh().lines[current.line] as VoucherForm['lines'][number];
    const a = l.allocations[current.part] as AllocForm;
    const nextKind = ALLOC_KINDS[(ALLOC_KINDS.indexOf(a.kind) + delta + ALLOC_KINDS.length) % ALLOC_KINDS.length] as AllocForm['kind'];
    setKind(current.line, current.part, nextKind);
    return true;
  };
  const movePick = (delta: number): boolean => {
    if (!pickerOn || hits.length === 0) return false;
    setPick({ index: (pickIndex + delta + hits.length) % hits.length, touched: true });
    return true;
  };

  useCommandHandler(SCOPE, 'field.next', next);
  useCommandHandler(SCOPE, 'field.prev', () => {
    settle();
    const k = prevKey();
    if (k) go(k);
    return true;
  });
  useCommandHandler(SCOPE, 'nav.down', () => {
    if (cycleSide(1) || cycleAllocKind(1) || moveBill(1)) return true;
    if (pickerOn && pickerDismissed) return (setPickerClosed(undefined), true);
    return pickerOn && hits.length > 0 ? movePick(1) : next();
  });
  useCommandHandler(SCOPE, 'nav.up', () => {
    if (cycleSide(-1) || cycleAllocKind(-1)) return true;
    if (billListOn && billHits.length > 0) return moveBill(-1);
    if (pickerOn && hits.length > 0) return movePick(-1);
    const k = prevKey();
    if (k) go(k);
    return true;
  });
  useCommandHandler(SCOPE, 'nav.activate', enter);
  // The keys below are registered only in the modes where they mean something (see <Only> at the foot), so the action panel greys the rest.
  const changeDate = () => {
    go('date');
    return true;
  };
  const acceptAndNew = () => {
    if (readOnly || mode !== 'create') return false;
    void accept(false);
    return true;
  };
  const acceptKey = () => {
    if (confirm === 'cancel') {
      void cancelVoucher();
      return true;
    }
    if (readOnly) return false;
    void accept();
    return true;
  };

  /** Alt+C: for a customer/supplier line the missing thing may be a plain ledger or a Party (which brings its ledger); a cash/bank account is always a ledger. */
  const createInline = (): boolean => {
    if (readOnly || !pickerOn) return false;
    if (role === 'account' || role === 'contra-particular') return createLedger();
    setCreateAsking(true);
    return true;
  };
  const createLedger = (): boolean => {
    const f = current;
    void app
      .navigateForResult<CreatedMaster>({ type: 'master', kind: 'ledger', mode: 'create', seed: typedLabel.trim() === '' ? {} : { name: typedLabel.trim() }, inline: true })
      .then((created) => {
        if (!created) return;
        choose({ id: created.id, name: created.name, group: '' }, f);
      });
    return true;
  };
  const createParty = (): boolean => {
    const f = current;
    const want = preferredRole(type?.baseKind) ?? 'customer';
    void app
      .navigateForResult<CreatedMaster>({
        type: 'master',
        kind: 'party',
        mode: 'create',
        seed: { ...(typedLabel.trim() === '' ? {} : { name: typedLabel.trim() }), roleType: want },
        inline: true,
      })
      .then((created) => {
        if (!created) return;
        // The party made its ledger(s): take the one this voucher is about (a receipt: the customer's, a payment: the vendor's).
        const m = books.masters;
        const mine = (['customer', 'vendor'] as const).map((r) => m.ledger(partyLedgerId(created.id, r) as never)).filter((l) => l !== undefined);
        const ledger = mine.find((l) => l?.partyRole === want) ?? mine[0];
        if (ledger) choose({ id: ledger.id, name: ledger.name, group: m.groups.get(ledger.groupId)?.name ?? '' }, f);
      });
    return true;
  };

  // Switching voucher type in place (the bottom bar lists these).
  const switchTo = (kind: EntryKind): boolean => {
    if (mode !== 'create') return false;
    const target = resolveTypeId(masters, kind);
    if (!target || target === form.typeId) return true;
    const toLayout = layoutOf(masters, target, kinds);
    if (!toLayout) return true;
    void books.clearDraft(draftKey);
    const s = switchType(fresh(), layout, toLayout, target);
    setFormState(s.form);
    setBillsFor(undefined);
    setBanner(s.note ? { text: s.note, tone: 'note' } : undefined);
    setFocusKey(toLayout === 'double-entry' ? 'l0.side' : s.form.accountId === '' ? 'account' : 'l0.ledger');
    app.replace({ type: 'voucher', mode: 'create', typeKey: kind }); // the address and the breadcrumb follow the type
    return true;
  };

  // The sales documents have their own window: their keys and panel buttons open one.
  useOtherVoucherHandlers(SCOPE, SALES_KINDS, () => mode === 'create' && isBlank(fresh()));

  const openPartyDetails = () => {
    setPartyOpen(true);
    return true;
  };
  /** Ctrl+Delete: inside the bill-wise panel it takes out THAT row; anywhere else, the line. */
  const removeLine = () => {
    if (readOnly || current.line === undefined) return false;
    if (current.part !== undefined) {
      removeAlloc(current.line, current.part);
      return true;
    }
    if (fresh().lines.length < 2) return false;
    removeAt(current.line);
    return true;
  };
  /** Takes line `i` out (the × on its row, or Ctrl+Delete). The only line is emptied instead, so there is always one to type in. */
  const removeAt = (i: number) => {
    if (readOnly) return;
    setBillsFor(undefined);
    if (fresh().lines.length < 2) {
      update((f) => ({ ...f, lines: [blankLine('debit')] }));
      go(layout === 'double-entry' ? 'l0.side' : 'l0.ledger');
      return;
    }
    update((f) => ({ ...f, lines: f.lines.filter((_, k) => k !== i) }));
    go(layout === 'double-entry' ? `l${Math.max(0, i - 1)}.side` : `l${Math.max(0, i - 1)}.ledger`);
  };
  /** Takes one row out of a line's bill-wise panel (the × on it, or Ctrl+Delete on it). With none left the panel closes, and the next Enter on the amount offers a blank row again. */
  const removeAlloc = (i: number, j: number) => {
    if (readOnly) return;
    const l = fresh().lines[i] as VoucherForm['lines'][number];
    const rest = l.allocations.filter((_, k) => k !== j);
    setLine(i, { allocations: rest });
    setFieldErrors((e) => ({ ...e, [`line.${i}.alloc`]: '' }));
    if (rest.length === 0) {
      setBillsFor(undefined);
      go(`l${i}.amount`);
    } else go(`a${i}.${Math.max(0, j - 1)}.kind`);
  };
  const dirty = mode !== 'display' && (mode === 'create' ? !isBlank(form) : JSON.stringify(form) !== JSON.stringify(formFromVoucher(voucher as Voucher, masters)));
  /**
   * Esc closes ONE thing per press, innermost first: the question being asked (Cancel voucher) → an open popup list → the bill-wise block →
   * the field being edited (back to the previous field, dropping what was typed but not chosen) → and only from the first field the window
   * itself (which asks "Close and leave?" if anything is entered). Overlay dialogs sit above all of this: they take their own Esc.
   */
  useCommandHandler(SCOPE, 'app.back', () => {
    if (confirm === 'cancel') {
      setConfirm(undefined);
      return true;
    }
    const listShown = pickerOn && !pickerDismissed && (hits.length > 0 || typedLabel.trim() !== '');
    if (listShown) {
      setPickerClosed(current.key);
      return true;
    }
    if (billListOn) {
      setBillList(undefined); // the open-bills list closes first
      return true;
    }
    if (billsFor !== undefined) {
      // Inside the panel Esc steps BACK one field, like everywhere else (amount → ref → type → the row above…); only from its first field does it leave the panel.
      const previous = prevKey();
      if (current.part !== undefined && previous !== undefined && fields[at - 1]?.part !== undefined) {
        go(previous);
        return true;
      }
      setBillsFor(undefined);
      go(`l${billsFor}.amount`);
      return true;
    }
    if (mode !== 'display') {
      // Back a field (the date is only for F2, so it is not a stop on the way back; from the date, return to the first entry field).
      const previous = current.kind === 'date' ? fields[1]?.key : prevKey() === 'date' ? undefined : prevKey();
      if (previous !== undefined) {
        if (pickerOn && typedLabel.trim() !== storedName) {
          // what was typed but never chosen is dropped, so the field is left as it was
          if (current.kind === 'account') update((f) => ({ ...f, accountLabel: storedName }));
          else if (current.line !== undefined) setLine(current.line, { label: storedName });
        }
        go(previous);
        if (previous === 'account' || previous.endsWith('.ledger')) setPickerClosed(previous); // arriving by Esc does not pop the list open
        return true;
      }
    }
    if (dirty) {
      leave.ask();
      return true;
    }
    return false; // the global "back" closes the screen
  });

  // The panel's Close button: straight to the window's own decision (ask if something is entered), skipping the popup/field steps of Esc.
  useCommandHandler(SCOPE, 'app.close', () => {
    if (mode === 'display' || !dirty) return false;
    leave.ask();
    return true;
  });

  // ---- accept / cancel ----
  const accept = async (closeAfter = true): Promise<void> => {
    if (busy || readOnly) return;
    if (!settle()) return;
    setShowErrors(true);
    setBanner(undefined);
    const p = previewVoucher(fresh(), layout, masters, kinds);
    if (!p.ok) {
      const first = p.issues[0];
      if (first?.field.startsWith('line.')) {
        const [, i, cell] = first.field.split('.');
        go(cell === 'alloc' ? `l${i}.amount` : `l${i}.${cell}`);
      } else if (first?.field === 'account') go('account');
      else if (first?.field === 'date') go('date');
      return;
    }
    setBusy(true);
    try {
      const f = fresh();
      const result = mode === 'alter' && voucher ? await books.alter(voucher.id, voucher.version, p.draft) : await books.post(p.draft);
      if (!result.ok) {
        const issue = result.issues[0];
        setBanner({ text: issue?.message ?? 'That could not be saved', tone: 'error' });
        return;
      }
      const number = result.value.voucher.number;
      if (mode === 'alter') {
        app.back();
        return;
      }
      await books.clearDraft(draftKey);
      // Saved: the window closes back to where it was opened from, handing over what it made (a voucher list highlights it). "Save and new" (Alt+N) stays instead.
      if (closeAfter) {
        app.back({ id: result.value.voucher.id, number: number, typeName: type?.name ?? 'Voucher' });
        return;
      }
      // Ready for the next one: same type, same date, same account; empty lines.
      const blank = blankForm(crypto.randomUUID(), f.typeId, f.date);
      setFormState({ ...blank, accountId: f.accountId, accountLabel: f.accountLabel });
      setBillsFor(undefined);
      setShowErrors(false);
      setFieldErrors({});
      setBanner({ text: `${type?.name ?? 'Voucher'} ${number} saved.`, tone: 'ok' });
      setFocusKey(layout === 'double-entry' ? 'l0.side' : f.accountId === '' ? 'account' : 'l0.ledger');
    } finally {
      setBusy(false);
    }
  };

  const cancelVoucher = async (): Promise<void> => {
    if (!voucher || busy) return;
    setBusy(true);
    try {
      const result = await books.cancel(voucher.id, voucher.version);
      if (!result.ok) {
        setConfirm(undefined);
        setBanner({ text: result.issues[0]?.message ?? 'That could not be cancelled', tone: 'error' });
        return;
      }
      app.back();
    } finally {
      setBusy(false);
    }
  };

  // ---- rendering ----
  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];
  const errorOf = (key: FieldKey) => {
    const m = issueAt(key);
    return m ? (
      <span class="field-error" role="alert">
        {m}
      </span>
    ) : null;
  };
  const isFocus = (key: string) => !idle && key === current.key;
  const cls = (base: string, key: string, invalid: boolean) => `${base}${isFocus(key) ? ' active' : ''}${invalid ? ' invalid' : ''}`;
  const numberText = voucher ? voucher.number : 'assigned on save';
  const title = mode === 'create' ? `New ${type?.name ?? ''} Voucher` : `${mode === 'alter' ? 'Alter' : 'Display'} ${type?.name ?? ''} ${voucher?.number ?? ''}`;
  const cancelled = voucher?.status === 'cancelled';
  const accountBalance = form.accountId ? books.balanceOf(form.accountId) : undefined;

  /** The posted voucher as a plain ledger/Dr-Cr document. Single-entry (Payment/Receipt/Contra) adds the account line implied by
   * the voucher kind — `form.lines` carries only the particulars, since that account is never stored per line. */
  const buildPrintDoc = (): LedgerDoc | undefined => {
    if (!voucher || !type) return undefined;
    const entryLines = form.lines.filter((l) => l.ledgerId !== '').map((l) => ({ ledger: l.label, side: l.side, amount: toMinor(l.amount) ?? 0n }));
    const lines =
      layout === 'single-entry' && form.accountId
        ? [
            { ledger: form.accountLabel, side: (isReceipt ? 'debit' : 'credit') as 'debit' | 'credit', amount: entryLines.reduce((s, l) => s + l.amount, 0n) },
            ...entryLines,
          ]
        : entryLines;
    return { kind: 'ledger', docTitle: type.name, number: voucher.number, date: voucher.date, lines, narration: form.narration || undefined };
  };

  const pickerList = (key: string) =>
    isFocus(key) && pickerOn && !pickerDismissed && hits.length > 0 ? (
      <div class="picker" data-testid="picker">
        <ListView
          items={hits}
          index={pickIndex}
          itemKey={(c) => c.id}
          label="Ledgers"
          onActivate={(n) => {
            const c = hits[n];
            if (c) choose(c);
          }}
          renderItem={(c) => (
            <>
              <span class="row-title">{c.name}</span>
              <span class="row-desc">{c.group}</span>
              <span class="row-meta">{books.balanceOf(c.id) !== 0n && <span class="amt">{balanceText(c.id)}</span>}</span>
            </>
          )}
        />
      </div>
    ) : isFocus(key) && pickerOn && !pickerDismissed && typedLabel.trim() !== '' && typedLabel.trim() !== storedName ? (
      <div class="picker picker-empty" data-testid="picker">
        No match — <Kbd chord={chord('master.createInline') ?? 'Alt+C'} /> creates “{typedLabel.trim()}”
      </div>
    ) : null;

  /** A ledger's balance for display: cash and bank read as money in hand (+₹ / −₹) as well as Dr/Cr; every other ledger is plain Dr/Cr. */
  const balanceText = (ledgerId: string): string => {
    const b = books.balanceOf(ledgerId);
    return masters.isCashOrBank(ledgerId as never) ? formatCashBalance(b) : formatBalance(b);
  };

  /** "By" is the debit side, "To" the credit side (the book-keeping convention on a journal). */
  const sideWord = (s: 'debit' | 'credit') => (s === 'debit' ? 'By' : 'To');

  const amountInput = (l: VoucherForm['lines'][number], i: number) => (
    <>
      <input
        data-vf={`l${i}.amount`}
        class={cls('vcell num', `l${i}.amount`, !!issueAt(`line.${i}.amount`))}
        type="text"
        inputMode="decimal"
        aria-label={`Line ${i + 1} amount`}
        readOnly={readOnly}
        autocomplete="off"
        value={l.amount}
        onFocus={() => !isFocus(`l${i}.amount`) && go(`l${i}.amount`)}
        onInput={(e) => {
          setLine(i, { amount: (e.target as HTMLInputElement).value });
          setFieldErrors((x) => ({ ...x, [`line.${i}.amount`]: '' }));
        }}
      />
      {errorOf(`line.${i}.amount`)}
    </>
  );

  const journal = layout === 'double-entry';

  const lineRow = (l: VoucherForm['lines'][number], i: number) => {
    const bal = l.ledgerId !== '' ? books.balanceOf(l.ledgerId) : undefined;
    const active = current.line === i;
    return (
      <div key={`l${i}`} class={active ? 'vrow active' : 'vrow'}>
        {journal && (
          <div class="vc-side">
            <input
              data-vf={`l${i}.side`}
              class={cls('vcell side', `l${i}.side`, false)}
              type="text"
              aria-label={`Line ${i + 1} By or To`}
              readOnly={readOnly}
              value={sideWord(l.side)}
              onFocus={() => !isFocus(`l${i}.side`) && go(`l${i}.side`)}
              onInput={(e) => {
                const t = (e.target as HTMLInputElement).value.toLowerCase();
                setLine(i, { side: /[ct]/.test(t.slice(-1)) || t.endsWith('to') ? 'credit' : 'debit' });
              }}
            />
          </div>
        )}
        <div class="vc-ledger">
          <input
            data-vf={`l${i}.ledger`}
            class={cls('vcell', `l${i}.ledger`, !!issueAt(`line.${i}.ledger`))}
            type="text"
            role="combobox"
            aria-label={`Line ${i + 1} ledger`}
            aria-expanded={isFocus(`l${i}.ledger`) && !readOnly}
            readOnly={readOnly}
            autocomplete="off"
            spellcheck={false}
            value={l.label}
            onFocus={() => !isFocus(`l${i}.ledger`) && go(`l${i}.ledger`)}
            onInput={(e) => {
              setPick({ index: 0, touched: true });
              setPickerClosed(undefined);
              setLine(i, { label: (e.target as HTMLInputElement).value });
              setFieldErrors((x) => ({ ...x, [`line.${i}.ledger`]: '' }));
            }}
          />
          {errorOf(`line.${i}.ledger`)}
          {bal !== undefined && !isFocus(`l${i}.ledger`) && (
            <div class="vbal" data-testid="line-balance">
              Cur Bal: {balanceText(l.ledgerId)}
            </div>
          )}
          {pickerList(`l${i}.ledger`)}
        </div>
        {journal ? (
          <>
            <div class="vc-amount">{l.side === 'debit' ? amountInput(l, i) : null}</div>
            <div class="vc-amount">{l.side === 'credit' ? amountInput(l, i) : null}</div>
          </>
        ) : (
          <div class="vc-amount">{amountInput(l, i)}</div>
        )}
        <div class="vc-x">
          {!readOnly && (
            <button type="button" class="line-x" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} aria-label={`Remove line ${i + 1}`} title="Remove this line (Ctrl+Delete)" onClick={() => removeAt(i)}>
              ×
            </button>
          )}
        </div>
        {billsFor === i && billPanel(l, i)}
      </div>
    );
  };

  const billPanel = (l: VoucherForm['lines'][number], i: number) => {
    const bills = settleableBills(books.vouchers, masters, l.ledgerId, journal ? l.side : type?.baseKind === 'receipt' ? 'credit' : 'debit', voucher?.id);
    const left = unallocated(l.amount, l.allocations);
    const tdsTotal = l.allocations.reduce((t, a) => t + (a.kind === 'against' ? (toMinor(a.tds ?? '') ?? 0n) : 0n), 0n);
    const part = (j: number, patch: Partial<AllocForm>) => setLine(i, { allocations: l.allocations.map((p, k) => (k === j ? { ...p, ...patch } : p)) });
    return (
      <div class="bill-panel" data-testid="bill-panel">
        <div class="bill-title">Bill-wise details — {l.label}</div>
        {l.allocations.map((a, j) => (
          <div key={j} class={`bill-line${a.kind === 'new' ? ' with-due' : ''}${isReceipt && a.kind === 'against' ? ' with-tds' : ''}`}>
            <div class="bill-kind">
              <input
                data-vf={`a${i}.${j}.kind`}
                class={cls('vcell', `a${i}.${j}.kind`, false)}
                type="text"
                aria-label="Bill type"
                readOnly
                value={ALLOC_LABELS[a.kind]}
                onFocus={() => !isFocus(`a${i}.${j}.kind`) && go(`a${i}.${j}.kind`)}
              />
              {isFocus(`a${i}.${j}.kind`) && !readOnly && (
                <div class="picker bill-kinds" data-testid="kind-picker">
                  <ListView
                    items={ALLOC_KINDS}
                    index={ALLOC_KINDS.indexOf(a.kind)}
                    itemKey={(k) => k}
                    label="Bill type"
                    onActivate={(n) => {
                      const k = ALLOC_KINDS[n];
                      if (!k) return;
                      setKind(i, j, k);
                      go(`a${i}.${j}.ref`);
                    }}
                    renderItem={(k) => <span class="row-title">{ALLOC_LABELS[k]}</span>}
                  />
                </div>
              )}
            </div>
            <div class="bill-ref">
              <input
                data-vf={`a${i}.${j}.ref`}
                class={cls('vcell', `a${i}.${j}.ref`, false)}
                type="text"
                aria-label="Bill reference"
                placeholder={a.kind === 'against' ? 'reference of the bill (↓ lists the open bills)' : a.kind === 'new' ? 'new bill reference' : 'reference (optional)'}
                value={a.ref}
                readOnly={readOnly}
                onFocus={() => !isFocus(`a${i}.${j}.ref`) && go(`a${i}.${j}.ref`)}
                onInput={(e) => {
                  part(j, { ref: (e.target as HTMLInputElement).value });
                  if (a.kind === 'against') {
                    setBillList({ key: `a${i}.${j}.ref`, touched: true });
                    setBillIndex(0);
                  }
                }}
              />
              {isFocus(`a${i}.${j}.ref`) && billListOn && billHits.length > 0 && (
                <div class="picker bill-picker" data-testid="bill-picker">
                  <ListView
                    items={billHits}
                    index={billIdx}
                    itemKey={(b) => b.ref}
                    label="Open bills"
                    onActivate={(n) => {
                      const b = billHits[n];
                      if (b) chooseBill(b);
                    }}
                    renderItem={(b) => (
                      <>
                        <span class="row-title">{b.ref}</span>
                        <span class="row-desc">{b.dueDate ? `due ${formatDate(b.dueDate)}` : 'no due date'}</span>
                        <span class="row-meta amt">{formatAmount(b.pending)}</span>
                      </>
                    )}
                  />
                </div>
              )}
              {isFocus(`a${i}.${j}.ref`) && billListOn && billHits.length === 0 && (billList?.touched ?? false) && a.ref.trim() !== '' && (
                <div class="picker picker-empty" data-testid="bill-picker">No open bill matches “{a.ref.trim()}”</div>
              )}
            </div>
            {a.kind === 'new' && (
              <input
                data-vf={`a${i}.${j}.due`}
                class={cls('vcell', `a${i}.${j}.due`, false)}
                type="text"
                aria-label="Due date"
                placeholder="due YYYY-MM-DD"
                value={a.dueDate}
                readOnly={readOnly}
                onFocus={() => !isFocus(`a${i}.${j}.due`) && go(`a${i}.${j}.due`)}
                onInput={(e) => part(j, { dueDate: (e.target as HTMLInputElement).value })}
              />
            )}
            <input
              data-vf={`a${i}.${j}.amount`}
              class={cls('vcell num', `a${i}.${j}.amount`, false)}
              type="text"
              inputMode="decimal"
              aria-label="Bill amount"
              value={a.amount}
              readOnly={readOnly}
              onFocus={() => !isFocus(`a${i}.${j}.amount`) && go(`a${i}.${j}.amount`)}
              onInput={(e) => part(j, { amount: (e.target as HTMLInputElement).value })}
            />
            {isReceipt && a.kind === 'against' && (
              <>
                <input
                  data-vf={`a${i}.${j}.tds`}
                  class={cls('vcell num', `a${i}.${j}.tds`, false)}
                  type="text"
                  inputMode="decimal"
                  aria-label="TDS deducted"
                  placeholder="TDS"
                  value={a.tds ?? ''}
                  readOnly={readOnly}
                  onFocus={() => !isFocus(`a${i}.${j}.tds`) && go(`a${i}.${j}.tds`)}
                  onInput={(e) => part(j, { tds: (e.target as HTMLInputElement).value })}
                />
                <span class="bill-net num amt" data-testid="bill-receipt" title="What this bill is settled by: what was received plus the TDS deducted">
                  {(() => {
                    const settled = (toMinor(a.amount) ?? 0n) + (toMinor(a.tds ?? '') ?? 0n);
                    return toMinor(a.amount) === undefined ? '' : formatAmount(settled as never);
                  })()}
                </span>
              </>
            )}
            {!readOnly && (
              <button type="button" class="line-x" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} aria-label={`Remove bill row ${j + 1}`} title="Remove this row (Ctrl+Delete)" onClick={() => removeAlloc(i, j)}>
                ×
              </button>
            )}
          </div>
        ))}
        {bills.length > 0 && (
          <div class="bill-open" data-testid="open-bills">
            Open bills: {bills.slice(0, 4).map((b) => `${b.ref} (${formatAmount(b.pending)}${b.dueDate ? `, due ${formatDate(b.dueDate)}` : ''})`).join(' · ')}
          </div>
        )}
        {tdsTotal > 0n && (
          <div class="bill-tds" data-testid="bill-tds">
            Received {formatAmount((toMinor(l.amount) ?? 0n) as never)} + TDS deducted {formatAmount(tdsTotal as never)} · bills settled by {formatAmount(((toMinor(l.amount) ?? 0n) + tdsTotal) as never)}
          </div>
        )}
        <div class={left === 0n ? 'bill-sum ok' : 'bill-sum'}>{left === 0n ? '✓ Adds up to the line' : left > 0n ? `${formatAmount(left)} still to allocate` : `${formatAmount(-left)} too much`}</div>
        {errorOf(`line.${i}.alloc`)}
      </div>
    );
  };

  // Keys that only make sense in some modes are registered only in those modes, so the bottom bar never offers one that would do nothing.
  const modeHandlers = (
    <ModeHandlers
      switchTo={mode === 'create' ? switchTo : undefined}
      onAlter={mode === 'display' && voucher?.status === 'posted' ? () => app.navigate({ type: 'voucher', mode: 'alter', id: (voucher as Voucher).id }) : undefined}
      onCancel={mode !== 'create' && voucher?.status === 'posted' ? () => setConfirm('cancel') : undefined}
    />
  );

  const fullDay = form.date ? new Date(`${form.date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' }) : '';

  return (
    <section class="screen voucher-screen" aria-labelledby="voucher-title" data-testid="voucher-form" ref={rootRef as never}>
      <h1 id="voucher-title" class="vtitle">
        {title}
        {cancelled && <span class="badge">Cancelled</span>}
      </h1>
      <WindowClose />

      {banner && (
        <p class={banner.tone === 'error' ? 'notice error' : banner.tone === 'note' ? 'notice capture' : 'notice'} role={banner.tone === 'error' ? 'alert' : 'status'} data-testid="voucher-banner">
          {banner.text}
        </p>
      )}
      {general.length > 0 && (
        <p class="notice error" role="alert">
          {general.join(' ')}
        </p>
      )}
      {confirm === 'cancel' && (
        <p class="notice error" role="alert" data-testid="cancel-confirm">
          Cancel voucher {voucher?.number}? It keeps its number but leaves the books. Press <Kbd chord={chord('voucher.accept') ?? 'Ctrl+A'} /> to confirm, <Kbd chord={chord('app.back') ?? 'Esc'} /> to keep it.
        </p>
      )}

      <div class="vhead">
        <span class="vtag" data-testid="voucher-type-tag">{type?.name}</span>
        <span class="vno">
          No. <strong data-testid="voucher-number">{numberText}</strong>
        </span>
        <span class="vspacer" />
        <span class="vday" data-testid="voucher-weekday">{fullDay}</span>
        <input
          data-vf="date"
          class={cls('vdate', 'date', !!issueAt('date'))}
          type="text"
          aria-label="Voucher date"
          readOnly={readOnly}
          autocomplete="off"
          value={dateText}
          onFocus={() => !isFocus('date') && go('date')}
          onInput={(e) => {
            setDateText((e.target as HTMLInputElement).value);
            setFieldErrors((x) => ({ ...x, date: '' }));
          }}
        />
        {errorOf('date')}
      </div>

      {layout === 'single-entry' && (
        <div class={isFocus('account') ? 'vaccount active' : 'vaccount'}>
          <label class="vlabel" for="v-account">
            Account
          </label>
          <div class="vaccount-field">
            <input
              id="v-account"
              data-vf="account"
              class={cls('vcell', 'account', !!issueAt('account'))}
              type="text"
              role="combobox"
              aria-expanded={isFocus('account') && !readOnly}
              readOnly={readOnly}
              autocomplete="off"
              spellcheck={false}
              placeholder="cash or bank"
              value={form.accountLabel}
              onFocus={() => !isFocus('account') && go('account')}
              onInput={(e) => {
                setPick({ index: 0, touched: true });
                setPickerClosed(undefined);
                update((f) => ({ ...f, accountLabel: (e.target as HTMLInputElement).value }));
                setFieldErrors((x) => ({ ...x, account: '' }));
              }}
            />
            {errorOf('account')}
            {pickerList('account')}
          </div>
          {form.accountId !== '' && accountBalance !== undefined && (
            <span class="vbal account-bal" data-testid="account-balance">
              Cur Bal: {balanceText(form.accountId)}
            </span>
          )}
        </div>
      )}

      <div class="vgrid" role="group" aria-label="Entries">
        <div class={journal ? 'vhdr journal' : 'vhdr'}>
          {journal && <span class="vc-side">&nbsp;</span>}
          <span class="vc-ledger">Particulars</span>
          {journal ? (
            <>
              <span class="vc-amount num">Debit</span>
              <span class="vc-amount num">Credit</span>
            </>
          ) : (
            <span class="vc-amount num">Amount</span>
          )}
          <span class="vc-x" />
        </div>
        <div class={journal ? 'vbody journal' : 'vbody'}>{form.lines.map((l, i) => lineRow(l, i))}</div>
        <div class={journal ? 'vtot journal' : 'vtot'}>
          {journal && <span class="vc-side" />}
          <span class="vc-ledger total-label">
            {journal ? (
              <span class={preview.balanced ? 'balance ok' : 'balance'} data-testid="balance-state">
                {preview.debit === 0n && preview.credit === 0n ? '' : preview.debit === preview.credit ? '✓ Debit = Credit' : `Difference ${formatAmount(preview.debit > preview.credit ? preview.debit - preview.credit : preview.credit - preview.debit)}`}
              </span>
            ) : (
              'Total'
            )}
          </span>
          {journal ? (
            <>
              <span class="vc-amount num amt" data-testid="total-debit">{formatAmount(preview.debit)}</span>
              <span class="vc-amount num amt" data-testid="total-credit">{formatAmount(preview.credit)}</span>
            </>
          ) : (
            <span class="vc-amount num amt" data-testid="total-amount">{formatAmount(preview.debit)}</span>
          )}
          <span class="vc-x" />
        </div>
      </div>

      <div class={isFocus('narration') ? 'vnarr active' : 'vnarr'}>
        <label class="vlabel" for="v-narration">
          Narration:
        </label>
        <input
          id="v-narration"
          data-vf="narration"
          class={cls('vcell', 'narration', false)}
          type="text"
          readOnly={readOnly}
          autocomplete="off"
          value={form.narration}
          onFocus={() => !isFocus('narration') && go('narration')}
          onInput={(e) => update((f) => ({ ...f, narration: (e.target as HTMLInputElement).value }))}
        />
      </div>

      {form.partyDetails && (
        <p class="vparty" data-testid="party-summary">
          Party details: {form.partyDetails.mailingName ?? 'entered'}
          {form.partyDetails.gstin ? ` · ${form.partyDetails.gstin}` : ''}
          {form.partyDetails.placeOfSupply ? ` · place of supply ${form.partyDetails.placeOfSupply}` : ''}
        </p>
      )}

      {modeHandlers}
      {!readOnly && <Only scope={SCOPE} command="voucher.changeDate" run={changeDate} />}
      {(!readOnly || confirm === 'cancel') && <Only scope={SCOPE} command="voucher.accept" run={acceptKey} />}
      {!readOnly && mode === 'create' && <Only scope={SCOPE} command="voucher.acceptAndNew" run={acceptAndNew} />}
      {pickerOn && <Only scope={SCOPE} command="master.createInline" run={createInline} />}
      {!readOnly && <Only scope={SCOPE} command="voucher.partyDetails" run={openPartyDetails} />}
      {!readOnly && current.line !== undefined && (form.lines.length > 1 || current.part !== undefined) && <Only scope={SCOPE} command="voucher.removeLine" run={removeLine} />}
      {voucher && (
        <Only
          scope={SCOPE}
          command="voucher.print"
          run={() => {
            const doc = buildPrintDoc();
            if (doc) print.printVoucher(doc);
            return true;
          }}
        />
      )}
      {leave.dialog}
      {createAsking && (
        <ChooseOneDialog
          title="Create what?"
          options={[
            { value: 'ledger', label: 'Ledger', hint: 'an expense, income, tax or other account' },
            { value: 'party', label: 'Customer / Vendor (Party)', hint: 'with its billing and shipping address — its ledger is made for you' },
          ]}
          onDone={(picked) => {
            setCreateAsking(false);
            if (picked === 'ledger') createLedger();
            else if (picked === 'party') createParty();
          }}
        />
      )}
      {partyOpen && (
        <PartyDetailsDialog
          books={books}
          ledgerIds={fresh().lines.map((l) => l.ledgerId)}
          value={form.partyDetails}
          onDone={(details) => {
            setPartyOpen(false);
            if (details !== 'cancel') update((f) => ({ ...f, partyDetails: details }));
          }}
        />
      )}
    </section>
  );
}

/** Registers the keys that belong to one mode only. Renders nothing. */
function ModeHandlers(props: { switchTo?: ((kind: EntryKind) => boolean) | undefined; onAlter?: (() => void) | undefined; onCancel?: (() => void) | undefined }) {
  const { switchTo, onAlter, onCancel } = props;
  return (
    <>
      {switchTo && <SwitchHandlers switchTo={switchTo} />}
      {onAlter && <OneHandler command="master.alter" run={onAlter} />}
      {onCancel && <OneHandler command="voucher.cancel" run={onCancel} />}
    </>
  );
}

function OneHandler({ command, run }: { command: string; run: () => void }) {
  useCommandHandler(SCOPE, command, () => (run(), true));
  return null;
}

function SwitchHandlers({ switchTo }: { switchTo: (kind: EntryKind) => boolean }) {
  useCommandHandler(SCOPE, 'voucher.switch.contra', () => switchTo('contra'));
  useCommandHandler(SCOPE, 'voucher.switch.payment', () => switchTo('payment'));
  useCommandHandler(SCOPE, 'voucher.switch.receipt', () => switchTo('receipt'));
  useCommandHandler(SCOPE, 'voucher.switch.journal', () => switchTo('journal'));
  return null;
}
