import { type EntityDoc, searchEntities } from '@minimalerp/command';
import { type Voucher, formatVoucherNumber } from '@minimalerp/domain';
import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import type { Books } from '../../books/books';
import { useServices } from '../../shell/hooks';
import type { VoucherMode } from '../../shell/router';
import { fyOf } from '../entryHelpers';
import { Kbd } from '../../ui/Kbd';
import { ListView } from '../../ui/ListView';
import type { VoucherBanner } from './worksheetChrome';

/**
 * The parts every entry worksheet (accounting, item documents, Stock Journal) shares, so each layout keeps only what is its own: its
 * fields, its pickers' options and its columns. Behaviour is the one the three layouts had each written out: moving between fields, the
 * popup lists, the problems on their cells, the text cells themselves, and saving.
 */

export const MAX_OPTIONS = 8;

/** One entry in a popup list. */
export interface PickOption {
  readonly id: string;
  readonly name: string;
  readonly sub: string;
}

/** A problem's cell (`line.2.qty`) → the key of the field that shows it (`l2.qty`). */
export const focusKeyOf = (field: string): string => {
  const m = /^line\.(\d+)\.(\w+)$/.exec(field);
  return m ? `l${m[1]}.${m[2]}` : field;
};

// ---- moving between fields ----

/**
 * Where the cursor is on the worksheet, and moving it. The field with the key gets the DOM focus (its text selected) whenever the key, or
 * anything in `deps`, changes — except while `paused` (a dialog has the focus) or `idle` (a blank click deactivated the fields).
 */
export function useFieldFocus<F extends { readonly key: string }>(o: {
  readonly fields: readonly F[];
  readonly focusKey: string;
  readonly setFocusKey: (key: string) => void;
  readonly rootRef: RefObject<HTMLDivElement>;
  readonly idle: boolean;
  readonly wake: () => void;
  readonly paused?: boolean;
  readonly deps: readonly unknown[];
  /** Also run on every move (reset a popup list, a bill list…). */
  readonly onGo?: () => void;
}) {
  const { fields, focusKey, setFocusKey, rootRef, idle, wake, paused = false, onGo } = o;
  const at = Math.max(0, fields.findIndex((f) => f.key === focusKey));
  const current = fields[at] as F;
  useLayoutEffect(() => {
    if (idle || paused) return;
    const el = rootRef.current?.querySelector<HTMLInputElement>(`[data-vf="${current.key}"]`);
    el?.focus();
    if (el && el.type === 'text') el.select();
  }, [focusKey, idle, paused, ...o.deps]);
  const go = (key: string) => {
    wake();
    onGo?.();
    setFocusKey(key);
  };
  return {
    at,
    current,
    go,
    nextKey: (from = at): string | undefined => fields[from + 1]?.key,
    prevKey: (from = at): string | undefined => fields[from - 1]?.key,
    isFocus: (key: string) => !idle && key === current.key,
  };
}

// ---- problems on their cells ----

/** A problem typed into a field (right away) or found by the engine (once accept was tried), with the markup that shows it. */
export function useFieldIssues(o: { readonly issues: readonly { readonly field: string; readonly message: string }[]; readonly showErrors: boolean }) {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const issueAt = (key: string): string | undefined => fieldErrors[key] || (o.showErrors ? o.issues.find((i) => i.field === key)?.message : undefined);
  return {
    fieldErrors,
    setFieldErrors,
    issueAt,
    setError: (key: string, message: string) => setFieldErrors((e) => ({ ...e, [key]: message })),
    clearError: (key: string) => setFieldErrors((e) => (e[key] ? { ...e, [key]: '' } : e)),
    errorOf: (key: string) => {
      const m = issueAt(key);
      return m ? (
        <span class="field-error" role="alert">
          {m}
        </span>
      ) : null;
    },
    general: o.showErrors ? o.issues.filter((i) => i.field === 'general').map((i) => i.message) : [],
  };
}

// ---- the text cells ----

/** What a cell needs from its worksheet. */
export interface CellHost {
  readonly readOnly: boolean;
  isFocus(key: string): boolean;
  go(key: string): void;
  /** The cell's classes: its base, plus active (focused) and invalid (a problem shows on it). */
  cls(base: string, key: string): string;
}

/** One entry cell: `data-vf` is its field key, focusing it moves the cursor there, typing hands the text to `onInput`. */
export function Cell(props: {
  readonly host: CellHost;
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly onInput: (text: string) => void;
  /** num: a right-aligned figure (decimal keypad on a phone); combo: a cell with a popup list. */
  readonly variant?: 'text' | 'num' | 'combo';
  readonly base?: string;
  readonly id?: string;
  readonly spellcheck?: boolean;
}) {
  const { host, field, variant = 'text' } = props;
  return (
    <input
      id={props.id}
      data-vf={field}
      class={host.cls(props.base ?? (variant === 'num' ? 'vcell num' : 'vcell'), field)}
      type="text"
      aria-label={props.label}
      {...(variant === 'num' ? { inputMode: 'decimal' as const } : {})}
      {...(variant === 'combo' ? { role: 'combobox', 'aria-expanded': host.isFocus(field) && !host.readOnly, spellcheck: false } : {})}
      {...(props.spellcheck === false ? { spellcheck: false } : {})}
      readOnly={host.readOnly}
      autocomplete="off"
      value={props.value}
      onFocus={() => !host.isFocus(field) && host.go(field)}
      onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
    />
  );
}

// ---- popup lists ----

/**
 * What a popup list offers for what is typed: nothing for an empty (or already chosen) field — unless `listWhenEmpty` (a list that IS the
 * way to choose, like a party's open orders) — otherwise the best matches.
 */
export function matchOptions(options: readonly PickOption[], typed: string, storedName: string, listWhenEmpty = false): PickOption[] {
  const t = typed.trim();
  if (t === '' || t === storedName) return listWhenEmpty ? options.slice(0, MAX_OPTIONS) : [];
  const docs: EntityDoc[] = options.map((o) => ({ key: o.id, kind: '', scope: 'v', title: o.name, subtitle: o.sub, commandId: '', args: o.id }));
  return searchEntities(docs, t, { limit: MAX_OPTIONS }).map((h) => options.find((o) => o.id === h.key) as PickOption);
}

/** The popup list's own state: which entry is picked (and whether the person moved to it), and which field's list was closed with Esc. */
export function usePickerState(currentKey: string) {
  const [pick, setPick] = useState({ index: 0, touched: false });
  const [closed, setClosed] = useState<string | undefined>(undefined);
  return {
    pick,
    setPick,
    closed,
    setClosed,
    dismissed: closed !== undefined && closed === currentKey,
    /** A move to another field: a fresh list. */
    reset: () => {
      setPick({ index: 0, touched: false });
      setClosed(undefined);
    },
    /** Something was typed: the list reopens with its first entry picked. */
    typed: () => {
      setPick({ index: 0, touched: true });
      setClosed(undefined);
    },
  };
}

/** The popup list under a cell, or "No match — Alt+C creates …" when what is typed matches nothing. */
export function PickerList<T extends { readonly id: string; readonly name: string }>(props: {
  readonly show: boolean;
  readonly hits: readonly T[];
  readonly index: number;
  readonly label: string;
  readonly onChoose: (o: T) => void;
  /** The grey line under the name (default: the option's `sub`). */
  readonly sub?: (o: T) => string;
  /** What is typed, for the "No match" line (empty or already chosen: no line). */
  readonly typed: string;
  readonly storedName: string;
  readonly meta?: (o: T) => ComponentChildren;
  /** Said under "No match" (e.g. why a stock item is not offered). */
  readonly hint?: ComponentChildren;
  /** false: no "Alt+C creates" (a list of existing things only). */
  readonly canCreate?: boolean;
}) {
  const { keymapStore } = useServices();
  if (!props.show) return null;
  if (props.hits.length > 0) {
    return (
      <div class="picker" data-testid="picker">
        <ListView
          items={props.hits}
          index={props.index}
          itemKey={(o) => o.id}
          label={props.label}
          onActivate={(n) => {
            const o = props.hits[n];
            if (o) props.onChoose(o);
          }}
          renderItem={(o) => (
            <>
              <span class="row-title">{o.name}</span>
              <span class="row-desc">{props.sub ? props.sub(o) : (o as unknown as PickOption).sub}</span>
              {props.meta?.(o)}
            </>
          )}
        />
      </div>
    );
  }
  const typed = props.typed.trim();
  if (props.canCreate === false || typed === '' || typed === props.storedName) return null;
  return (
    <div class="picker picker-empty" data-testid="picker">
      No match — <Kbd chord={keymapStore.keymap.chordsFor('master.createInline')[0] ?? 'Alt+C'} /> creates “{typed}”
      {props.hint}
    </div>
  );
}

// ---- the number a new voucher will get ----

/**
 * The number the next voucher of this type saved on this date would get (its series' counter, formatted the way the server formats it) —
 * shown greyed beside "assigned on save" as a hint only: someone else may save one first. Asked again after each save.
 */
export function useNextNumber(books: Books, typeId: string, date: string, enabled: boolean): string | undefined {
  const masters = books.masters;
  const year = fyOf(masters, date);
  const series = enabled && year ? masters.series.find((s) => s.voucherTypeId === typeId && s.financialYearId === year.id) : undefined;
  const [next, setNext] = useState<{ readonly seriesId: string; readonly text: string } | undefined>(undefined);
  useEffect(() => {
    if (!series) return;
    let current = true;
    books
      .seriesStatus(series.id)
      .then((r) => {
        if (current && r.ok) setNext({ seriesId: series.id, text: formatVoucherNumber(series, r.value.nextValue) });
      })
      .catch(() => undefined); // a hint: without it the window works as before
    return () => {
      current = false;
    };
  }, [series, books.vouchers.length]);
  return series && next?.seriesId === series.id ? next.text : undefined;
}

// ---- saving ----

type Draftable = { readonly ok: true; readonly draft: unknown } | { readonly ok: false; readonly issues: readonly { readonly field: string }[] };

/**
 * Accept (Ctrl+A), Save and new (Alt+N), and the questions answered with accept (Cancel voucher, and a layout's own, like Close order).
 * A refused save says why in the banner; an alteration or a plain save closes the window back to where it was opened from, handing over
 * what it made; Save and new stays, with `startNew` resetting the form.
 */
export function useVoucherSave(o: {
  readonly books: Books;
  readonly mode: VoucherMode;
  readonly voucher: Voucher | undefined;
  readonly readOnly: boolean;
  readonly typeName: string | undefined;
  readonly draftKey: string;
  /** Leaves the current field; false keeps the save from happening (the field says why). */
  readonly settle: () => boolean;
  /** The engine's verdict on the form as it is now. */
  readonly preview: () => Draftable;
  /** Moves to the first problem when the verdict is no. */
  readonly showFirstProblem: (issues: readonly { readonly field: string }[]) => void;
  readonly refused: string;
  /** Said when a cancellation is refused without a reason. */
  readonly cancelRefused?: string;
  readonly setShowErrors: (v: boolean) => void;
  readonly setFieldErrors: (v: Record<string, string>) => void;
  /** Save and new: a fresh form, the cursor where a new one starts. Called after the banner is set. */
  readonly startNew: () => void;
  readonly initialBanner?: VoucherBanner | undefined;
  /** Other questions accept confirms, by name (`cancel` is built in). */
  readonly confirms?: Readonly<Record<string, () => Promise<void>>>;
}) {
  const { app } = useServices();
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<VoucherBanner | undefined>(o.initialBanner);
  const [confirm, setConfirm] = useState<string | undefined>(undefined);

  /** Runs a save-like step once at a time (a second press while it runs does nothing). */
  const exclusive = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const accept = async (closeAfter = true): Promise<void> => {
    if (busy || o.readOnly) return;
    if (!o.settle()) return;
    o.setShowErrors(true);
    setBanner(undefined);
    const p = o.preview();
    if (!p.ok) {
      o.showFirstProblem(p.issues);
      return;
    }
    await exclusive(async () => {
      const r = o.mode === 'alter' && o.voucher ? await o.books.alter(o.voucher.id, o.voucher.version, p.draft) : await o.books.post(p.draft);
      if (!r.ok) {
        setBanner({ text: r.issues[0]?.message ?? o.refused, tone: 'error' });
        return;
      }
      if (o.mode === 'alter') {
        app.back();
        return;
      }
      await o.books.clearDraft(o.draftKey);
      // Saved: the window closes back to where it was opened from, handing over what it made (a voucher list highlights it). Save and new stays instead.
      if (closeAfter) {
        app.back({ id: r.value.voucher.id, number: r.value.voucher.number, typeName: o.typeName ?? 'Voucher' });
        return;
      }
      o.setShowErrors(false);
      o.setFieldErrors({});
      setBanner({ text: `${o.typeName ?? 'Voucher'} ${r.value.voucher.number} saved.`, tone: 'ok' });
      o.startNew();
    });
  };

  const cancelVoucher = (): Promise<void> =>
    exclusive(async () => {
      const v = o.voucher;
      if (!v) return;
      const r = await o.books.cancel(v.id, v.version);
      setConfirm(undefined);
      if (!r.ok) setBanner({ text: r.issues[0]?.message ?? o.cancelRefused ?? 'It could not be cancelled', tone: 'error' });
      else app.back();
    });

  return {
    busy,
    banner,
    setBanner,
    confirm,
    setConfirm,
    exclusive,
    accept,
    cancelVoucher,
    acceptAndNew: (): boolean => {
      if (o.readOnly || o.mode !== 'create') return false;
      void accept(false);
      return true;
    },
    /** Ctrl+A: answers the question being asked, else saves. */
    acceptKey: (): boolean => {
      if (confirm === 'cancel') {
        void cancelVoucher();
        return true;
      }
      const other = confirm === undefined ? undefined : o.confirms?.[confirm];
      if (other) {
        void other();
        return true;
      }
      if (o.readOnly) return false;
      void accept();
      return true;
    },
  };
}
