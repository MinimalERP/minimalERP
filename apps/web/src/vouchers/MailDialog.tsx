import { type Voucher, MAX_MAIL_ATTACHMENT_BYTES, voucherMail, voucherMailProblems } from '@minimalerp/domain';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { Hint } from '../shell/Hint';
import { useCommandHandler, useScope } from '../shell/hooks';

const SCOPE = 'overlay:mail';

interface Attached {
  readonly name: string;
  readonly base64: string;
  readonly size: number;
}

/** A chosen file's bytes as base64 (what the mail carries). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Email a saved voucher to its party, from the company's Gmail: the party's own addresses (ticked, and nothing else offered), the subject
 * and message from that kind's template (editable), and the PDF you choose — for example the one you printed and signed with your DSC.
 * Ctrl+A sends, Esc leaves. Nothing is kept but the audit line.
 */
export function MailDialog({ books, voucher, onDone }: { books: Books; voucher: Voucher; onDone: (sentTo: readonly string[] | undefined) => void }) {
  useScope(SCOPE, 'overlay', true);
  const start = voucherMail(voucher, books.masters);
  const addresses = start?.to ?? [];
  const [picked, setPicked] = useState<readonly string[]>(addresses);
  const [subject, setSubject] = useState(start?.subject ?? '');
  const [body, setBody] = useState(start?.body ?? '');
  const [attached, setAttached] = useState<Attached | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warnNoFile, setWarnNoFile] = useState(false);
  const [sending, setSending] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-mf]')?.focus();
  }, []);

  /** Tab / Shift+Tab: through the addresses, subject, message, the file button and Send. */
  const move = (delta: number): boolean => {
    const all = [...(root.current?.querySelectorAll<HTMLElement>('[data-mf]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + delta + all.length) % all.length]?.focus();
    return true;
  };

  const choose = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') return setErrors((e) => ({ ...e, attachment: 'Choose a PDF file' }));
    if (f.size > MAX_MAIL_ATTACHMENT_BYTES) return setErrors((e) => ({ ...e, attachment: 'The PDF is larger than 10 MB' }));
    setAttached({ name: f.name, base64: await readBase64(f), size: f.size });
    setErrors((e) => ({ ...e, attachment: '' }));
    setWarnNoFile(false);
  };

  const send = async (): Promise<void> => {
    if (sending) return;
    const attachment = attached ? { name: attached.name, base64: attached.base64 } : undefined;
    const problems = voucherMailProblems(voucher, books.masters, { to: picked, subject, attachment });
    if (problems.length > 0) {
      setErrors(Object.fromEntries(problems.map((p) => [p.path ?? 'general', p.message])));
      return;
    }
    if (!attached && !warnNoFile) {
      setWarnNoFile(true); // asked once: a second Send goes without a file
      return;
    }
    setSending(true);
    try {
      const r = await books.sendVoucherMail({ voucherId: voucher.id, to: picked, subject: subject.trim(), body, ...(attachment ? { attachment } : {}) });
      if (r.ok) onDone(r.value.sentTo);
      else setErrors({ general: r.issues.map((i) => i.message).join(' ') });
    } catch {
      setErrors({ general: 'The mail could not be sent: the server did not answer. Check the connection and try again.' });
    } finally {
      setSending(false);
    }
  };

  useCommandHandler(SCOPE, 'field.next', () => move(1));
  useCommandHandler(SCOPE, 'field.prev', () => move(-1));
  useCommandHandler(SCOPE, 'voucher.accept', () => (void send(), true));
  useCommandHandler(SCOPE, 'app.back', () => (sending ? true : (onDone(undefined), true)));

  const err = (key: string) =>
    errors[key] ? (
      <span class="field-error" role="alert">
        {errors[key]}
      </span>
    ) : null;

  return (
    <div class="overlay-backdrop" data-testid="mail-dialog-backdrop">
      <div class="palette dialog mail-dialog" role="dialog" aria-modal="true" aria-label={`Email ${voucher.number}`} data-testid="mail-dialog" ref={root}>
        <h2 class="dialog-title">
          Email {start?.docName ?? 'voucher'} {voucher.number}
        </h2>
        <div class="dialog-body">
          <div class="field-row">
            <span class="field-label">To</span>
            <div class="field-control" data-testid="mail-to">
              {addresses.length === 0 ? (
                <span class="field-hint">The party has no email address: add one to the party (Emails), then email this again.</span>
              ) : (
                addresses.map((a) => (
                  <label key={a} class="mail-to">
                    <input
                      type="checkbox"
                      data-mf
                      checked={picked.includes(a)}
                      onChange={(e) => {
                        const on = (e.target as HTMLInputElement).checked;
                        setPicked(on ? [...picked, a] : picked.filter((x) => x !== a));
                        setErrors((x) => ({ ...x, to: '' }));
                      }}
                    />{' '}
                    {a}
                  </label>
                ))
              )}
              {err('to')}
            </div>
          </div>
          <div class="field-row">
            <label class="field-label" for="mail-subject">
              Subject
            </label>
            <div class="field-control">
              <input
                id="mail-subject"
                data-mf
                class={errors['subject'] ? 'field-input invalid' : 'field-input'}
                type="text"
                autocomplete="off"
                value={subject}
                onInput={(e) => {
                  setSubject((e.target as HTMLInputElement).value);
                  setErrors((x) => ({ ...x, subject: '' }));
                }}
              />
              {err('subject')}
            </div>
          </div>
          <div class="field-row">
            <label class="field-label" for="mail-body">
              Message
            </label>
            <div class="field-control">
              <textarea id="mail-body" data-mf class="field-input mail-body" rows={8} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
              <span class="field-hint">Sent in the voucher’s own typewriter style, with the document’s number, date and amount above it.</span>
            </div>
          </div>
          <div class="field-row">
            <span class="field-label">PDF</span>
            <div class="field-control">
              <input
                ref={file}
                type="file"
                accept="application/pdf,.pdf"
                hidden
                data-testid="mail-file"
                onChange={(e) => void choose((e.target as HTMLInputElement).files?.[0])}
              />
              <button type="button" class="button" data-mf onClick={() => file.current?.click()}>
                {attached ? 'Choose another PDF…' : 'Choose PDF…'}
              </button>{' '}
              {attached ? (
                <span data-testid="mail-attached">
                  {attached.name} · {sizeText(attached.size)}
                </span>
              ) : (
                <span class="field-hint">Print or save the voucher as PDF (sign it with your DSC if you like), then choose it here.</span>
              )}
              {err('attachment')}
            </div>
          </div>
          {warnNoFile && (
            <p class="notice" role="status" data-testid="mail-no-file">
              No PDF is attached. Send again to email it without one.
            </p>
          )}
          {errors['general'] && (
            <p class="notice error" role="alert">
              {errors['general']}
            </p>
          )}
          <div class="confirm-actions">
            <button type="button" class="button" onClick={() => onDone(undefined)} disabled={sending}>
              Cancel
            </button>
            <button type="button" class="button primary" data-mf data-testid="mail-send" onClick={() => void send()} disabled={sending || addresses.length === 0}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
        <div class="palette-foot">
          <Hint command="voucher.accept" fallback="Ctrl+A">send</Hint>
          <Hint command="field.next" fallback="Tab">next</Hint>
          <Hint command="app.back" fallback="Esc">cancel</Hint>
        </div>
      </div>
    </div>
  );
}
