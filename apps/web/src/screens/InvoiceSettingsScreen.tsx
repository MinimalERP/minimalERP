import type { Frame } from '@minimalerp/command';
import type { Issue } from '@minimalerp/domain';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useCommandHandler, useFrameState, useServices, useSubscriptions } from '../shell/hooks';
import { useLeaveGuard } from '../shell/useLeaveGuard';
import type { ScreenRef } from '../shell/router';
import { Kbd } from '../ui/Kbd';

/**
 * The fixed, company-level content a print carries but a voucher itself never does: phone/email, bank details, a
 * thank-you note and terms text (ADR-0022). Kept as its own screen, separate from Company Settings (name/GSTIN/state/
 * address), because it is edited far less often and by a different concern — how documents look, not who the company is.
 * Everything here is optional: a blank field is simply left off the printed invoice, never printed empty.
 */
const FIELDS = [
  { key: 'phone', label: 'Phone', hint: undefined, multiline: false },
  { key: 'email', label: 'Email', hint: undefined, multiline: false },
  { key: 'bankName', label: 'Bank name', hint: undefined, multiline: false },
  { key: 'bankAccountNo', label: 'Account number', hint: undefined, multiline: false },
  { key: 'bankIfsc', label: 'IFSC', hint: undefined, multiline: false },
  { key: 'bankBranch', label: 'Branch', hint: undefined, multiline: false },
  { key: 'invoiceNote', label: 'Thank-you note', hint: 'A short line under the total, e.g. “Thank you for your business.”', multiline: false },
  { key: 'invoiceTerms', label: 'Terms', hint: 'Printed as you type it — line breaks are kept.', multiline: true },
] as const;

const SCOPE = 'screen:invoice-settings';

export function InvoiceSettingsScreen({ frame }: { frame: Frame<ScreenRef> }) {
  const { books: host, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const books = host.current;
  const company = books?.masters.company;

  const initial: Record<string, string> = {
    phone: company?.phone ?? '',
    email: company?.email ?? '',
    bankName: company?.bankName ?? '',
    bankAccountNo: company?.bankAccountNo ?? '',
    bankIfsc: company?.bankIfsc ?? '',
    bankBranch: company?.bankBranch ?? '',
    invoiceNote: company?.invoiceNote ?? '',
    invoiceTerms: company?.invoiceTerms ?? '',
  };
  const [values, setValues] = useFrameState<Record<string, string>>(frame, 'values', initial);
  const [baseline] = useFrameState<string>(frame, 'baseline', JSON.stringify(initial));
  const leave = useLeaveGuard('These settings have not been saved.');
  const [focus, setFocus] = useFrameState(frame, 'field', 0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const at = Math.min(focus, FIELDS.length - 1);
  useEffect(() => {
    const el = formRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${FIELDS[at]?.key}"]`);
    el?.focus();
    if (el instanceof HTMLInputElement) el.select();
  }, [at]);

  const accept = async () => {
    if (busy || !books || !company) return;
    setBusy(true);
    setBanner(undefined);
    setSaved(false);
    try {
      // Every existing company field is resent unchanged alongside the edited ones — an alter replaces the whole record.
      const result = await books.execute({
        op: 'alter',
        kind: 'company',
        id: company.id,
        data: {
          name: company.name,
          gstin: company.gstin,
          stateCode: company.stateCode,
          address: company.address,
          chargeGst: company.chargeGst,
          ...values,
        },
      });
      if (result.ok) {
        setSaved(true);
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
  useCommandHandler(SCOPE, 'voucher.accept', () => {
    void accept();
    return true;
  });
  useCommandHandler(SCOPE, 'app.back', () => {
    if (JSON.stringify(values) === baseline) return false; // nothing changed: the global "back" closes the screen
    leave.ask();
    return true;
  });

  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];

  if (!books || !company) {
    return (
      <section class="screen" aria-labelledby="invpdf-title">
        <h1 id="invpdf-title">Invoice / PDF Settings</h1>
        <p class="lede">No company is open.</p>
      </section>
    );
  }

  return (
    <section class="screen form-screen" aria-labelledby="invpdf-title" data-testid="invoice-settings-form">
      {leave.dialog}
      <h1 id="invpdf-title">Invoice / PDF Settings</h1>
      <p class="lede">
        What a printed voucher carries beyond the transaction itself — phone, email, bank details, a thank-you note and terms. Every field is
        optional: leave one blank and it is simply left off the print, never shown empty.
      </p>
      {banner && (
        <p class="notice error" role="alert">
          {banner}
        </p>
      )}
      {saved && !banner && (
        <p class="notice" role="status" data-testid="invoice-settings-saved">
          Saved.
        </p>
      )}
      <form ref={formRef} class="form" onSubmit={(e) => e.preventDefault()} autocomplete="off">
        {FIELDS.map((f, i) => (
          <div key={f.key} class={i === at ? 'field-row active' : 'field-row'}>
            <label class="field-label" for={`ip-${f.key}`}>
              {f.label}
            </label>
            <div class="field-control">
              {f.multiline ? (
                <textarea
                  id={`ip-${f.key}`}
                  data-field={f.key}
                  class={errors[f.key] ? 'field-input invalid' : 'field-input'}
                  rows={4}
                  spellcheck={true}
                  aria-invalid={errors[f.key] ? true : undefined}
                  onFocus={() => i !== at && setFocus(i)}
                  onInput={(e) => {
                    setValues({ ...values, [f.key]: (e.target as HTMLTextAreaElement).value });
                    setSaved(false);
                    if (errors[f.key]) setErrors({ ...errors, [f.key]: '' });
                  }}
                  value={values[f.key] ?? ''}
                />
              ) : (
                <input
                  id={`ip-${f.key}`}
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
                    setSaved(false);
                    if (errors[f.key]) setErrors({ ...errors, [f.key]: '' });
                  }}
                />
              )}
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
          Save {chord('voucher.accept') && <Kbd chord={chord('voucher.accept') as string} />}
        </button>
      </div>
    </section>
  );
}
