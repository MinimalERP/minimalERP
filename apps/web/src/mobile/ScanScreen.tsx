import type { InboxItem } from '@minimalerp/ports';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { type SharedDocument, removeSharedDocument, sharedDocuments, takeShareReceipt } from '../books/sharedDocuments';
import { switchUi } from './device';
import { entryKindOfProposal } from './entry';
import type { MobileNav } from './nav';
import { SCAN_KINDS, base64Of, noteWaiting, scanLabel, scanProblem, scanSummary, unread } from './scan';
import { Empty, Frame, Group, Row } from './ui';

/**
 * Scan: take a photo of a bill, choose a file, or share one into the app — say what it is, and it is sent to be read. What was read waits
 * below; a tap opens it in the entry page, filled in, to be checked and saved. A long press throws one away.
 */
export function ScanScreen({ books, nav }: { books: Books; nav: MobileNav }) {
  const [items, setItems] = useState<readonly InboxItem[] | undefined>(undefined);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** The file waiting for "What is it?" — photographed, chosen, or the next one shared to the app. */
  const [picked, setPicked] = useState<{ readonly file: File; readonly sharedId?: string | undefined } | undefined>(undefined);
  const [shared, setShared] = useState<readonly SharedDocument[]>([]);
  const [rejecting, setRejecting] = useState<InboxItem | undefined>(undefined);
  /** A Receipt or Payment that was read: it is completed on the desktop. */
  const [desktopOnly, setDesktopOnly] = useState<InboxItem | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const load = () => {
    void books.inbox().then(
      (r) => {
        if (!r.ok) return setError(r.issues.map((i) => i.message).join('; '));
        setItems(r.value);
        noteWaiting(books, r.value.length);
      },
      () => setError('The waiting documents could not be loaded. Check the connection and tap Refresh.'),
    );
  };
  useEffect(load, [books]);

  const take = (file: File | undefined, sharedId?: string) => {
    if (cameraRef.current) cameraRef.current.value = ''; // the same file can be chosen again
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    const problem = scanProblem(file);
    if (problem) return setError(problem);
    setError('');
    setPicked({ file, sharedId });
  };

  // documents shared to the app (the Android share sheet, or the installed site) are waiting on this device: the first is asked about at once
  useEffect(() => {
    let live = true;
    void Promise.all([sharedDocuments(), takeShareReceipt().catch(() => undefined)]).then(
      ([files, receipt]) => {
        if (!live) return;
        setShared(files);
        if (files[0]) take(files[0].file, files[0].id);
        else if (receipt && (receipt.error || receipt.files === 0)) setError(receipt.error || 'The phone did not pass the shared file on. Tap Choose file and pick it instead.');
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const send = (kind: InboxItem['kind']) => {
    const doc = picked;
    if (!doc || busy) return;
    setBusy(true);
    setNotice(`Sending ${doc.file.name || 'the photo'}…`);
    void base64Of(doc.file)
      .then((base64) => books.sendDocument(kind, { mimeType: doc.file.type, base64 }, doc.file.name))
      .then(
        (r) => {
          setBusy(false);
          setPicked(undefined);
          if (!r.ok) {
            setNotice('');
            return setError(r.issues.map((i) => i.message).join('; '));
          }
          setNotice(`Being read as a ${scanLabel(kind)}: it will appear below in about a minute.`);
          if (doc.sharedId) {
            const rest = shared.filter((s) => s.id !== doc.sharedId);
            setShared(rest);
            void removeSharedDocument(doc.sharedId);
            if (rest[0]) take(rest[0].file, rest[0].id);
          }
          // look again while it is being read (a busy reader may take up to two minutes)
          timers.current.push(...[20_000, 45_000, 90_000, 130_000].map((ms) => setTimeout(load, ms)));
        },
        () => {
          setBusy(false);
          setPicked(undefined);
          setNotice('');
          setError('The file could not be opened.');
        },
      );
  };

  const open = (item: InboxItem) => {
    if (unread(item)) return setNotice(item.proposal.notes[0]?.message ?? 'It could not be read: send it again.');
    const kind = entryKindOfProposal(item);
    if (!kind) return setDesktopOnly(item);
    nav.open({ page: 'entry', kind, proposal: item });
  };

  const reject = (item: InboxItem) => {
    setRejecting(undefined);
    void books.rejectInbox(item.id).then(
      (r) => {
        if (!r.ok) return setError(r.issues.map((i) => i.message).join('; '));
        setNotice('Thrown away.');
        load();
      },
      () => setError('It could not be thrown away. Check the connection.'),
    );
  };

  return (
    <>
      <Frame nav={nav} title="Scan">
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden data-testid="scan-camera" onChange={(e) => take((e.target as HTMLInputElement).files?.[0])} />
        <input ref={fileRef} type="file" accept="application/pdf,image/*" hidden data-testid="scan-file" onChange={(e) => take((e.target as HTMLInputElement).files?.[0])} />
        <div class="m-actions m-tall">
          <button type="button" class="m-button m-primary" data-testid="scan-photo" onClick={() => cameraRef.current?.click()}>
            Take photo
          </button>
          <button type="button" class="m-button" data-testid="scan-choose" onClick={() => fileRef.current?.click()}>
            Choose file
          </button>
        </div>
        {error ? (
          <p class="m-note bad m-strip" role="alert" data-testid="scan-error">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p class="m-note m-strip" data-testid="scan-notice">
            {notice}
          </p>
        ) : null}
        <Group title={items && items.length > 0 ? `Waiting (${items.length})` : 'Waiting'}>
          {items === undefined && !error ? <Empty>Loading…</Empty> : null}
          {items && items.length === 0 ? <Empty>Nothing is waiting. A bill you photograph, choose or share to the app appears here once it has been read.</Empty> : null}
          {(items ?? []).map((item) => {
            const s = scanSummary(item);
            return <Row key={item.id} title={s.title} sub={s.sub} value={s.value} note={s.attention ? 'Check' : undefined} tone={unread(item) ? 'bad' : undefined} onOpen={() => open(item)} onHold={() => setRejecting(item)} testId="scan-row" />;
          })}
          <button type="button" class="m-row m-add" data-testid="scan-refresh" onClick={load}>
            Refresh
          </button>
          {items && items.length > 0 ? <p class="m-note">Tap one to check and save it. Hold one to throw it away.</p> : null}
        </Group>
      </Frame>

      {picked ? (
        <div class="m-sheet-back">
          <div class="m-sheet" role="dialog" aria-label="What is it?" data-testid="scan-kind">
            <p class="m-sheet-title">What is {picked.file.name ? `“${picked.file.name}”` : 'this photo'}?</p>
            {SCAN_KINDS.map((k) => (
              <Row key={k.kind} title={k.label} sub={k.hint} onOpen={busy ? undefined : () => send(k.kind)} testId={`scan-kind-${k.kind}`} />
            ))}
            <div class="m-actions">
              <button type="button" class="m-button" disabled={busy} onClick={() => setPicked(undefined)}>
                Not now
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {rejecting ? (
        <div class="m-sheet-back">
          <div class="m-sheet" role="alertdialog" aria-label="Throw it away?">
            <p class="m-sheet-title">Throw away {scanSummary(rejecting).title}?</p>
            <p class="m-note">{scanSummary(rejecting).sub}. Nothing was put in the books.</p>
            <div class="m-actions">
              <button type="button" class="m-button" onClick={() => setRejecting(undefined)}>
                Keep it
              </button>
              <button type="button" class="m-button m-danger" data-testid="scan-reject" onClick={() => reject(rejecting)}>
                Throw away
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {desktopOnly ? (
        <div class="m-sheet-back">
          <div class="m-sheet" role="dialog" aria-label="Desktop version">
            <p class="m-sheet-title">A {scanLabel(desktopOnly.kind)} is completed in the desktop version</p>
            <p class="m-note">It stays in the list there (Transactions › AI Inbox) until it is saved.</p>
            <div class="m-actions">
              <button type="button" class="m-button" onClick={() => setDesktopOnly(undefined)}>
                Close
              </button>
              <button type="button" class="m-button m-primary" onClick={() => switchUi('desktop')}>
                Desktop version
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
