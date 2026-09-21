import {
  type Masters,
  type Money,
  type Rate,
  type StockBook,
  type Voucher,
  type VoucherKindRegistry,
  defaultVoucherKinds,
  isQtyText,
  parseQty,
  parseRate,
  prepareVoucher,
  rateOf,
} from '@minimalerp/domain';

/**
 * The Stock Journal form as the screen holds it: plain strings, so it can live in the screen-stack frame and be saved as a draft. Pure,
 * like the accounting form model — turning the form into the draft the engine takes, previewing it with the SAME engine the server runs
 * (against the company's stock, so "not enough stock" appears as you type), and putting every problem on the exact cell.
 */

export type StockDirectionForm = 'in' | 'out';

export interface StockLineForm {
  direction: StockDirectionForm;
  itemId: string;
  /** What the item field shows (its name, or what is being typed). */
  itemLabel: string;
  warehouseId: string;
  warehouseLabel: string;
  qty: string;
  /** In lines only: what one unit cost. An Out takes its value from the stock. */
  rate: string;
}

export interface StockForm {
  /** Generated once per form, so pressing accept twice cannot post twice (it is the voucher's idempotency key). */
  id: string;
  typeId: string;
  date: string;
  narration: string;
  lines: StockLineForm[];
}

export const blankStockLine = (direction: StockDirectionForm, warehouse?: { id: string; label: string }): StockLineForm => ({
  direction,
  itemId: '',
  itemLabel: '',
  warehouseId: warehouse?.id ?? '',
  warehouseLabel: warehouse?.label ?? '',
  qty: '',
  rate: '',
});

export const blankStockForm = (id: string, typeId: string, date: string, warehouse?: { id: string; label: string }): StockForm => ({
  id,
  typeId,
  date,
  narration: '',
  // a stock journal usually starts with what leaves (a transfer, a conversion): the first line is an Out
  lines: [blankStockLine('out', warehouse)],
});

/** The main godown: the first active one, which a new line starts in. */
export const defaultWarehouse = (masters: Masters): { id: string; label: string } | undefined => {
  const w = masters.warehouses.find((x) => x.isActive);
  return w ? { id: w.id, label: w.name } : undefined;
};

const isEmptyLine = (l: StockLineForm): boolean => l.itemId === '' && l.itemLabel.trim() === '' && l.qty.trim() === '' && l.rate.trim() === '';

/** True when nothing has been entered: no item, quantity or rate on any line, and no narration. (A default godown or direction is not "entered".) */
export const isBlankStock = (form: StockForm): boolean => form.lines.every(isEmptyLine) && form.narration.trim() === '';

// ---- form → draft ------------------------------------------------------------------------------------------------

export interface BuiltStockDraft {
  readonly draft: Record<string, unknown>;
  /** kept[i] = the form line index of draft entry i (empty lines are left out, so indexes shift). */
  readonly kept: readonly number[];
}

export function formToStockDraft(form: StockForm): BuiltStockDraft {
  const kept: number[] = [];
  form.lines.forEach((l, i) => {
    if (!isEmptyLine(l)) kept.push(i);
  });
  const entries = kept.map((i) => {
    const l = form.lines[i] as StockLineForm;
    return {
      itemId: l.itemId,
      warehouseId: l.warehouseId,
      direction: l.direction,
      qty: l.qty.trim(),
      ...(l.direction === 'in' && l.rate.trim() !== '' ? { rate: l.rate.trim() } : {}),
    };
  });
  return {
    draft: {
      id: form.id,
      voucherTypeId: form.typeId,
      date: form.date,
      ...(form.narration.trim() !== '' ? { narration: form.narration.trim() } : {}),
      entries,
    },
    kept,
  };
}

// ---- preview -----------------------------------------------------------------------------------------------------

export type StockFieldKey = 'date' | 'narration' | 'general' | `line.${number}.${'side' | 'item' | 'wh' | 'qty' | 'rate'}`;
export interface StockFormIssue {
  readonly field: StockFieldKey;
  readonly message: string;
  readonly code?: string | undefined;
}

/** What a line is worth, as the book reads it: an In's entered value, an Out's share of the item's running average. */
export interface LineValue {
  readonly value: Money;
  readonly rate: Rate | undefined;
}

export interface StockPreview {
  readonly ok: boolean;
  readonly issues: readonly StockFormIssue[];
  readonly draft: Record<string, unknown>;
  /** By form line index; present only when the engine accepts the voucher. */
  readonly values: ReadonlyMap<number, LineValue>;
  readonly valueIn: bigint;
  readonly valueOut: bigint;
}

const LEAF: Readonly<Record<string, 'item' | 'wh' | 'qty' | 'rate'>> = { itemId: 'item', warehouseId: 'wh', qty: 'qty', rate: 'rate', direction: 'qty' };

/** `entries.2.qty` → line 2's quantity cell; `date` → the date; anything unrecognised → the whole voucher. */
export function fieldOfStockPath(path: string | undefined, kept: readonly number[]): StockFieldKey {
  if (path === undefined || path === '') return 'general';
  const parts = path.split('.');
  if (parts[0] === 'date') return 'date';
  if (parts[0] === 'narration') return 'narration';
  if (parts[0] === 'entries' && parts[1] !== undefined && /^\d+$/.test(parts[1])) {
    const formIndex = kept[Number(parts[1])];
    const leaf = LEAF[parts[2] ?? ''];
    if (formIndex !== undefined && leaf) return `line.${formIndex}.${leaf}`;
  }
  return 'general';
}

/** Problems a person can see without asking the engine — said kindly, on the right cell. */
function localIssues(form: StockForm, kept: readonly number[]): StockFormIssue[] {
  const out: StockFormIssue[] = [];
  for (const i of kept) {
    const l = form.lines[i] as StockLineForm;
    if (l.itemId === '') out.push({ field: `line.${i}.item`, message: 'Choose a stock item' });
    if (l.warehouseId === '') out.push({ field: `line.${i}.wh`, message: 'Choose a godown' });
    if (l.qty.trim() === '') out.push({ field: `line.${i}.qty`, message: 'Enter a quantity' });
    else if (!isQtyText(l.qty.trim())) out.push({ field: `line.${i}.qty`, message: 'That is not a quantity (like 10 or 2.5)' });
    if (l.direction === 'in') {
      if (l.rate.trim() === '') out.push({ field: `line.${i}.rate`, message: 'Enter the rate (0 for a free issue)' });
      else if (parseRate(l.rate.trim()) === undefined) out.push({ field: `line.${i}.rate`, message: 'That is not a rate (like 58 or 58.25)' });
    }
  }
  if (kept.length === 0) out.push({ field: 'general', message: 'Enter at least one line' });
  return out;
}

/**
 * The engine's verdict on the form as it stands, with each problem placed on its cell. `stock` is the company's stock INCLUDING this voucher
 * if it is being altered (its own movements are taken out first, as the server does).
 */
export function previewStock(form: StockForm, masters: Masters, stock: StockBook, registry: VoucherKindRegistry = defaultVoucherKinds()): StockPreview {
  const { draft, kept } = formToStockDraft(form);
  const none: ReadonlyMap<number, LineValue> = new Map();

  const local = localIssues(form, kept);
  if (local.length > 0) return { ok: false, issues: local, draft, values: none, valueIn: 0n, valueOut: 0n };

  const base = stock.withChange({ remove: [form.id as never] });
  const result = prepareVoucher(draft, masters, registry, base);
  if (!result.ok) {
    return {
      ok: false,
      issues: result.issues.map((i) => ({ field: fieldOfStockPath(i.path, kept), message: i.message, code: i.code })),
      draft,
      values: none,
      valueIn: 0n,
      valueOut: 0n,
    };
  }

  // What each line is worth: read it back from the book with this voucher in it.
  const after = base.withChange({ add: result.value.plan.stock });
  const values = new Map<number, LineValue>();
  let valueIn = 0n;
  let valueOut = 0n;
  for (const m of result.value.plan.stock) {
    const step = after.steps(m.itemId).find((s) => s.movement.voucherId === m.voucherId && s.movement.lineNo === m.lineNo);
    const formIndex = kept[m.lineNo - 1];
    if (!step || formIndex === undefined) continue;
    values.set(formIndex, { value: step.value, rate: rateOf(step.value, m.qty) });
    if (m.direction === 'in') valueIn += step.value;
    else valueOut += step.value;
  }
  return { ok: true, issues: [], draft, values, valueIn, valueOut };
}

// ---- voucher → form (display / alter) ---------------------------------------------------------------------------

export function stockFormFromVoucher(voucher: Voucher, masters: Masters): StockForm {
  const c = voucher.content as unknown as {
    narration?: string;
    entries?: { itemId: string; warehouseId: string; direction: StockDirectionForm; qty: string; rate?: string }[];
    itemId?: string;
    warehouseId?: string;
    qty?: string;
    rate?: string;
  };
  const item = (id: string) => masters.stockItem(id as never)?.name ?? '';
  const godown = (id: string) => masters.warehouse(id as never)?.name ?? '';
  // Opening stock is one In; a Stock Journal has entries.
  const entries = c.entries ?? (c.itemId ? [{ itemId: c.itemId, warehouseId: c.warehouseId ?? '', direction: 'in' as const, qty: c.qty ?? '', rate: c.rate }] : []);
  const shown = (t: string | undefined): string => {
    const q = t === undefined ? undefined : parseQty(t);
    return t === undefined || q === undefined ? (t ?? '') : trimPlaces(t);
  };
  return {
    id: voucher.id,
    typeId: voucher.voucherTypeId,
    date: voucher.date,
    narration: c.narration ?? '',
    lines:
      entries.length > 0
        ? entries.map((e) => ({
            direction: e.direction,
            itemId: e.itemId,
            itemLabel: item(e.itemId),
            warehouseId: e.warehouseId,
            warehouseLabel: godown(e.warehouseId),
            qty: shown(e.qty),
            rate: e.rate === undefined ? '' : trimPlaces(e.rate),
          }))
        : [blankStockLine('out')],
  };
}

/** "10.0000" → "10", "2.5000" → "2.5", "58.2500" → "58.25": the way a person would have typed it. */
export function trimPlaces(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

