import { type EntityDoc, searchEntities } from '@minimalerp/command';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useCommandHandler, useScope } from '../shell/hooks';
import { Hint } from '../shell/Hint';
import { ListView } from '../ui/ListView';

const SCOPE = 'overlay:report-dialog';

function Frame({ title, children, hints }: { title: string; children: preact.ComponentChildren; hints: preact.ComponentChildren }) {
  return (
    <div class="overlay-backdrop" data-testid="report-dialog-backdrop">
      <div class="palette dialog" role="dialog" aria-modal="true" aria-label={title} data-testid="report-dialog">
        <h2 class="dialog-title">{title}</h2>
        <div class="dialog-body">{children}</div>
        <div class="palette-foot">{hints}</div>
      </div>
    </div>
  );
}

// ---- pick several of a list (voucher types; the values of a choice column) ------------------------------------------

export interface Option {
  readonly value: string;
  readonly label: string;
}

/** Enter ticks / unticks the row; the accept key applies; Esc leaves it as it was. Nothing ticked means "all". */
export function MultiSelectDialog(props: { title: string; options: readonly Option[]; selected: readonly string[]; onDone: (values: string[] | undefined) => void }) {
  useScope(SCOPE, 'overlay', true);
  const [picked, setPicked] = useState<readonly string[]>(props.selected);
  const [index, setIndex] = useState(0);
  const rows = [{ value: '', label: 'All' }, ...props.options];

  const toggle = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.value === '') setPicked([]);
    else setPicked((p) => (p.includes(row.value) ? p.filter((x) => x !== row.value) : [...p, row.value]));
  };
  useCommandHandler(SCOPE, 'nav.down', () => (setIndex((i) => (i + 1) % rows.length), true));
  useCommandHandler(SCOPE, 'nav.up', () => (setIndex((i) => (i - 1 + rows.length) % rows.length), true));
  useCommandHandler(SCOPE, 'field.next', () => (setIndex((i) => (i + 1) % rows.length), true));
  useCommandHandler(SCOPE, 'field.prev', () => (setIndex((i) => (i - 1 + rows.length) % rows.length), true));
  useCommandHandler(SCOPE, 'nav.activate', () => (toggle(index), true));
  useCommandHandler(SCOPE, 'voucher.accept', () => (props.onDone([...picked]), true));
  useCommandHandler(SCOPE, 'app.back', () => (props.onDone(undefined), true));

  return (
    <Frame
      title={props.title}
      hints={
        <>
          <Hint command="nav.activate" fallback="Enter">tick</Hint>
          <Hint command="voucher.accept" fallback="Ctrl+A">apply</Hint>
          <Hint command="app.back" fallback="Esc">cancel</Hint>
        </>
      }
    >
      {/* the choices are buttons, drawn like the action panel's: click to tick, or move with the keys and press Enter */}
      <div class="action-list" role="listbox" aria-label={props.title} aria-multiselectable="true">
        {rows.map((r, i) => {
          const on = r.value === '' ? picked.length === 0 : picked.includes(r.value);
          return (
            <button
              key={r.value || '__all'}
              type="button"
              role="option"
              aria-selected={on}
              class={i === index ? (on ? 'action chosen picked' : 'action chosen') : on ? 'action picked' : 'action'}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (setIndex(i), toggle(i))}
            >
              <span class="action-label">
                <span class="tick" aria-hidden="true">{r.value === '' ? (picked.length === 0 ? '●' : '○') : on ? '☑' : '☐'}</span>
                <span class="row-title">{r.label}</span>
                {r.value !== '' && on && <span class="sr-only"> selected</span>}
              </span>
            </button>
          );
        })}
      </div>
    </Frame>
  );
}

// ---- one or two text inputs (contains / from–to / period) ------------------------------------------------------------

export interface InputField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

export function FieldsDialog(props: { title: string; fields: readonly InputField[]; validate?: (values: Record<string, string>) => Record<string, string>; onDone: (values: Record<string, string> | undefined) => void }) {
  useScope(SCOPE, 'overlay', true);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(props.fields.map((f) => [f.key, f.value])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [at, setAt] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = root.current?.querySelector<HTMLInputElement>(`[data-rf="${props.fields[at]?.key}"]`);
    el?.focus();
    el?.select();
  }, [at]);

  const apply = () => {
    const problems = props.validate?.(values) ?? {};
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      const bad = props.fields.findIndex((f) => problems[f.key]);
      if (bad !== -1) setAt(bad);
      return;
    }
    props.onDone(values);
  };
  const forward = () => (at < props.fields.length - 1 ? setAt(at + 1) : apply(), true);
  useCommandHandler(SCOPE, 'field.next', () => (setAt(Math.min(props.fields.length - 1, at + 1)), true));
  useCommandHandler(SCOPE, 'field.prev', () => (setAt(Math.max(0, at - 1)), true));
  useCommandHandler(SCOPE, 'nav.down', () => (setAt(Math.min(props.fields.length - 1, at + 1)), true));
  useCommandHandler(SCOPE, 'nav.up', () => (setAt(Math.max(0, at - 1)), true));
  useCommandHandler(SCOPE, 'nav.activate', forward);
  useCommandHandler(SCOPE, 'voucher.accept', () => (apply(), true));
  useCommandHandler(SCOPE, 'app.back', () => (props.onDone(undefined), true));

  return (
    <Frame
      title={props.title}
      hints={
        <>
          <Hint command="nav.activate" fallback="Enter">next</Hint>
          <Hint command="voucher.accept" fallback="Ctrl+A">apply</Hint>
          <Hint command="app.back" fallback="Esc">cancel</Hint>
        </>
      }
    >
      <div ref={root}>
        {props.fields.map((f, i) => (
          <div key={f.key} class={i === at ? 'field-row active' : 'field-row'}>
            <label class="field-label" for={`rf-${f.key}`}>
              {f.label}
            </label>
            <div class="field-control">
              <input
                id={`rf-${f.key}`}
                data-rf={f.key}
                class={errors[f.key] ? 'field-input invalid' : 'field-input'}
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={values[f.key] ?? ''}
                onFocus={() => setAt(i)}
                onInput={(e) => {
                  setValues({ ...values, [f.key]: (e.target as HTMLInputElement).value });
                  setErrors({ ...errors, [f.key]: '' });
                }}
              />
              {errors[f.key] && (
                <span class="field-error" role="alert">
                  {errors[f.key]}
                </span>
              )}
              {!errors[f.key] && f.hint && i === at && <span class="field-hint">{f.hint}</span>}
            </div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

// ---- choose one of a few (what to create) --------------------------------------------------------------------------------

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/** Up/Down (or Tab) move, Enter picks, Esc leaves without picking. */
export function ChooseOneDialog(props: { title: string; options: readonly ChoiceOption[]; onDone: (value: string | undefined) => void }) {
  useScope(SCOPE, 'overlay', true);
  const [index, setIndex] = useState(0);
  const n = props.options.length;
  useCommandHandler(SCOPE, 'nav.down', () => (setIndex((i) => (i + 1) % n), true));
  useCommandHandler(SCOPE, 'nav.up', () => (setIndex((i) => (i - 1 + n) % n), true));
  useCommandHandler(SCOPE, 'field.next', () => (setIndex((i) => (i + 1) % n), true));
  useCommandHandler(SCOPE, 'field.prev', () => (setIndex((i) => (i - 1 + n) % n), true));
  useCommandHandler(SCOPE, 'nav.activate', () => (props.onDone(props.options[index]?.value), true));
  useCommandHandler(SCOPE, 'app.back', () => (props.onDone(undefined), true));

  return (
    <Frame
      title={props.title}
      hints={
        <>
          <Hint command="nav.activate" fallback="Enter">choose</Hint>
          <Hint command="app.back" fallback="Esc">cancel</Hint>
        </>
      }
    >
      <ListView
        items={props.options}
        index={index}
        itemKey={(o) => o.value}
        label={props.title}
        onActivate={(i) => props.onDone(props.options[i]?.value)}
        renderItem={(o) => (
          <>
            <span class="row-title">{o.label}</span>
            {o.hint && <span class="row-desc">{o.hint}</span>}
          </>
        )}
      />
    </Frame>
  );
}

// ---- choose a ledger (Ledger report without one) ---------------------------------------------------------------------

export interface LedgerOption {
  readonly id: string;
  readonly name: string;
  readonly group: string;
}

export function LedgerDialog(props: { ledgers: readonly LedgerOption[]; onDone: (id: string | undefined) => void }) {
  useScope(SCOPE, 'overlay', true);
  const [text, setText] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const docs: EntityDoc[] = useMemo(() => props.ledgers.map((l) => ({ key: l.id, kind: '', scope: 'l', title: l.name, subtitle: l.group, commandId: '', args: l.id })), [props.ledgers]);
  const hits = useMemo(() => (text.trim() === '' ? props.ledgers.slice(0, 10) : searchEntities(docs, text, { limit: 10 }).map((h) => props.ledgers.find((l) => l.id === h.key) as LedgerOption)), [text, docs]);
  const safe = Math.min(index, Math.max(0, hits.length - 1));

  useCommandHandler(SCOPE, 'nav.down', () => (hits.length > 0 && setIndex((safe + 1) % hits.length), true));
  useCommandHandler(SCOPE, 'nav.up', () => (hits.length > 0 && setIndex((safe - 1 + hits.length) % hits.length), true));
  useCommandHandler(SCOPE, 'field.next', () => (hits.length > 0 && setIndex((safe + 1) % hits.length), true));
  useCommandHandler(SCOPE, 'field.prev', () => (hits.length > 0 && setIndex((safe - 1 + hits.length) % hits.length), true));
  useCommandHandler(SCOPE, 'nav.activate', () => {
    const h = hits[safe];
    if (h) props.onDone(h.id);
    return true;
  });
  useCommandHandler(SCOPE, 'app.back', () => (props.onDone(undefined), true));

  return (
    <Frame
      title="Choose a ledger"
      hints={
        <>
          <Hint command="nav.activate" fallback="Enter">open</Hint>
          <Hint command="app.back" fallback="Esc">cancel</Hint>
        </>
      }
    >
      <input
        ref={inputRef}
        class="field-input"
        type="text"
        role="combobox"
        aria-label="Ledger"
        autocomplete="off"
        spellcheck={false}
        placeholder="type a ledger name…"
        value={text}
        onInput={(e) => (setText((e.target as HTMLInputElement).value), setIndex(0))}
      />
      {hits.length > 0 ? (
        <ListView
          items={hits}
          index={safe}
          itemKey={(l) => l.id}
          label="Ledgers"
          onActivate={(i) => hits[i] && props.onDone((hits[i] as LedgerOption).id)}
          renderItem={(l) => (
            <>
              <span class="row-title">{l.name}</span>
              <span class="row-desc">{l.group}</span>
            </>
          )}
        />
      ) : (
        <p class="empty">No ledger matches.</p>
      )}
    </Frame>
  );
}
