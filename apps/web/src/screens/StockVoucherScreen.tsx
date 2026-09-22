import { type EntityDoc, type Frame, searchEntities } from '@minimalerp/command';
import { type Voucher, formatRate, parseQty, parseRate, rateOf, valueOf } from '@minimalerp/domain';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { Only } from '../shell/Only';
import { WindowClose } from '../shell/WindowClose';
import { useIdleOnBlankClick } from '../shell/idle';
import { useCommandHandler, useFrameState, useServices, useSubscriptions } from '../shell/hooks';
import type { ScreenRef, VoucherMode } from '../shell/router';
import { useLeaveGuard } from '../shell/useLeaveGuard';
import { Kbd } from '../ui/Kbd';
import { ListView } from '../ui/ListView';
import { godownWithStock, hiddenItemReason } from '../vouchers/salesModel';
import { defaultDate, fyOf } from '../vouchers/entryHelpers';
import { formatAmount, formatDate, formatQuantity, parseDateInput } from '../vouchers/format';
import {
  type LineValue,
  type StockForm,
  type StockLineForm,
  blankStockForm,
  blankStockLine,
  defaultWarehouse,
  isBlankStock,
  previewStock,
  stockFormFromVoucher,
  trimPlaces,
} from '../vouchers/stockModel';
import type { CreatedMaster } from './MasterFormScreen';
import type { StockDoc } from '../ui/PrintView';

const SCOPE = 'screen:voucher';
const MAX_OPTIONS = 8;

type Kind = 'date' | 'side' | 'item' | 'wh' | 'qty' | 'rate' | 'narration';
interface Field {
  readonly key: string;
  readonly kind: Kind;
  readonly line?: number;
}

/** A problem's cell (`line.2.qty`) → the key of the field that shows it (`l2.qty`). */
const focusKeyOf = (field: string): string => {
  const m = /^line\.(\d+)\.(\w+)$/.exec(field);
  return m ? `l${m[1]}.${m[2]}` : field;
};

/** Date first (F2 only), then each line: In/Out, item, godown, quantity and — for an In — its rate; then the narration. */
function fieldsOf(form: StockForm): Field[] {
  const out: Field[] = [{ key: 'date', kind: 'date' }];
  form.lines.forEach((l, i) => {
    out.push({ key: `l${i}.side`, kind: 'side', line: i }, { key: `l${i}.item`, kind: 'item', line: i }, { key: `l${i}.wh`, kind: 'wh', line: i }, { key: `l${i}.qty`, kind: 'qty', line: i });
    if (l.direction === 'in') out.push({ key: `l${i}.rate`, kind: 'rate', line: i });
  });
  out.push({ key: 'narration', kind: 'narration' });
  return out;
}

interface Option {
  readonly id: string;
  readonly name: string;
  readonly sub: string;
}

interface Props {
  readonly frame: Frame<ScreenRef>;
  readonly books: Books;
  readonly mode: VoucherMode;
  readonly typeId: string;
  readonly voucher: Voucher | undefined;
}

/**
 * The Stock Journal window: stock moving with no accounting effect. The same worksheet as the accounting vouchers — compact header, the
 * entry grid straight under it, narration at the foot, its actions in the panel — with Particulars | Godown | Qty | Rate | Value and a
 * side per line: In (Debit — stock arrives) or Out (Credit — stock leaves). An Out takes its value from the stock, live.
 */
export function StockVoucherEntry({ frame, books, mode, typeId, voucher }: Props) {
  const { app, keymapStore, print } = useServices();
  useSubscriptions(books, keymapStore);
  const masters = books.masters;
  const readOnly = mode === 'display';
  const startForm = (): StockForm =>
    voucher ? stockFormFromVoucher(voucher, masters) : blankStockForm(crypto.randomUUID(), typeId, defaultDate(masters), defaultWarehouse(masters));

  const [form, setFormState] = useFrameState<StockForm>(frame, 'form', startForm());
  const [focusKey, setFocusKey] = useFrameState<string>(frame, 'focus', mode === 'create' ? 'l0.side' : 'date');
  const [dateText, setDateText] = useFrameState<string>(frame, 'dateText', formatDate(form.date));
  const [showErrors, setShowErrors] = useFrameState<boolean>(frame, 'showErrors', false);
  const [pick, setPick] = useState({ index: 0, touched: false });
  const [pickerClosed, setPickerClosed] = useState<string | undefined>(undefined);
  const [banner, setBanner] = useState<{ text: string; tone: 'error' | 'ok' | 'note' } | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<'cancel' | undefined>(undefined);
  const leave = useLeaveGuard('This stock journal has not been saved.');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Clicking blank space deactivates the active field until a field is clicked or a key pressed. */
  const { idle, wake } = useIdleOnBlankClick(rootRef);
  const draftReady = useRef(mode !== 'create');

  const type = masters.voucherType(form.typeId as never);
  const fields = fieldsOf(form);
  const at = Math.max(0, fields.findIndex((f) => f.key === focusKey));
  const current = fields[at] as Field;

  const fresh = (): StockForm => (frame.state.get('form') as StockForm | undefined) ?? form;
  const update = (fn: (f: StockForm) => StockForm) => setFormState(fn(fresh()));
  const setLine = (i: number, patch: Partial<StockLineForm>) => update((f) => ({ ...f, lines: f.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) }));

  // ---- drafts: a half-entered stock journal survives a reload ----
  const draftKey = `stock:${form.typeId}`;

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
      const d = saved as StockForm | undefined;
      if (d && isBlankStock(fresh()) && d.typeId === typeId && Array.isArray(d.lines)) {
        setFormState(d);
        setDateText(formatDate(d.date));
      }
      draftReady.current = true;
    });
  }, []);
  useEffect(() => {
    if (mode !== 'create' || !draftReady.current) return;
    const t = setTimeout(() => void (isBlankStock(form) ? books.clearDraft(draftKey) : books.saveDraft(draftKey, form)), 350);
    return () => clearTimeout(t);
  }, [form]);

  // ---- the stock without this voucher (what its own lines are checked and shown against), and the engine's verdict ----
  const base = useMemo(() => books.stock.withChange({ remove: [form.id as never] }), [books.stock, form.id]);
  const preview = useMemo(() => previewStock(form, masters, books.stock), [form, masters, books.stock]);
  /** The posted voucher as a plain movement document — every value comes from `preview.values`, the same figure the screen shows. */
  const buildPrintDoc = (): StockDoc | undefined => {
    if (!voucher || !type) return undefined;
    const lines = form.lines
      .map((l, i) => ({ l, value: preview.values.get(i) }))
      .filter((x): x is { l: StockLineForm; value: LineValue } => x.l.itemId !== '' && x.value !== undefined)
      .map(({ l, value }) => {
        const item = masters.stockItem(l.itemId as never);
        const decimals = item ? (masters.unit(item.unitId)?.decimals ?? 0) : 0;
        const q = parseQty(l.qty.trim());
        return {
          direction: l.direction,
          item: l.itemLabel,
          warehouse: l.warehouseLabel,
          qty: q !== undefined ? `${formatQuantity(q, decimals)} ${masters.unit(item?.unitId as never)?.symbol ?? ''}`.trim() : l.qty,
          value: value.value,
        };
      });
    return { kind: 'stock', docTitle: type.name, number: voucher.number, date: voucher.date, lines, narration: form.narration || undefined };
  };
  const issueAt = (key: string): string | undefined => fieldErrors[key] || (showErrors ? preview.issues.find((i) => i.field === key)?.message : undefined);
  const general = showErrors ? preview.issues.filter((i) => i.field === 'general').map((i) => i.message) : [];

  // ---- focus ----
  useEffect(() => {
    if (idle) return;
    const el = rootRef.current?.querySelector<HTMLInputElement>(`[data-vf="${current.key}"]`);
    el?.focus();
    if (el && el.type === 'text') el.select();
  }, [focusKey, mode, form.lines.length, idle]);
  const go = (key: string) => {
    wake();
    setPick({ index: 0, touched: false });
    setPickerClosed(undefined);
    setFocusKey(key);
  };
  const nextKey = (from = at): string | undefined => fields[from + 1]?.key;
  const prevKey = (from = at): string | undefined => fields[from - 1]?.key;

  // ---- pickers: stock items and godowns ----
  const itemOptions: Option[] = useMemo(
    () =>
      masters.stockItems
        .filter((i) => i.isActive && i.itemType !== 'service')
        .map((i) => ({ id: i.id, name: i.name, sub: [masters.unit(i.unitId)?.symbol, i.code].filter(Boolean).join(' · ') }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [masters],
  );
  const godownOptions: Option[] = useMemo(() => masters.warehouses.filter((w) => w.isActive).map((w) => ({ id: w.id, name: w.name, sub: '' })), [masters]);

  const line = current.line !== undefined ? form.lines[current.line] : undefined;
  const pickerKind: 'item' | 'wh' | undefined = current.kind === 'item' || current.kind === 'wh' ? current.kind : undefined;
  const options = pickerKind === 'item' ? itemOptions : pickerKind === 'wh' ? godownOptions : [];
  const pickerOn = !readOnly && pickerKind !== undefined;
  const typedLabel = pickerKind === 'item' ? (line?.itemLabel ?? '') : pickerKind === 'wh' ? (line?.warehouseLabel ?? '') : '';
  const storedId = pickerKind === 'item' ? (line?.itemId ?? '') : pickerKind === 'wh' ? (line?.warehouseId ?? '') : '';
  const storedName = options.find((o) => o.id === storedId)?.name ?? '';
  const pickerDismissed = pickerClosed !== undefined && pickerClosed === current.key;
  const hits: Option[] = useMemo(() => {
    if (!pickerOn) return [];
    const typed = typedLabel.trim();
    if (typed === '' || typed === storedName) return []; // a list opens when something is typed, and offers only what matches
    const docs: EntityDoc[] = options.map((o) => ({ key: o.id, kind: '', scope: 'v', title: o.name, subtitle: o.sub, commandId: '', args: o.id }));
    return searchEntities(docs, typed, { limit: MAX_OPTIONS }).map((h) => options.find((o) => o.id === h.key) as Option);
  }, [pickerOn, options, typedLabel, storedName]);
  const pickIndex = Math.min(pick.index, Math.max(0, hits.length - 1));

  /** What the book holds of an item on the voucher's date, said the way a person reads it: "120 Kg @ ₹58.00". */
  const stockOf = (itemId: string): { qty: string; rate: string | undefined } | undefined => {
    const item = masters.stockItem(itemId as never);
    if (!item) return undefined;
    const unit = masters.unit(item.unitId);
    const pos = base.positionAt(item.id, form.date as never);
    const r = rateOf(pos.value, pos.qty);
    return { qty: `${formatQuantity(pos.qty, unit?.decimals ?? 0)} ${unit?.symbol ?? ''}`.trim(), rate: r === undefined ? undefined : trimPlaces(formatRate(r)) };
  };

  /** Which godowns hold an item on the voucher's date, and how much: "Main Location 50". */
  const heldIn = (itemId: string): string => {
    const item = masters.stockItem(itemId as never);
    const decimals = (item ? masters.unit(item.unitId)?.decimals : 0) ?? 0;
    return masters.warehouses
      .filter((w) => w.isActive)
      .map((w) => ({ name: w.name, q: base.qtyAt(itemId as never, w.id, form.date as never) }))
      .filter((w) => w.q > 0n)
      .map((w) => `${w.name} ${formatQuantity(w.q, decimals)}`)
      .join(', ');
  };

  const choose = (o: Option, f: Field = current) => {
    if (f.line === undefined) return;
    if (f.kind === 'item') {
      const l = fresh().lines[f.line] as StockLineForm;
      // an In takes its rate from what the stock costs now (editable): most receipts and transfers are at cost
      const s = stockOf(o.id);
      // an Out starts in the godown that HOLDS the item (the line's own godown if it does)
      const from = l.direction === 'out' ? godownWithStock(masters, base, o.id, fresh().date, l.warehouseId === '' ? undefined : { id: l.warehouseId, label: l.warehouseLabel }) : undefined;
      setLine(f.line, {
        itemId: o.id,
        itemLabel: o.name,
        ...(l.direction === 'in' && l.rate.trim() === '' && s?.rate ? { rate: s.rate } : {}),
        ...(from && from.id !== l.warehouseId ? { warehouseId: from.id, warehouseLabel: from.label } : {}),
      });
      setFieldErrors((e) => ({ ...e, [`line.${f.line}.item`]: '' }));
    } else if (f.kind === 'wh') {
      setLine(f.line, { warehouseId: o.id, warehouseLabel: o.name });
      setFieldErrors((e) => ({ ...e, [`line.${f.line}.wh`]: '' }));
    }
  };

  const movePick = (delta: number): boolean => {
    if (!pickerOn || hits.length === 0) return false;
    setPick({ index: (pickIndex + delta + hits.length) % hits.length, touched: true });
    return true;
  };

  /** Leaves the current field: resolves a half-typed item/godown, reads a typed date. False (with a message) if it cannot be left. */
  const settle = (): boolean => {
    if (readOnly) return true;
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
    if (pickerOn && current.line !== undefined) {
      const typed = typedLabel.trim();
      const choice = hits[pickIndex];
      const idKey = pickerKind === 'item' ? 'itemId' : 'warehouseId';
      const labelKey = pickerKind === 'item' ? 'itemLabel' : 'warehouseLabel';
      if (pick.touched && choice) {
        choose(choice);
        return true;
      }
      if (typed === '') {
        if (storedId !== '') setLine(current.line, { [idKey]: '', [labelKey]: '' });
        return true;
      }
      if (typed === storedName) return true;
      if (choice) {
        choose(choice);
        return true;
      }
      setFieldErrors((e) => ({ ...e, [`line.${current.line}.${pickerKind === 'item' ? 'item' : 'wh'}`]: 'No match — press Alt+C to create it' }));
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

  const addLine = (afterIndex: number) => {
    const f = fresh();
    const previous = f.lines[afterIndex] as StockLineForm;
    // the other side than the line above: a transfer or a conversion is an Out and then an In
    const added = blankStockLine(previous.direction === 'out' ? 'in' : 'out', defaultWarehouse(masters));
    update((x) => ({ ...x, lines: [...x.lines.slice(0, afterIndex + 1), added, ...x.lines.slice(afterIndex + 1)] }));
    go(`l${afterIndex + 1}.side`);
  };

  const finishLine = (i: number) => {
    if (i + 1 < fresh().lines.length) go(`l${i + 1}.side`);
    else addLine(i);
  };

  const enter = (): boolean => {
    if (readOnly) return next();
    if (current.kind === 'narration') {
      void accept();
      return true;
    }
    if (current.kind === 'side' && current.line !== undefined) {
      go(`l${current.line}.item`);
      return true;
    }
    if (current.kind === 'item' && current.line !== undefined) {
      const f = fresh();
      const l = f.lines[current.line] as StockLineForm;
      const i = current.line;
      // Enter on an empty item of the last line means "that is all the lines": drop it and go to the narration.
      if (i > 0 && i === f.lines.length - 1 && l.itemId === '' && l.itemLabel.trim() === '' && l.qty.trim() === '') {
        update((x) => ({ ...x, lines: x.lines.slice(0, -1) }));
        go('narration');
        return true;
      }
    }
    if (!settle()) return true;
    if (current.kind === 'qty' && current.line !== undefined) {
      const l = fresh().lines[current.line] as StockLineForm;
      if (l.direction === 'in') go(`l${current.line}.rate`);
      else finishLine(current.line);
      return true;
    }
    if (current.kind === 'rate' && current.line !== undefined) {
      finishLine(current.line);
      return true;
    }
    const k = nextKey();
    if (k) go(k);
    return true;
  };

  const flipSide = (): boolean => {
    if (current.kind !== 'side' || current.line === undefined) return false;
    const l = fresh().lines[current.line] as StockLineForm;
    setLine(current.line, { direction: l.direction === 'in' ? 'out' : 'in', ...(l.direction === 'out' ? {} : { rate: '' }) });
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
    if (flipSide()) return true;
    if (pickerOn && pickerDismissed) return (setPickerClosed(undefined), true);
    return pickerOn && hits.length > 0 ? movePick(1) : next();
  });
  useCommandHandler(SCOPE, 'nav.up', () => {
    if (flipSide()) return true;
    if (pickerOn && hits.length > 0 && !pickerDismissed) return movePick(-1);
    const k = prevKey();
    if (k) go(k);
    return true;
  });
  useCommandHandler(SCOPE, 'nav.activate', enter);

  const changeDate = () => {
    go('date');
    return true;
  };
  const removeLine = () => {
    if (readOnly || current.line === undefined || fresh().lines.length < 2) return false;
    removeAt(current.line);
    return true;
  };
  /** Takes line `i` out (the × on its row, or Ctrl+Delete). The only line is emptied instead, so there is always one to type in. */
  const removeAt = (i: number) => {
    if (readOnly) return;
    if (fresh().lines.length < 2) {
      update((f) => ({ ...f, lines: [blankStockLine('out', defaultWarehouse(masters))] }));
      go('l0.side');
      return;
    }
    update((f) => ({ ...f, lines: f.lines.filter((_, k) => k !== i) }));
    go(`l${Math.max(0, i - 1)}.side`);
  };
  const createInline = (): boolean => {
    if (readOnly || !pickerOn || pickerKind === undefined) return false;
    const f = current;
    void app
      .navigateForResult<CreatedMaster>({
        type: 'master',
        kind: pickerKind === 'item' ? 'stockItem' : 'warehouse',
        mode: 'create',
        seed: typedLabel.trim() === '' ? {} : { name: typedLabel.trim() },
        inline: true,
      })
      .then((created) => {
        if (created) choose({ id: created.id, name: created.name, sub: '' }, f);
      });
    return true;
  };

  const dirty = mode !== 'display' && (mode === 'create' ? !isBlankStock(form) : JSON.stringify(form) !== JSON.stringify(stockFormFromVoucher(voucher as Voucher, masters)));

  /**
   * Esc closes ONE thing per press, innermost first: the question being asked (Cancel voucher) → an open popup list → the field being edited
   * (back to the previous field, dropping what was typed but not chosen) → and only from the first field the window itself (which asks
   * "Close and leave?" if anything is entered).
   */
  useCommandHandler(SCOPE, 'app.back', () => {
    if (confirm === 'cancel') {
      setConfirm(undefined);
      return true;
    }
    if (pickerOn && !pickerDismissed && (hits.length > 0 || typedLabel.trim() !== '')) {
      setPickerClosed(current.key);
      return true;
    }
    if (mode !== 'display') {
      const previous = current.kind === 'date' ? fields[1]?.key : prevKey() === 'date' ? undefined : prevKey();
      if (previous !== undefined) {
        if (pickerOn && current.line !== undefined && typedLabel.trim() !== storedName) {
          setLine(current.line, pickerKind === 'item' ? { itemLabel: storedName } : { warehouseLabel: storedName });
        }
        go(previous);
        if (previous.endsWith('.item') || previous.endsWith('.wh')) setPickerClosed(previous);
        return true;
      }
    }
    if (dirty) {
      leave.ask();
      return true;
    }
    return false;
  });
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
    const p = preview;
    if (!p.ok) {
      const first = p.issues.find((i) => i.field !== 'general');
      if (first) go(focusKeyOf(first.field));
      return;
    }
    setBusy(true);
    try {
      const r = mode === 'alter' && voucher ? await books.alter(voucher.id, voucher.version, p.draft) : await books.post(p.draft);
      if (!r.ok) {
        const first = r.issues[0];
        setBanner({ text: first?.message ?? 'The stock journal was refused', tone: 'error' });
        return;
      }
      if (mode === 'alter') {
        app.back();
        return;
      }
      await books.clearDraft(draftKey);
      // Saved: the window closes back to where it was opened from, handing over what it made (a voucher list highlights it). "Save and new" (Alt+N) stays instead.
      if (closeAfter) {
        app.back({ id: r.value.voucher.id, number: r.value.voucher.number, typeName: type?.name ?? 'Voucher' });
        return;
      }
      // ready for the next one: same type and date, fresh lines
      const date = fresh().date;
      setFormState(blankStockForm(crypto.randomUUID(), form.typeId, date, defaultWarehouse(masters)));
      setShowErrors(false);
      setFieldErrors({});
      setBanner({ text: `${type?.name ?? 'Stock Journal'} ${r.value.voucher.number} saved.`, tone: 'ok' });
      go('l0.side');
    } finally {
      setBusy(false);
    }
  };
  const cancelVoucher = async (): Promise<void> => {
    if (!voucher || busy) return;
    setBusy(true);
    try {
      const r = await books.cancel(voucher.id, voucher.version);
      setConfirm(undefined);
      if (!r.ok) setBanner({ text: r.issues[0]?.message ?? 'It could not be cancelled', tone: 'error' });
      else app.back();
    } finally {
      setBusy(false);
    }
  };
  const acceptAndNew = (): boolean => {
    if (readOnly || mode !== 'create') return false;
    void accept(false);
    return true;
  };
  const acceptKey = (): boolean => {
    if (confirm === 'cancel') {
      void cancelVoucher();
      return true;
    }
    if (readOnly) return false;
    void accept();
    return true;
  };

  // ---- rendering ----
  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];
  const errorOf = (key: string) => {
    const m = issueAt(key);
    return m ? (
      <span class="field-error" role="alert">
        {m}
      </span>
    ) : null;
  };
  const isFocus = (key: string) => !idle && key === current.key;
  const cls = (base: string, key: string) => `${base}${isFocus(key) ? ' active' : ''}${issueAt(key) ? ' invalid' : ''}`;
  const numberText = voucher ? voucher.number : 'assigned on save';
  const title = mode === 'create' ? `New ${type?.name ?? 'Stock Journal'} Voucher` : `${mode === 'alter' ? 'Alter' : 'Display'} ${type?.name ?? ''} ${voucher?.number ?? ''}`;
  const cancelled = voucher?.status === 'cancelled';
  const fullDay = form.date ? new Date(`${form.date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' }) : '';

  const pickerList = (key: string) =>
    isFocus(key) && pickerOn && !pickerDismissed && hits.length > 0 ? (
      <div class="picker" data-testid="picker">
        <ListView
          items={hits}
          index={pickIndex}
          itemKey={(o) => o.id}
          label={pickerKind === 'item' ? 'Stock items' : 'Godowns'}
          onActivate={(n) => {
            const o = hits[n];
            if (o) choose(o);
          }}
          renderItem={(o) => (
            <>
              <span class="row-title">{o.name}</span>
              <span class="row-desc">{o.sub}</span>
              {pickerKind === 'item' && <span class="row-meta amt">{stockOf(o.id)?.qty}</span>}
            </>
          )}
        />
      </div>
    ) : isFocus(key) && pickerOn && !pickerDismissed && typedLabel.trim() !== '' && typedLabel.trim() !== storedName ? (
      <div class="picker picker-empty" data-testid="picker">
        No match — <Kbd chord={chord('master.createInline') ?? 'Alt+C'} /> creates “{typedLabel.trim()}”
        {pickerKind === 'item' && hiddenItemReason(masters, typedLabel) && <div data-testid="hidden-item">{hiddenItemReason(masters, typedLabel)}</div>}
      </div>
    ) : null;

  const lineRow = (l: StockLineForm, i: number) => {
    const s = l.itemId !== '' ? stockOf(l.itemId) : undefined;
    const worth = preview.values.get(i);
    const typedValue = l.direction === 'in' && parseQty(l.qty.trim()) !== undefined && parseRate(l.rate.trim()) !== undefined ? valueOf(parseQty(l.qty.trim()) as never, parseRate(l.rate.trim()) as never) : undefined;
    const value = worth?.value ?? typedValue;
    return (
      <div key={`l${i}`} class={!idle && current.line === i ? 'vrow stock-row active' : 'vrow stock-row'}>
        <div class="vc-side">
          <input
            data-vf={`l${i}.side`}
            class={cls('vcell side', `l${i}.side`)}
            type="text"
            aria-label={`Line ${i + 1} In or Out`}
            readOnly={readOnly}
            value={l.direction === 'in' ? 'In' : 'Out'}
            onFocus={() => !isFocus(`l${i}.side`) && go(`l${i}.side`)}
            onInput={(e) => setLine(i, { direction: /i/i.test((e.target as HTMLInputElement).value.slice(-1)) ? 'in' : 'out' })}
          />
        </div>
        <div class="vc-ledger">
          <input
            data-vf={`l${i}.item`}
            class={cls('vcell', `l${i}.item`)}
            type="text"
            role="combobox"
            aria-label={`Line ${i + 1} stock item`}
            aria-expanded={isFocus(`l${i}.item`) && !readOnly}
            readOnly={readOnly}
            autocomplete="off"
            spellcheck={false}
            value={l.itemLabel}
            onFocus={() => !isFocus(`l${i}.item`) && go(`l${i}.item`)}
            onInput={(e) => {
              setPick({ index: 0, touched: true });
              setPickerClosed(undefined);
              setLine(i, { itemLabel: (e.target as HTMLInputElement).value });
              setFieldErrors((x) => ({ ...x, [`line.${i}.item`]: '' }));
            }}
          />
          {errorOf(`line.${i}.item`)}
          {s && !isFocus(`l${i}.item`) && (
            <div class="vbal" data-testid="stock-note">
              Stock: {s.qty}
              {s.rate ? ` @ ₹${s.rate}` : ''}
              {heldIn(l.itemId) !== '' ? ` · in ${heldIn(l.itemId)}` : ''}
            </div>
          )}
          {pickerList(`l${i}.item`)}
        </div>
        <div class="vc-godown">
          <input
            data-vf={`l${i}.wh`}
            class={cls('vcell', `l${i}.wh`)}
            type="text"
            role="combobox"
            aria-label={`Line ${i + 1} godown`}
            aria-expanded={isFocus(`l${i}.wh`) && !readOnly}
            readOnly={readOnly}
            autocomplete="off"
            spellcheck={false}
            value={l.warehouseLabel}
            onFocus={() => !isFocus(`l${i}.wh`) && go(`l${i}.wh`)}
            onInput={(e) => {
              setPick({ index: 0, touched: true });
              setPickerClosed(undefined);
              setLine(i, { warehouseLabel: (e.target as HTMLInputElement).value });
              setFieldErrors((x) => ({ ...x, [`line.${i}.wh`]: '' }));
            }}
          />
          {errorOf(`line.${i}.wh`)}
          {pickerList(`l${i}.wh`)}
        </div>
        <div class="vc-qty">
          <input
            data-vf={`l${i}.qty`}
            class={cls('vcell num', `l${i}.qty`)}
            type="text"
            inputMode="decimal"
            aria-label={`Line ${i + 1} quantity`}
            readOnly={readOnly}
            autocomplete="off"
            value={l.qty}
            onFocus={() => !isFocus(`l${i}.qty`) && go(`l${i}.qty`)}
            onInput={(e) => {
              setLine(i, { qty: (e.target as HTMLInputElement).value });
              setFieldErrors((x) => ({ ...x, [`line.${i}.qty`]: '' }));
            }}
          />
          {errorOf(`line.${i}.qty`)}
        </div>
        <div class="vc-rate">
          {l.direction === 'in' ? (
            <>
              <input
                data-vf={`l${i}.rate`}
                class={cls('vcell num', `l${i}.rate`)}
                type="text"
                inputMode="decimal"
                aria-label={`Line ${i + 1} rate`}
                readOnly={readOnly}
                autocomplete="off"
                value={l.rate}
                onFocus={() => !isFocus(`l${i}.rate`) && go(`l${i}.rate`)}
                onInput={(e) => {
                  setLine(i, { rate: (e.target as HTMLInputElement).value });
                  setFieldErrors((x) => ({ ...x, [`line.${i}.rate`]: '' }));
                }}
              />
              {errorOf(`line.${i}.rate`)}
            </>
          ) : (
            <span class="vcell num derived" data-testid="out-rate" aria-label={`Line ${i + 1} rate (from the stock)`}>
              {worth?.rate === undefined ? '' : trimPlaces(formatRate(worth.rate))}
            </span>
          )}
        </div>
        <div class="vc-value num amt" data-testid="line-value">
          {value === undefined ? '' : formatAmount(value)}
        </div>
        <div class="vc-x">
          {!readOnly && (
            <button type="button" class="line-x" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} aria-label={`Remove line ${i + 1}`} title="Remove this line (Ctrl+Delete)" onClick={() => removeAt(i)}>
              ×
            </button>
          )}
        </div>
      </div>
    );
  };

  const modeHandlers = (
    <>
      {!readOnly && <Only scope={SCOPE} command="voucher.changeDate" run={changeDate} />}
      {(!readOnly || confirm === 'cancel') && <Only scope={SCOPE} command="voucher.accept" run={acceptKey} />}
      {!readOnly && mode === 'create' && <Only scope={SCOPE} command="voucher.acceptAndNew" run={acceptAndNew} />}
      {pickerOn && <Only scope={SCOPE} command="master.createInline" run={createInline} />}
      {!readOnly && current.line !== undefined && form.lines.length > 1 && <Only scope={SCOPE} command="voucher.removeLine" run={removeLine} />}
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
      {mode === 'display' && voucher?.status === 'posted' && (
        <Only scope={SCOPE} command="master.alter" run={() => (app.navigate({ type: 'voucher', mode: 'alter', id: voucher.id }), true)} />
      )}
      {mode !== 'create' && voucher?.status === 'posted' && <Only scope={SCOPE} command="voucher.cancel" run={() => (setConfirm('cancel'), true)} />}
    </>
  );

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
          class={cls('vdate', 'date')}
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

      <div class="vgrid" role="group" aria-label="Entries">
        <div class="vhdr stock-row">
          <span class="vc-side">&nbsp;</span>
          <span class="vc-ledger">Particulars</span>
          <span class="vc-godown">Godown</span>
          <span class="vc-qty num">Qty</span>
          <span class="vc-rate num">Rate</span>
          <span class="vc-value num">Value</span>
          <span class="vc-x" />
        </div>
        <div class="vbody stock">{form.lines.map((l, i) => lineRow(l, i))}</div>
        <div class="vtot stock-row">
          <span class="vc-side" />
          <span class="vc-ledger total-label">Total</span>
          <span class="vc-godown" />
          <span class="vc-qty" />
          <span class="vc-rate num">
            In <span class="amt" data-testid="total-in">{formatAmount(preview.valueIn)}</span>
          </span>
          <span class="vc-value num">
            Out <span class="amt" data-testid="total-out">{formatAmount(preview.valueOut)}</span>
          </span>
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
          class={cls('vcell', 'narration')}
          type="text"
          readOnly={readOnly}
          autocomplete="off"
          value={form.narration}
          onFocus={() => !isFocus('narration') && go('narration')}
          onInput={(e) => update((f) => ({ ...f, narration: (e.target as HTMLInputElement).value }))}
        />
      </div>

      {modeHandlers}
      {leave.dialog}
    </section>
  );
}
