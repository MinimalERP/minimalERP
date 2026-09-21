import { type EntityDoc, type Frame, searchEntities } from '@minimalerp/command';
import { type Issue, type MasterKind, type MasterRecord, findMaster, isMasterActive, partyLedgerId } from '@minimalerp/domain';
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  FORMS,
  type FieldSpec,
  type FormValues,
  type Option,
  blankValues,
  issueField,
  labelOfRef,
  optionsFor,
  recordToValues,
  titleOf,
  valuesToData,
} from '../books/forms';
import { hasStockLedger, ledgersOfRecord } from '../books/entities';
import { addDays } from '../vouchers/format';
import { useCommandHandler, useFrameState, useServices, useSubscriptions } from '../shell/hooks';
import { Only } from '../shell/Only';
import { WindowClose } from '../shell/WindowClose';
import { useLeaveGuard } from '../shell/useLeaveGuard';
import type { MasterMode, ScreenRef } from '../shell/router';
import { Kbd } from '../ui/Kbd';
import { ListView } from '../ui/ListView';

const SCOPE = 'screen:master';
const MAX_OPTIONS = 8;

/** What a screen opened for a result hands back to the field that asked for it. */
export interface CreatedMaster {
  readonly kind: MasterKind;
  readonly id: string;
  readonly name: string;
}

interface Props {
  readonly frame: Frame<ScreenRef>;
  readonly kind: MasterKind;
  readonly mode: MasterMode;
  readonly id?: string | undefined;
  readonly seed?: Readonly<Record<string, string>> | undefined;
  readonly inline?: boolean | undefined;
}

/**
 * One form for every master: Create, Alter and Display share it, and each kind is only a list of fields (books/forms.ts).
 * Keyboard: Enter/Tab next field, Shift+Tab back, Ctrl+A accept, Esc leave (asks first if you typed something),
 * Alt+C create the missing record a picker points at and land back here with it chosen.
 */
export function MasterFormScreen({ frame, kind, mode, id, seed, inline }: Props) {
  const { books: host, app, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const books = host.current;
  const spec = FORMS[kind];
  const masters = books?.masters;

  const existing: MasterRecord | undefined =
    masters && mode !== 'create' && id !== undefined ? findMaster(masters, kind, id) : undefined;

  const initial = (): FormValues => {
    if (existing) return recordToValues(spec, existing);
    return { ...blankValues(spec), ...(seed ?? {}) };
  };
  const [values, setValues] = useFrameState<FormValues>(frame, 'values', initial());
  const [baseline] = useFrameState<FormValues>(frame, 'baseline', values);
  const [newId, setNewId] = useFrameState<string>(frame, 'newId', crypto.randomUUID());
  const [focus, setFocus] = useFrameState<number>(frame, 'field', 0);
  const [labels, setLabels] = useFrameState<Record<string, string>>(frame, 'labels', {});

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ text: string; tone: 'error' | 'ok' } | undefined>(undefined);
  const leave = useLeaveGuard();
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState({ index: 0, touched: false });
  /** The field whose popup list was closed with Esc. Typing, ↓ or moving to another field opens a list again. */
  const [pickerClosed, setPickerClosed] = useState<string | undefined>(undefined);
  const formRef = useRef<HTMLFormElement>(null);

  // A ledger's opening balance only makes sense for balance-sheet groups (assets and liabilities).
  const visible = (f: FieldSpec): boolean => {
    if (f.createOnly && mode !== 'create') return false;
    if (f.visibleIf && !f.visibleIf(values)) return false;
    if (kind === 'ledger' && (f.key === 'openingAmount' || f.key === 'openingSide') && masters) {
      const nature = masters.groups.natureOf((values.groupId ?? '') as never);
      return nature === 'asset' || nature === 'liability';
    }
    return true;
  };
  const fields = spec.fields.filter(visible);
  const at = Math.min(focus, Math.max(0, fields.length - 1));
  const current = fields[at];
  const readOnly = mode === 'display';
  const dirty = !readOnly && JSON.stringify(values) !== JSON.stringify(baseline);

  // ---- fresh reads (a result can arrive after this component has been replaced by the same frame's next mount) ----
  const freshValues = (): FormValues => (frame.state.get('values') as FormValues | undefined) ?? values;
  const patch = (key: string, value: string, label?: string) => {
    const nextValues = { ...freshValues(), [key]: value };
    setValues(nextValues);
    if (label !== undefined) setLabels({ ...((frame.state.get('labels') as Record<string, string> | undefined) ?? labels), [key]: label });
  };

  // What a ref/choice field shows: what is being typed, else the chosen record's name.
  const shown = (f: FieldSpec): string => {
    if (f.type !== 'ref' && f.type !== 'choice') return values[f.key] ?? '';
    if (labels[f.key] !== undefined) return labels[f.key] as string;
    return masters ? labelOfRef(f, masters, values[f.key] ?? '', existing) : '';
  };

  const choicesFor = (f: FieldSpec): { options: readonly Option[]; hits: readonly Option[] } => {
    if (!masters) return { options: [], hits: [] };
    const options = optionsFor(f, masters, kind === 'unit' || kind === 'group' || kind === 'stockGroup' || kind === 'warehouse' ? id : undefined, existing);
    const typed = (labels[f.key] ?? '').trim();
    if (typed === '' || typed === labelOfRef(f, masters, values[f.key] ?? '', existing)) return { options, hits: f.type === 'choice' ? options.slice(0, MAX_OPTIONS) : [] };
    const docs: EntityDoc[] = options.map((o) => ({ key: o.value, kind: '', scope: 'pick', title: o.label, subtitle: o.sub, commandId: '', args: o.value }));
    const hits = searchEntities(docs, typed, { limit: MAX_OPTIONS }).map((h) => options.find((o) => o.value === h.key) as Option);
    return { options, hits };
  };

  const pickerOpen = !readOnly && current !== undefined && (current.type === 'ref' || current.type === 'choice');
  const hits = pickerOpen && current ? choicesFor(current).hits : [];
  const pickerDismissed = pickerClosed !== undefined && pickerClosed === current?.key;
  const pickIndex = Math.min(pick.index, Math.max(0, hits.length - 1));

  // ---- focus ----
  useEffect(() => {
    const el = formRef.current?.querySelector<HTMLInputElement>(`[data-field="${current?.key ?? ''}"]`);
    el?.focus();
    if (el && el.type === 'text') el.select();
  }, [at, mode, fields.length]);

  const goTo = (index: number) => {
    setPick({ index: 0, touched: false });
    setPickerClosed(undefined);
    setFocus(Math.max(0, Math.min(fields.length - 1, index)));
  };

  const fail = (key: string, message: string): false => {
    setErrors((e) => ({ ...e, [key]: message }));
    return false;
  };

  /** Settles the current field when leaving it. Returns false (and says why) if it cannot be left yet. */
  const settle = (): boolean => {
    if (!current || readOnly) return true;
    if (current.type === 'ref' || current.type === 'choice') {
      const typed = (labels[current.key] ?? '').trim();
      const stored = values[current.key] ?? '';
      const storedLabel = masters ? labelOfRef(current, masters, stored, existing) : '';
      const choice = hits[pickIndex];
      const choose = (o: Option): true => {
        patch(current.key, o.value, o.label);
        setErrors((e) => ({ ...e, [current.key]: '' }));
        return true;
      };

      // The user typed or moved through the list: what is highlighted is what they mean.
      if (pick.touched && choice) return choose(choice);
      if (typed !== '' && typed !== storedLabel) {
        return choice ? choose(choice) : fail(current.key, current.type === 'ref' ? 'No match — press Alt+C to create it' : 'Choose one of the options');
      }
      if (typed === '' && labels[current.key] !== undefined) patch(current.key, '', ''); // cleared on purpose
      if ((typed === '' && labels[current.key] !== undefined) || stored === '') {
        if (current.required) return fail(current.key, 'Choose one — start typing, or press ↓');
      }
    }
    setErrors((e) => ({ ...e, [current.key]: '' }));
    return true;
  };

  // ---- accept ----
  const accept = async (): Promise<boolean> => {
    if (readOnly || busy || !books) return false;
    if (!settle()) return true;
    setBusy(true);
    setBanner(undefined);
    setErrors({});
    try {
      const recordId = mode === 'create' ? newId : (id as string);
      const result = await books.execute({ op: mode === 'create' ? 'create' : 'alter', kind, id: recordId, data: valuesToData(spec, freshValues()) });
      if (!result.ok) {
        showIssues(result.issues);
        return true;
      }

      const v = freshValues();
      const openingAmount = (v.openingAmount ?? '').trim();
      if (mode === 'create' && kind === 'ledger' && openingAmount !== '' && fields.some((f) => f.key === 'openingAmount')) {
        const opened = await books.postOpening(recordId, (v.openingSide ?? 'debit') as 'debit' | 'credit', openingAmount);
        if (!opened.ok) {
          const first = opened.issues[0];
          setErrors({ openingAmount: first?.message ?? 'The opening balance was refused' });
          setBanner({ text: `“${result.value.name}” was created, but its opening balance was refused. Fix it and accept again.`, tone: 'error' });
          return true;
        }
      }

      if (mode === 'create' && kind === 'party') {
        const problem = await postPartyOpenings(recordId, v);
        if (problem) {
          setErrors({ [problem.field]: problem.message });
          setBanner({ text: `“${result.value.name}” was created, but an opening balance was refused. Fix it and accept again.`, tone: 'error' });
          return true;
        }
      }

      if (mode === 'create' && kind === 'stockItem') {
        const problem = await postItemOpening(recordId, v);
        if (problem) {
          setErrors({ [problem.field]: problem.message });
          setBanner({ text: `“${result.value.name}” was created, but its opening stock was refused. Fix it and accept again.`, tone: 'error' });
          return true;
        }
      }

      const created: CreatedMaster = { kind, id: recordId, name: result.value.name };
      if (inline) {
        app.back(created);
      } else if (mode === 'create') {
        setBanner({ text: `${spec.noun} “${result.value.name}” created.`, tone: 'ok' });
        const fresh = { ...blankValues(spec), ...(seed?.groupId ? { groupId: seed.groupId } : {}) };
        setValues(fresh);
        setLabels({});
        setNewId(crypto.randomUUID());
        setFocus(0);
      } else {
        app.back();
      }
      return true;
    } finally {
      setBusy(false);
    }
  };

  /** A party's opening balances go to the ledgers it just got: what a customer owes (Dr) and what is owed a vendor (Cr). */
  const postPartyOpenings = async (partyId: string, v: FormValues): Promise<{ field: string; message: string } | undefined> => {
    if (!books) return undefined;
    const year = books.masters.financialYears[0];
    const creditDays = Number((v.creditDays ?? '').trim());
    for (const [role, cap] of [['customer', 'Cust'], ['vendor', 'Vend']] as const) {
      const amount = (v[`open${cap}Amount`] ?? '').trim();
      if (amount === '' || !fields.some((x) => x.key === `open${cap}Amount`)) continue;
      const ref = (v[`open${cap}Bill`] ?? '').trim();
      const dueDate = year && Number.isFinite(creditDays) && creditDays > 0 ? addDays(year.start, creditDays) : undefined;
      const bill = ref === '' ? undefined : [{ kind: 'new', ref, ...(dueDate ? { dueDate } : {}), amount }];
      const opened = await books.postOpening(partyLedgerId(partyId, role), (v[`open${cap}Side`] ?? 'debit') as 'debit' | 'credit', amount, bill);
      if (!opened.ok) return { field: `open${cap}Amount`, message: opened.issues[0]?.message ?? 'The opening balance was refused' };
    }
    return undefined;
  };

  /** An item's opening stock goes to the godown chosen (the main one when left blank), valued at the rate typed. */
  const postItemOpening = async (itemId: string, v: FormValues): Promise<{ field: string; message: string } | undefined> => {
    if (!books) return undefined;
    const qty = (v.openQty ?? '').trim();
    if (qty === '' || !fields.some((x) => x.key === 'openQty')) return undefined;
    const warehouse = (v.openWarehouse ?? '') || (books.masters.warehouses.find((w) => w.isActive)?.id ?? '');
    const opened = await books.postOpeningStock(itemId, warehouse, qty, (v.openRate ?? '').trim() || '0');
    if (opened.ok) return undefined;
    const first = opened.issues[0];
    const field = first?.path === 'rate' ? 'openRate' : first?.path === 'warehouseId' ? 'openWarehouse' : 'openQty';
    return { field, message: first?.message ?? 'The opening stock was refused' };
  };

  const showIssues = (issues: readonly Issue[]) => {
    const next: Record<string, string> = {};
    const general: string[] = [];
    for (const i of issues) {
      const field = issueField(spec, i);
      if (field && next[field] === undefined) next[field] = i.message;
      else general.push(i.message);
    }
    setErrors(next);
    setBanner(general.length > 0 ? { text: general.join(' '), tone: 'error' } : undefined);
    const firstBad = fields.findIndex((f) => next[f.key] !== undefined);
    if (firstBad !== -1) setFocus(firstBad);
  };

  const toggleActive = async (): Promise<boolean> => {
    if (!books || !existing || id === undefined || mode === 'create') return false;
    const nowActive = isMasterActive(kind, existing);
    const result = await books.execute({ op: 'setActive', kind, id, active: !nowActive });
    if (!result.ok) {
      setBanner({ text: result.issues[0]?.message ?? 'That could not be changed', tone: 'error' });
      return true;
    }
    setBanner({ text: `${spec.noun} ${nowActive ? 'deactivated' : 'reactivated'}.`, tone: 'ok' });
    return true;
  };

  const createInline = (): boolean => {
    if (readOnly || !current || current.type !== 'ref' || !current.target || current.target === 'financialYear') return false;
    const target = current.target;
    const typed = (labels[current.key] ?? '').trim();
    const nameField = FORMS[target].nameField;
    const target_seed: Record<string, string> = typed === '' ? {} : { [nameField]: typed };
    const key = current.key;
    const field = current;
    void app.navigateForResult<CreatedMaster>({ type: 'master', kind: target, mode: 'create', seed: target_seed, inline: true }).then((created) => {
      if (!created) return;
      // Show it the way the picker lists it (a unit reads "Cartons (Carton)", not just its symbol).
      const label = optionsFor(field, books?.masters as NonNullable<typeof masters>, undefined, existing).find((o) => o.value === created.id)?.label ?? created.name;
      patch(key, created.id, label);
    });
    return true;
  };

  // ---- commands (the keymap decides which keys) ----
  const movePick = (delta: number): boolean => {
    if (!pickerOpen || hits.length === 0) return false;
    setPick({ index: (pickIndex + delta + hits.length) % hits.length, touched: true });
    return true;
  };
  const next = (): boolean => {
    if (!settle()) return true;
    if (at < fields.length - 1) goTo(at + 1);
    return true;
  };
  useCommandHandler(SCOPE, 'field.next', next);
  useCommandHandler(SCOPE, 'field.prev', () => {
    settle();
    if (at > 0) goTo(at - 1);
    return true;
  });
  useCommandHandler(SCOPE, 'nav.down', () => {
    if (pickerOpen && pickerDismissed) return (setPickerClosed(undefined), true);
    return pickerOpen && hits.length > 0 ? movePick(1) : next();
  });
  useCommandHandler(SCOPE, 'nav.up', () => {
    if (pickerOpen && hits.length > 0) return movePick(-1);
    if (at > 0) goTo(at - 1);
    return true;
  });
  useCommandHandler(SCOPE, 'nav.activate', () => {
    if (at < fields.length - 1 || readOnly) return next();
    void accept();
    return true;
  });
  // Each of these is registered only where it means something (see <Only> below), so the action panel greys the rest.
  const canCreateInline =
    !readOnly && kind !== 'company' && current?.type === 'ref' && current.target !== undefined && current.target !== 'financialYear';
  /**
   * Esc closes ONE thing per press, innermost first: an open popup list → the field being edited (back to the previous field, dropping what
   * was typed but not chosen) → and only from the first field the window itself (which asks "Close and leave?" if anything changed).
   * Overlay dialogs sit above all of this and take their own Esc.
   */
  useCommandHandler(SCOPE, 'app.back', () => {
    const listShown =
      pickerOpen && !pickerDismissed && (hits.length > 0 || (current?.type === 'ref' && (labels[current.key] ?? '').trim() !== ''));
    if (listShown && current) {
      setPickerClosed(current.key);
      return true;
    }
    if (!readOnly && at > 0) {
      if (current && (current.type === 'ref' || current.type === 'choice') && labels[current.key] !== undefined) {
        // what was typed but never chosen is dropped, so the field is left as it was
        setLabels({ ...((frame.state.get('labels') as Record<string, string> | undefined) ?? labels), [current.key]: masters ? labelOfRef(current, masters, values[current.key] ?? '', existing) : '' });
      }
      const target = fields[at - 1];
      goTo(at - 1);
      if (target && (target.type === 'ref' || target.type === 'choice')) setPickerClosed(target.key); // arriving by Esc does not pop the list open
      return true;
    }
    if (dirty) {
      leave.ask();
      return true;
    }
    return false; // not handled here: the global "back" closes the screen
  });

  // The panel's Close button: straight to the window's own decision (ask if something changed), skipping the popup/field steps of Esc.
  useCommandHandler(SCOPE, 'app.close', () => {
    if (!dirty) return false;
    leave.ask();
    return true;
  });

  const chord = (commandId: string) => keymapStore.keymap.chordsFor(commandId)[0];

  if (!books || !masters) {
    return (
      <section class="screen" aria-labelledby="master-title">
        <h1 id="master-title">{spec.noun}</h1>
        <p class="lede">Open a company first.</p>
      </section>
    );
  }
  if (mode !== 'create' && !existing) {
    return (
      <section class="screen" aria-labelledby="master-title">
        <h1 id="master-title">{spec.noun}</h1>
        <p class="empty">That {spec.noun.toLowerCase()} no longer exists.</p>
      </section>
    );
  }

  const inactive = existing ? !isMasterActive(kind, existing) : false;
  const ownerOfLedger = kind === 'ledger' ? (existing as { partyId?: string; partyRole?: string } | undefined) : undefined;

  const handlers = (
    <>
      {!readOnly && (
        <Only
          scope={SCOPE}
          command="voucher.accept"
          run={() => {
            void accept();
            return true;
          }}
        />
      )}
      {canCreateInline && <Only scope={SCOPE} command="master.createInline" run={createInline} />}
      {mode === 'display' && id !== undefined && (
        <Only
          scope={SCOPE}
          command="master.alter"
          run={() => {
            // A party's ledger is not altered on its own: the party is.
            if (ownerOfLedger?.partyRole !== undefined && ownerOfLedger.partyId !== undefined) app.navigate({ type: 'master', kind: 'party', mode: 'alter', id: ownerOfLedger.partyId });
            else app.navigate({ type: 'master', kind, mode: 'alter', id });
            return true;
          }}
        />
      )}
      {mode !== 'create' && id !== undefined && masters && ledgersOfRecord(masters, kind, id)[0] !== undefined && (
        <Only
          scope={SCOPE}
          command="master.ledgerReport"
          run={() => {
            // a party with both roles opens its customer ledger (Go To lists both)
            const ledger = ledgersOfRecord(masters, kind, id)[0];
            if (ledger) app.navigate({ type: 'report', report: 'ledger', ledgerId: ledger.id });
            return true;
          }}
        />
      )}
      {mode !== 'create' && id !== undefined && masters && hasStockLedger(masters, kind, id) && (
        <Only
          scope={SCOPE}
          command="master.stockLedger"
          run={() => {
            app.navigate({ type: 'report', report: 'stock-item', itemId: id });
            return true;
          }}
        />
      )}
      {mode !== 'create' && existing && (
        <Only
          scope={SCOPE}
          command="master.toggleActive"
          run={() => {
            void toggleActive();
            return true;
          }}
        />
      )}
    </>
  );

  return (
    <section class="screen form-screen" aria-labelledby="master-title" data-testid="master-form">
      {handlers}
      {leave.dialog}
      <h1 id="master-title">
        {titleOf(kind, mode, existing)}
        {inactive && <span class="badge">Inactive</span>}
      </h1>
      <WindowClose />
      <p class="lede">
        {mode !== 'create' && id !== undefined && masters && ledgersOfRecord(masters, kind, id)[0] !== undefined && chord('master.ledgerReport') && (
          <>
            <Kbd chord={chord('master.ledgerReport') as string} /> opens its ledger report.{' '}
          </>
        )}
        {mode !== 'create' && id !== undefined && masters && hasStockLedger(masters, kind, id) && chord('master.stockLedger') && (
          <>
            <Kbd chord={chord('master.stockLedger') as string} /> opens its stock ledger.{' '}
          </>
        )}
        {mode === 'display' && chord('master.alter') && (
          <>
            <Kbd chord={chord('master.alter') as string} /> to alter{chord('master.toggleActive') && kind !== 'company' ? <>, <Kbd chord={chord('master.toggleActive') as string} /> to {inactive ? 'reactivate' : 'deactivate'}</> : null}.
          </>
        )}
        {mode === 'alter' && <>Change what you need, then accept.</>}
        {mode === 'create' && <>Fill in the details, then accept.</>}
      </p>

      {kind === 'ledger' && existing && (existing as { partyRole?: string }).partyRole !== undefined && (
        <p class="notice" data-testid="party-ledger-note">
          This ledger belongs to {books.masters.party((existing as { partyId?: string }).partyId as never)?.name ?? 'a party'}: its name and status follow the party.
          {chord('master.alter') && (
            <>
              {' '}
              <Kbd chord={chord('master.alter') as string} /> opens the party.
            </>
          )}
        </p>
      )}
      {banner && (
        <p class={banner.tone === 'error' ? 'notice error' : 'notice'} role={banner.tone === 'error' ? 'alert' : 'status'} data-testid="form-banner">
          {banner.text}
        </p>
      )}
      <form
        ref={formRef}
        class="form"
        onSubmit={(e) => e.preventDefault()}
        autocomplete="off"
      >
        {fields.map((f, i) => {
          const active = i === at;
          const error = errors[f.key];
          const isPicker = f.type === 'ref' || f.type === 'choice';
          return (
            <Fragment key={f.key}>
            {f.heading && <h2 class="form-section">{f.heading}</h2>}
            <div class={active ? 'field-row active' : 'field-row'}>
              <label class="field-label" for={`f-${f.key}`}>
                {f.label}
                {f.required && !readOnly && <span class="req" aria-hidden="true"> *</span>}
              </label>
              <div class="field-control">
                <input
                  id={`f-${f.key}`}
                  data-field={f.key}
                  class={error ? 'field-input invalid' : 'field-input'}
                  type="text"
                  inputMode={f.type === 'money' || f.type === 'decimal' || f.type === 'integer' ? 'decimal' : undefined}
                  role={isPicker ? 'combobox' : undefined}
                  aria-expanded={isPicker && active && !readOnly ? true : undefined}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `e-${f.key}` : undefined}
                  readOnly={readOnly}
                  placeholder={f.placeholder}
                  value={shown(f)}
                  autocomplete="off"
                  spellcheck={false}
                  onFocus={() => i !== at && goTo(i)}
                  onInput={(e) => {
                    const value = (e.target as HTMLInputElement).value;
                    setPick({ index: 0, touched: isPicker });
                    setPickerClosed(undefined);
                    if (isPicker) setLabels({ ...labels, [f.key]: value });
                    else setValues({ ...values, [f.key]: value });
                    if (error) setErrors((prev) => ({ ...prev, [f.key]: '' }));
                  }}
                />
                {error && (
                  <span class="field-error" id={`e-${f.key}`} role="alert">
                    {error}
                  </span>
                )}
                {!error && f.hint && active && !readOnly && <span class="field-hint">{f.hint}</span>}
                {isPicker && active && !readOnly && !pickerDismissed && hits.length > 0 && (
                  <div class="picker" data-testid="picker">
                    <ListView
                      items={hits}
                      index={pickIndex}
                      itemKey={(o) => o.value}
                      label={`${f.label} options`}
                      onActivate={(n) => {
                        const choice = hits[n];
                        if (choice) {
                          patch(f.key, choice.value, choice.label);
                          setErrors((prev) => ({ ...prev, [f.key]: '' }));
                        }
                      }}
                      renderItem={(o) => (
                        <>
                          <span class="row-title">{o.label}</span>
                          {o.sub && <span class="row-desc">{o.sub}</span>}
                        </>
                      )}
                    />
                  </div>
                )}
                {isPicker && active && !readOnly && !pickerDismissed && hits.length === 0 && f.type === 'ref' && (labels[f.key] ?? '').trim() !== '' && (labels[f.key] ?? '').trim() !== (masters ? labelOfRef(f, masters, values[f.key] ?? '', existing) : '') && (
                  <div class="picker picker-empty" data-testid="picker">
                    No match{chord('master.createInline') && f.target && f.target !== 'financialYear' ? (
                      <>
                        {' — '}
                        <Kbd chord={chord('master.createInline') as string} /> creates “{(labels[f.key] ?? '').trim()}”
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
            </Fragment>
          );
        })}
      </form>

    </section>
  );
}
