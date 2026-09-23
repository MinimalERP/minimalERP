import type { Frame } from '@minimalerp/command';
import type { InboxItem } from '@minimalerp/ports';
import { useEffect, useState } from 'preact/hooks';
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
function summaryOf(item: InboxItem): string {
  const p = item.proposal;
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

  useListNavigation(SCOPE, { count: rows.length, index: safeIndex, setIndex: (i) => (setConfirmReject(undefined), setIndex(i)), onActivate: open, wrap: true, homeEnd: true });
  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];

  return (
    <section class="screen" aria-labelledby="inbox-title" data-testid="inbox">
      {selected && <Only scope={SCOPE} command="inbox.reject" run={reject} />}
      <h1 id="inbox-title">AI Inbox</h1>
      <p class="lede">
        Documents you sent from Gmail, read and matched. Nothing here is in the books until you accept it. <Kbd chord={chord('nav.activate') ?? 'Enter'} /> open
        {chord('inbox.reject') && (
          <>
            {' '}
            · <Kbd chord={chord('inbox.reject') as string} /> reject
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
          MinimalERP panel.
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
                  {KIND_TITLES[r.kind]} · {r.proposal.party.name ?? 'party not read'}
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
