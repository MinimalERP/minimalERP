import type { Frame } from '@minimalerp/command';
import type { Issue } from '@minimalerp/domain';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { CompanyChoice, NewCompany } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { useCommandHandler, useFrameState, useServices, useSubscriptions } from '../shell/hooks';
import { useLeaveGuard } from '../shell/useLeaveGuard';
import type { ScreenRef } from '../shell/router';
import { Kbd } from '../ui/Kbd';
import { ChooseOneDialog } from './ReportDialogs';

/** The first day of the financial year in progress (1 April — the Indian default). */
function defaultFyStart(now = new Date()): string {
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04-01`;
}

const FIELDS = [
  { key: 'name', label: 'Company name', required: true, hint: undefined },
  { key: 'fyStart', label: 'Financial year starts', required: true, hint: 'YYYY-MM-DD — most Indian companies start on 1 April' },
  { key: 'gstin', label: 'GSTIN', required: false, hint: 'Optional. The state is read from it.' },
  { key: 'stateCode', label: 'State code', required: false, hint: 'Two digits, e.g. 27 for Maharashtra' },
  { key: 'address', label: 'Address', required: false, hint: undefined },
] as const;

const SCOPE = 'screen:company-new';

/**
 * First-run onboarding: name, financial year, GSTIN. Creating the company seeds the standard chart of accounts, the
 * voucher types with their numbering, GST slabs, units and a main warehouse — the same for everyone, all editable after.
 */
export function CompanyCreateScreen({ frame }: { frame: Frame<ScreenRef> }) {
  const { books: host, app, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const [values, setValues] = useFrameState<Record<string, string>>(frame, 'values', { name: '', fyStart: defaultFyStart(), gstin: '', stateCode: '', address: '' });
  const [baseline] = useFrameState<string>(frame, 'baseline', JSON.stringify(values));
  const leave = useLeaveGuard('The company has not been created.');
  const [focus, setFocus] = useFrameState(frame, 'field', 0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const at = Math.min(focus, FIELDS.length - 1);
  useLayoutEffect(() => {
    const el = formRef.current?.querySelector<HTMLInputElement>(`[data-field="${FIELDS[at]?.key}"]`);
    el?.focus();
    el?.select();
  }, [at]);

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setBanner(undefined);
    try {
      const input: NewCompany = {
        name: values.name ?? '',
        fyStart: (values.fyStart ?? '').trim(),
        gstin: values.gstin,
        stateCode: values.stateCode,
        address: values.address,
      };
      const result = await host.create(input);
      if (result.ok) {
        app.goHome(); // the new company is the open one now; the screens beneath belonged to the one before
        return;
      }
      const next: Record<string, string> = {};
      const general: string[] = [];
      for (const i of result.issues as readonly Issue[]) {
        const key = i.path?.split('.')[0];
        if (key && FIELDS.some((f) => f.key === key) && next[key] === undefined) next[key] = i.message;
        else general.push(i.message);
      }
      setErrors(next);
      setBanner(general.join(' ') || undefined);
      const bad = FIELDS.findIndex((f) => next[f.key] !== undefined);
      if (bad !== -1) setFocus(bad);
    } finally {
      setBusy(false);
    }
  };

  useCommandHandler(SCOPE, 'field.next', () => {
    setFocus(Math.min(FIELDS.length - 1, at + 1));
    return true;
  });
  useCommandHandler(SCOPE, 'field.prev', () => {
    setFocus(Math.max(0, at - 1));
    return true;
  });
  useCommandHandler(SCOPE, 'nav.down', () => {
    setFocus(Math.min(FIELDS.length - 1, at + 1));
    return true;
  });
  useCommandHandler(SCOPE, 'nav.up', () => {
    setFocus(Math.max(0, at - 1));
    return true;
  });
  useCommandHandler(SCOPE, 'nav.activate', () => {
    if (at < FIELDS.length - 1) setFocus(at + 1);
    else void accept();
    return true;
  });
  useCommandHandler(SCOPE, 'voucher.accept', () => {
    void accept();
    return true;
  });
  useCommandHandler(SCOPE, 'app.back', () => {
    if (JSON.stringify(values) === baseline) return false; // nothing entered: the global "back" closes the screen
    leave.ask();
    return true;
  });

  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];

  if (host.current && !host.canSwitch) {
    return (
      <section class="screen" aria-labelledby="company-title">
        <h1 id="company-title">Create Company</h1>
        <p class="lede">A company is already open: {host.current.masters.company.name}.</p>
      </section>
    );
  }

  return (
    <section class="screen form-screen" aria-labelledby="company-title" data-testid="company-form">
      {leave.dialog}
      <h1 id="company-title">Create Company</h1>
      <p class="lede">Set up your books. You can change all of this later in Company Settings.</p>
      {banner && (
        <p class="notice error" role="alert">
          {banner}
        </p>
      )}
      <form ref={formRef} class="form" onSubmit={(e) => e.preventDefault()} autocomplete="off">
        {FIELDS.map((f, i) => (
          <div key={f.key} class={i === at ? 'field-row active' : 'field-row'}>
            <label class="field-label" for={`c-${f.key}`}>
              {f.label}
              {f.required && <span class="req" aria-hidden="true"> *</span>}
            </label>
            <div class="field-control">
              <input
                id={`c-${f.key}`}
                data-field={f.key}
                class={errors[f.key] ? 'field-input invalid' : 'field-input'}
                type="text"
                value={values[f.key] ?? ''}
                autocomplete="off"
                spellcheck={false}
                aria-invalid={errors[f.key] ? true : undefined}
                onFocus={() => i !== at && setFocus(i)}
                onInput={(e) => {
                  setValues({ ...values, [f.key]: (e.target as HTMLInputElement).value });
                  if (errors[f.key]) setErrors({ ...errors, [f.key]: '' });
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
      </form>
      <div class="toolbar">
        <button type="button" class="button" disabled={busy} onClick={() => void accept()}>
          Create company {chord('voucher.accept') && <Kbd chord={chord('voucher.accept') as string} />}
        </button>
        {host.canLoadDemo && (
          <button
            type="button"
            class="button"
            disabled={busy}
            onClick={() =>
              void loadDemoCompany(host).then((r) => {
                if (r.ok) app.goHome();
                else setBanner(r.issues[0]?.message);
              })
            }
          >
            Or load the demo company
          </button>
        )}
      </div>
    </section>
  );
}

const RESET_SCOPE = 'screen:company-reset';

/** The one destructive step in the app, so it asks: this deletes the browser's copy of the company. */
export function CompanyResetScreen() {
  const { books: host, app, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const name = host.current?.masters.company.name;

  const confirm = () => {
    void host.close().then(() => app.goHome());
    return true;
  };
  useCommandHandler(RESET_SCOPE, 'voucher.accept', confirm);
  useCommandHandler(RESET_SCOPE, 'nav.activate', () => true); // Enter must not be the way to confirm a deletion

  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];
  return (
    <section class="screen" aria-labelledby="reset-title" data-testid="company-reset">
      <h1 id="reset-title">Close Company</h1>
      {name ? (
        <div class="callout">
          <h2>Delete “{name}” from this browser?</h2>
          <p>All of its masters and entries stored here are removed. This cannot be undone.</p>
          <p>
            {chord('voucher.accept') && <Kbd chord={chord('voucher.accept') as string} />} to delete · {chord('app.back') && <Kbd chord={chord('app.back') as string} />} to keep it
          </p>
        </div>
      ) : (
        <p class="empty">No company is open.</p>
      )}
    </section>
  );
}

const ROLE_NAMES: Readonly<Record<string, string>> = { owner: 'Owner', member: 'Full access' };

/**
 * Opens another of the account's companies (online books). Each company's books, inbox and settings are its own: switching closes
 * every screen of the one before and starts again at the Gateway of the one chosen.
 */
export function CompanySwitchScreen() {
  const { books: host, app } = useServices();
  useSubscriptions(host);
  const [companies, setCompanies] = useState<readonly CompanyChoice[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    host.companies().then(setCompanies, (error: unknown) => setProblem(`Could not list your companies: ${String(error instanceof Error ? error.message : error)}`));
  }, [host]);

  const open = async (id: string | undefined) => {
    if (id === undefined) return void app.back();
    if (id === host.current?.masters.company.id) return void app.goHome();
    setBusy(true);
    try {
      await host.switchTo(id as CompanyChoice['id']);
      app.goHome();
    } catch (error) {
      setProblem(`Could not open the company: ${String(error instanceof Error ? error.message : error)}`);
      setBusy(false);
    }
  };

  const current = host.current?.masters.company.id;
  // The open company first, so Enter on arriving stays put and one Down moves to another.
  const ordered = companies && [...companies].sort((a, b) => Number(b.id === current) - Number(a.id === current));
  return (
    <section class="screen" aria-labelledby="switch-title" data-testid="company-switch">
      <h1 id="switch-title">Switch Company</h1>
      {problem && (
        <p class="notice error" role="alert">
          {problem}
        </p>
      )}
      {!ordered && !problem && <p class="empty">Loading your companies…</p>}
      {busy && <p class="empty">Opening…</p>}
      {ordered && !busy && (
        <ChooseOneDialog
          title="Open which company?"
          options={ordered.map((c) => ({
            value: c.id,
            label: c.name,
            hint: [c.id === current ? 'open now' : '', ROLE_NAMES[c.role] ?? c.role].filter(Boolean).join(' · '),
          }))}
          onDone={(v) => void open(v)}
        />
      )}
    </section>
  );
}
