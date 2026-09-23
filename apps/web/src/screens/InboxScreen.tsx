import type { Frame } from '@minimalerp/command';
import type { InboxItem } from '@minimalerp/ports';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChooseOneDialog } from './ReportDialogs';
import { Only } from '../shell/Only';
import { useFrameState, useListNavigation, useServices, useSubscriptions } from '../shell/hooks';
import type { ScreenRef } from '../shell/router';
import { Kbd } from '../ui/Kbd';
import { ListView } from '../ui/ListView';
import { formatDate } from '../vouchers/format';

const SCOPE = 'screen:inbox';

const KIND_TITLES: Readonly<Record<InboxItem['kind'], string>> = {
  salesOrder: 'Sales Order',
  sales: 'Sales Invoice',
  purchase: 'Purchase Invoice',
  receipt: 'Receipt',
  payment: 'Payment',
};

/** What the row says about the document: the lines it has and what it comes to, or the amount paid. */
const UPLOAD_KINDS: readonly { value: InboxItem['kind']; label: string; hint: string }[] = [
  { value: 'salesOrder', label: 'Sales Order', hint: "a customer's PO" },
  { value: 'purchase', label: 'Purchase Bill', hint: "a supplier's invoice" },
  { value: 'sales', label: 'Sales Invoice', hint: 'goods to invoice to a customer' },
  { value: 'receipt', label: 'Receipt', hint: "a customer's payment advice" },
  { value: 'payment', label: 'Payment', hint: 'a payment we made to a supplier' },
];
const MAX_UPLOAD = 10 * 1024 * 1024;
const READABLE = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif))$/;

/** A file's content as base64 (without the data: prefix). */
const base64Of = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

/** A document the reader could not read at all (Gemini stayed busy): there is nothing to open, only "send it again". */
const unread = (item: InboxItem): boolean => item.proposal.notes.some((n) => n.code === 'READ_FAILED');

function summaryOf(item: InboxItem): string {
  const p = item.proposal;
  if (unread(item)) return 'could not be read';
  if (p.kind === 'receipt' || p.kind === 'payment') return p.amount ? `₹ ${p.amount}` : 'amount not read';
  if (p.lines.length === 0) return p.fromOrderId ? 'against an open order' : 'no lines read';
  return `${p.lines.length} line${p.lines.length === 1 ? '' : 's'}`;
}

/**
 * The AI Inbox (ADR-0023): the documents a person sent from Gmail ("Send to ERP → Sales Order"), each read and matched into a PROPOSAL.
 * Nothing here is in the books. Enter opens the proposal in the voucher window — what was matched is filled in, what was not is the
 * document's own words for a person to pick or create (Alt+C) — and accepting it there posts it and takes it off this list. Alt+X, pressed
 * twice, throws a proposal away.
 */
export function InboxScreen({ frame }: { frame: Frame<ScreenRef> }) {
  const { books: host, app, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const books = host.current;
  const [items, setItems] = useState<readonly InboxItem[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [index, setIndex] = useFrameState(frame, 'index', 0);
  const [notice, setNotice] = useFrameState<string | undefined>(frame, 'notice', undefined);
  const [confirmReject, setConfirmReject] = useState<string | undefined>(undefined);
  /** Upload: the file chosen, waiting for "what is it?" */
  const [picked, setPicked] = useState<File | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const load = () => {
    if (!books) return;
    void books.inbox().then((r) => {
      if (r.ok) {
        setItems(r.value);
        setError(undefined);
      } else setError(r.issues.map((i) => i.message).join('; '));
    });
  };
  // every time the list comes to the front (it is mounted afresh when a voucher window over it closes): someone may have accepted one meanwhile
  useEffect(load, [books]);

  const rows = items ?? [];
  const safeIndex = Math.min(index, Math.max(0, rows.length - 1));
  const selected = rows[safeIndex];

  const open = (i: number) => {
    const item = rows[i];
    if (!item) return;
    setConfirmReject(undefined);
    if (unread(item)) {
      setNotice(item.proposal.notes[0]?.message);
      return;
    }
    void app.navigateForResult<{ id: string; number: string; typeName: string }>({ type: 'voucher', mode: 'create', typeKey: item.kind, fromInbox: item }).then((made) => {
      if (made) frame.state.set('notice', `${made.typeName} ${made.number} saved from the AI Inbox.`);
    });
  };

  const reject = (): boolean => {
    if (!books || !selected) return false;
    if (confirmReject !== selected.id) {
      setConfirmReject(selected.id);
      return true;
    }
    setConfirmReject(undefined);
    void books.rejectInbox(selected.id).then((r) => {
      if (r.ok) {
        setNotice(`Rejected: ${selected.mailSubject ?? KIND_TITLES[selected.kind]}.`);
        load();
      } else setError(r.issues.map((i) => i.message).join('; '));
    });
    return true;
  };

  /** Upload (Alt+U): a PDF from WhatsApp or a portal, a photo of a paper bill — read like a mail from Gmail. */
  const upload = (): boolean => {
    if (!books) return false;
    fileRef.current?.click();
    return true;
  };
  const onFile = (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = ''; // the same file can be chosen again
    if (!file) return;
    if (!READABLE.test(file.type)) return setError(`${file.name} cannot be read: choose a PDF or a photo (JPG, PNG).`);
    if (file.size > MAX_UPLOAD) return setError(`${file.name} is larger than 10 MB.`);
    setError(undefined);
    setPicked(file);
  };
  const send = (kind: string | undefined) => {
    const file = picked;
    setPicked(undefined);
    if (!books || !file || !kind) return;
    const label = UPLOAD_KINDS.find((k) => k.value === kind)?.label ?? kind;
    setNotice(`Sending ${file.name}…`);
    void base64Of(file)
      .then((base64) => books.sendDocument(kind as InboxItem['kind'], { mimeType: file.type, base64 }, file.name))
      .then((r) => {
        if (!r.ok) {
          setNotice(undefined);
          setError(r.issues.map((i) => i.message).join('; '));
          return;
        }
        setNotice(`${file.name} is being read as a ${label}: it will appear here in about a minute.`);
        // look again while it is being read (a busy Gemini may take up to two minutes)
        timers.current.push(...[20_000, 45_000, 90_000, 130_000].map((ms) => setTimeout(load, ms)));
      })
      .catch(() => setError(`${file.name} could not be opened.`));
  };

  useListNavigation(SCOPE, { count: rows.length, index: safeIndex, setIndex: (i) => (setConfirmReject(undefined), setIndex(i)), onActivate: open, wrap: true, homeEnd: true });
  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];

  return (
    <section class="screen" aria-labelledby="inbox-title" data-testid="inbox">
      {selected && <Only scope={SCOPE} command="inbox.reject" run={reject} />}
      {books && !picked && <Only scope={SCOPE} command="inbox.upload" run={upload} />}
      <input ref={fileRef} type="file" accept="application/pdf,image/*" hidden data-testid="inbox-file" onChange={(e) => onFile((e.target as HTMLInputElement).files?.[0])} />
      {picked && <ChooseOneDialog title={`What is ${picked.name}?`} options={UPLOAD_KINDS} onDone={send} />}
      <h1 id="inbox-title">AI Inbox</h1>
      <p class="lede">
        Documents you sent from Gmail, read and matched. Nothing here is in the books until you accept it. <Kbd chord={chord('nav.activate') ?? 'Enter'} /> open
        {chord('inbox.reject') && (
          <>
            {' '}
            · <Kbd chord={chord('inbox.reject') as string} /> reject
          </>
        )}
        {chord('inbox.upload') && (
          <>
            {' '}
            · <Kbd chord={chord('inbox.upload') as string} /> upload a PDF or photo
          </>
        )}
      </p>
      {notice && (
        <p class="notice" role="status" data-testid="inbox-notice">
          {notice}
        </p>
      )}
      {error && (
        <p class="error" role="alert" data-testid="inbox-error">
          {error}
        </p>
      )}
      {!books ? (
        <p class="empty">Open a company first.</p>
      ) : items === undefined ? (
        <p class="empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p class="empty" data-testid="inbox-empty">
          Nothing waiting. In Gmail, open a customer’s PO, a supplier’s bill or a payment advice and choose <strong>Send to ERP</strong> in the
          MinimalERP panel — or upload a PDF or photo here ({chord('inbox.upload') ?? 'Alt+U'}).
        </p>
      ) : (
        <>
          <ListView
            items={rows}
            index={safeIndex}
            itemKey={(r) => r.id}
            label="Proposals waiting"
            onActivate={(i) => {
              setIndex(i);
              open(i);
            }}
            renderItem={(r) => (
              <>
                <span class="row-title">
                  {KIND_TITLES[r.kind]} · {unread(r) ? 'not read — send it again' : (r.proposal.party.name ?? 'party not read')}
                </span>
                <span class="row-desc">
                  {[r.mailSubject, r.mailFrom, formatDate(r.proposal.date)].filter(Boolean).join(' · ')}
                </span>
                <span class="row-meta">
                  {summaryOf(r)}
                  {r.proposal.notes.length > 0 && <span class="badge">{r.proposal.notes.length} to check</span>}
                </span>
              </>
            )}
          />
          {selected && (
            <div class="inbox-notes" data-testid="inbox-notes" aria-live="polite">
              {confirmReject === selected.id && (
                <p class="error" role="alert" data-testid="inbox-confirm-reject">
                  Press <Kbd chord={chord('inbox.reject') ?? 'Alt+X'} /> again to reject this proposal. Nothing will be posted.
                </p>
              )}
              {selected.proposal.notes.length === 0 ? (
                <p class="lede">Everything on this document was matched. Open it, check it and accept.</p>
              ) : (
                <ul>
                  {selected.proposal.notes.map((n, i) => (
                    <li key={i}>{n.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
