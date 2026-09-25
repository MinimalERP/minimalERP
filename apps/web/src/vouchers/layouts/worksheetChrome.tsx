import type { Frame } from '@minimalerp/command';
import type { Masters } from '@minimalerp/domain';
import type { ComponentChildren, RefObject, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { Books } from '../../books/books';
import { WindowClose } from '../../shell/WindowClose';
import { useCommandHandler } from '../../shell/hooks';
import { fyOf } from '../entryHelpers';
import { formatDate, parseDateInput } from '../format';
import type { EntryKind } from '../kinds';

export type VoucherBanner = { readonly text: string; readonly tone: 'error' | 'ok' | 'note' };

function voucherWeekday(date: string): string {
  return date ? new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' }) : '';
}

/** Reads a typed date field into YYYY-MM-DD, or returns a field error message. */
export function tryCommitVoucherDate(masters: Masters, dateText: string, currentDate: string): { ok: true; date: string } | { ok: false; message: string } {
  const y = fyOf(masters, currentDate);
  const parsed = parseDateInput(dateText, { start: y?.start ?? currentDate, end: y?.end ?? currentDate, base: currentDate });
  if (!parsed) return { ok: false, message: 'That is not a date — try 10, 10-5 or 10-5-24' };
  return { ok: true, date: parsed };
}

/** Half-entered voucher forms: survive reload, clear when the window closes or the form is blank. */
export function useVoucherDraftPersistence<T>(opts: {
  readonly enabled: boolean;
  readonly frame: Frame<unknown>;
  readonly draftKey: string;
  readonly books: Books;
  readonly form: T;
  readonly typeId: string;
  readonly isBlank: (f: T) => boolean;
  readonly fresh: () => T;
  readonly setForm: (f: T) => void;
  readonly setDateText: (text: string) => void;
  readonly formDate: (f: T) => string;
  readonly acceptLoaded: (saved: T) => boolean;
}): void {
  const { enabled, frame, draftKey, books, form, isBlank, fresh, setForm, setDateText, formDate, acceptLoaded } = opts;
  const draftReady = useRef(!enabled);
  const draftKeyNow = useRef(draftKey);
  draftKeyNow.current = draftKey;

  useEffect(
    () => () => {
      if (enabled) void books.clearDraft(draftKeyNow.current);
    },
    [enabled, books],
  );

  useEffect(() => {
    if (!enabled || frame.state.has('form-loaded')) {
      draftReady.current = true;
      return;
    }
    frame.state.set('form-loaded', true);
    void books.loadDraft(draftKey).then((saved) => {
      const d = saved as T | undefined;
      if (d && isBlank(fresh()) && acceptLoaded(d)) {
        setForm(d);
        setDateText(formatDate(formDate(d)));
      }
      draftReady.current = true;
    });
  }, [enabled, frame, draftKey, books, acceptLoaded, fresh, formDate, isBlank, setForm, setDateText]);

  useEffect(() => {
    if (!enabled || !draftReady.current) return;
    const t = setTimeout(() => void (isBlank(form) ? books.clearDraft(draftKey) : books.saveDraft(draftKey, form)), 350);
    return () => clearTimeout(t);
  }, [enabled, form, draftKey, books, isBlank]);
}

export function VoucherWorksheetSection(props: {
  readonly rootRef: RefObject<HTMLDivElement>;
  readonly title: ComponentChildren;
  readonly banner?: VoucherBanner | undefined;
  readonly general: readonly string[];
  readonly notices?: ComponentChildren;
  readonly head: ComponentChildren;
  readonly children: ComponentChildren;
  readonly footer?: ComponentChildren;
}): JSX.Element {
  const { rootRef, title, banner, general, notices, head, children, footer } = props;
  return (
    <section class="screen voucher-screen" aria-labelledby="voucher-title" data-testid="voucher-form" ref={rootRef as never}>
      <h1 id="voucher-title" class="vtitle">
        {title}
      </h1>
      <WindowClose />
      <VoucherWorksheetNotices banner={banner} general={general} extra={notices} />
      {head}
      {children}
      {footer}
    </section>
  );
}

function VoucherWorksheetNotices(props: {
  readonly banner?: VoucherBanner | undefined;
  readonly general: readonly string[];
  readonly extra?: ComponentChildren;
}): JSX.Element {
  const { banner, general, extra } = props;
  return (
    <>
      {banner && (
        <p
          class={banner.tone === 'error' ? 'notice error' : banner.tone === 'note' ? 'notice capture' : 'notice'}
          role={banner.tone === 'error' ? 'alert' : 'status'}
          data-testid="voucher-banner"
        >
          {banner.text}
        </p>
      )}
      {general.length > 0 && (
        <p class="notice error" role="alert">
          {general.join(' ')}
        </p>
      )}
      {extra}
    </>
  );
}

export function VoucherWorksheetHead(props: {
  readonly typeName: string | undefined;
  readonly numberText: string;
  /** A new voucher: the number it will probably get, shown greyed (see useNextNumber). */
  readonly nextNumber?: string | undefined;
  readonly formDate: string;
  readonly dateText: string;
  readonly readOnly: boolean;
  readonly dateActive: boolean;
  readonly dateInvalid?: boolean | undefined;
  readonly onFocusDate: () => void;
  readonly onInputDate: (text: string) => void;
  readonly dateError?: ComponentChildren;
}): JSX.Element {
  const { typeName, numberText, nextNumber, formDate, dateText, readOnly, dateActive, dateInvalid, onFocusDate, onInputDate, dateError } = props;
  return (
    <div class="vhead">
      <span class="vtag" data-testid="voucher-type-tag">
        {typeName}
      </span>
      <span class="vno">
        No. <strong data-testid="voucher-number">{numberText}</strong>
        {nextNumber && (
          <span class="vno-next" data-testid="next-number" title="The number this voucher will probably get — someone else may save one first">
            ({nextNumber})
          </span>
        )}
      </span>
      <span class="vspacer" />
      <span class="vday" data-testid="voucher-weekday">
        {voucherWeekday(formDate)}
      </span>
      <input
        data-vf="date"
        class={`vdate${dateActive ? ' active' : ''}${dateInvalid ? ' invalid' : ''}`}
        type="text"
        aria-label="Voucher date"
        readOnly={readOnly}
        autocomplete="off"
        value={dateText}
        onFocus={onFocusDate}
        onInput={(e) => onInputDate((e.target as HTMLInputElement).value)}
      />
      {dateError}
    </div>
  );
}

export function VoucherNarrationRow(props: {
  readonly active: boolean;
  readonly readOnly: boolean;
  readonly value: string;
  readonly onFocus: () => void;
  readonly onInput: (text: string) => void;
  readonly cellClass?: string | undefined;
}): JSX.Element {
  const { active, readOnly, value, onFocus, onInput, cellClass = 'vcell narration' } = props;
  return (
    <div class={active ? 'vnarr active' : 'vnarr'}>
      <label class="vlabel" for="v-narration">
        Narration:
      </label>
      <input
        id="v-narration"
        data-vf="narration"
        class={cellClass}
        type="text"
        readOnly={readOnly}
        autocomplete="off"
        value={value}
        onFocus={onFocus}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
      />
    </div>
  );
}

/** Registers the keys that belong to one mode only. Renders nothing. */
export function VoucherModeHandlers(props: {
  readonly scope?: string | undefined;
  readonly switchTo?: ((kind: EntryKind) => boolean) | undefined;
  readonly onAlter?: (() => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
}): JSX.Element {
  const scope = props.scope ?? 'screen:voucher';
  const { switchTo, onAlter, onCancel } = props;
  return (
    <>
      {switchTo && <VoucherSwitchHandlers scope={scope} switchTo={switchTo} />}
      {onAlter && <VoucherOneHandler scope={scope} command="master.alter" run={onAlter} />}
      {onCancel && <VoucherOneHandler scope={scope} command="voucher.cancel" run={onCancel} />}
    </>
  );
}

function VoucherOneHandler({ scope, command, run }: { scope: string; command: string; run: () => void }) {
  useCommandHandler(scope, command, () => (run(), true));
  return null;
}

function VoucherSwitchHandlers({ scope, switchTo }: { scope: string; switchTo: (kind: EntryKind) => boolean }) {
  useCommandHandler(scope, 'voucher.switch.contra', () => switchTo('contra'));
  useCommandHandler(scope, 'voucher.switch.payment', () => switchTo('payment'));
  useCommandHandler(scope, 'voucher.switch.receipt', () => switchTo('receipt'));
  useCommandHandler(scope, 'voucher.switch.journal', () => switchTo('journal'));
  return null;
}
