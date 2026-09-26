import { type Issue, type Result, type Voucher, MAX_MAIL_FILES, MAX_MAIL_TOTAL_BYTES, isMailFileName, mailFileSize, voucherMail, voucherMailProblems } from '@minimalerp/domain';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
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
  const start = voucherMail(voucher, books.masters);
  return (
    <MailWindow
      title={`Email ${start?.docName ?? 'voucher'} ${voucher.number}`}
      addresses={start?.to ?? []}
      subject={start?.subject ?? ''}
      body={start?.body ?? ''}
      bodyHint="Sent in the voucher’s own typewriter style, with the document’s number, date and amount above it."
      fileHint="The voucher’s PDF (printed, signed with your DSC if you like) and any supporting documents — several at once."
      problems={(req) => voucherMailProblems(voucher, books.masters, req)}
      send={(req) => books.sendVoucherMail({ voucherId: voucher.id, ...req })}
      onDone={onDone}
    />
  );
}

export interface MailRequest {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly attachments?: readonly { readonly name: string; readonly base64: string }[];
}

export interface MailWindowProps {
  readonly title: string;
  /** The party's own addresses: all ticked, nothing else offered. */
  readonly addresses: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly bodyHint: string;
  readonly fileHint: string;
  /** A file made for this mail (a payment reminder's PDF): attached as soon as it is ready, removable like any other. */
  readonly makeFile?: (() => Promise<{ readonly name: string; readonly base64: string }>) | undefined;
  readonly problems: (req: MailRequest) => Issue[];
  readonly send: (req: MailRequest) => Promise<Result<{ readonly sentTo: readonly string[] }>>;
  readonly onDone: (sentTo: readonly string[] | undefined) => void;
}

/** The mail window every mail from the books goes through: a voucher's (Email) and a payment reminder's. */
export function MailWindow({ title, addresses, subject: startSubject, body: startBody, bodyHint, fileHint, makeFile, problems: problemsOf, send: sendIt, onDone }: MailWindowProps) {
  useScope(SCOPE, 'overlay', true);
  const [picked, setPicked] = useState<readonly string[]>(addresses);
  const [subject, setSubject] = useState(startSubject);
  const [body, setBody] = useState(startBody);
  const [attached, setAttached] = useState<readonly Attached[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warnNoFile, setWarnNoFile] = useState(false);
  const [sending, setSending] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [making, setMaking] = useState(makeFile !== undefined);

  useEffect(() => {
    if (!makeFile) return;
    let live = true;
    makeFile().then(
      (f) => {
        if (live) setAttached((a) => [...a.filter((x) => x.name !== f.name), { ...f, size: mailFileSize(f.base64) }]);
      },
      () => {
        if (live) setErrors((e) => ({ ...e, attachment: 'The PDF could not be made: attach it yourself (Print, save as PDF).' }));
      },
    ).finally(() => live && setMaking(false));
    return () => {
      live = false;
    };
  }, []);

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

  /** Adds the chosen files to the ones already attached (the same name again replaces it). */
  const choose = async (list: FileList | null | undefined) => {
    const files = [...(list ?? [])];
    if (files.length === 0) return;
    const odd = files.find((f) => !isMailFileName(f.name));
    if (odd) return setErrors((e) => ({ ...e, attachment: `${odd.name}: attach PDF, picture, Excel, Word, CSV or ZIP files` }));
    const read = await Promise.all(files.map(async (f) => ({ name: f.name, base64: await readBase64(f), size: f.size })));
    const next = [...attached.filter((a) => !read.some((r) => r.name === a.name)), ...read];
    if (next.length > MAX_MAIL_FILES) return setErrors((e) => ({ ...e, attachment: `Attach at most ${MAX_MAIL_FILES} files` }));
    if (next.reduce((t, a) => t + a.size, 0) > MAX_MAIL_TOTAL_BYTES) return setErrors((e) => ({ ...e, attachment: 'The files come to more than 18 MB together' }));
    setAttached(next);
    setErrors((e) => ({ ...e, attachment: '' }));
    setWarnNoFile(false);
    if (file.current) file.current.value = ''; // choosing the same file again (after removing it) fires again
  };

  const send = async (): Promise<void> => {
    if (sending || making) return;
    const attachments = attached.map((a) => ({ name: a.name, base64: a.base64 }));
    const problems = problemsOf({ to: picked, subject, body, attachments });
    if (problems.length > 0) {
      setErrors(Object.fromEntries(problems.map((p) => [p.path ?? 'general', p.message])));
      return;
    }
    if (attached.length === 0 && !warnNoFile) {
      setWarnNoFile(true); // asked once: a second Send goes without a file
      return;
    }
    setSending(true);
    try {
      const r = await sendIt({ to: picked, subject: subject.trim(), body, ...(attachments.length > 0 ? { attachments } : {}) });
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
      <div class="palette dialog mail-dialog" role="dialog" aria-modal="true" aria-label={title} data-testid="mail-dialog" ref={root}>
        <h2 class="dialog-title">{title}</h2>
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
              <span class="field-hint">{bodyHint}</span>
            </div>
          </div>
          <div class="field-row">
            <span class="field-label">Files</span>
            <div class="field-control">
              <input
                ref={file}
                type="file"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.doc,.csv,.zip"
                hidden
                data-testid="mail-file"
                onChange={(e) => void choose((e.target as HTMLInputElement).files)}
              />
              {attached.map((a) => (
                <div key={a.name} class="mail-file" data-testid="mail-attached">
                  <span>
                    {a.name} · {sizeText(a.size)}
                  </span>
                  <button type="button" class="line-x" aria-label={`Remove ${a.name}`} title="Remove this file" onClick={() => setAttached(attached.filter((x) => x.name !== a.name))}>
                    ×
                  </button>
                </div>
              ))}
              <button type="button" class="button" data-mf onClick={() => file.current?.click()}>
                {attached.length > 0 ? 'Add more files…' : 'Choose files…'}
              </button>{' '}
              {making && (
                <span class="field-hint" data-testid="mail-making">
                  Making the PDF…
                </span>
              )}
              {attached.length === 0 && !making && <span class="field-hint">{fileHint}</span>}
              {err('attachment')}
            </div>
          </div>
          {warnNoFile && (
            <p class="notice" role="status" data-testid="mail-no-file">
              Nothing is attached. Send again to email it without a file.
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
            <button type="button" class="button primary" data-mf data-testid="mail-send" onClick={() => void send()} disabled={sending || making || addresses.length === 0}>
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
