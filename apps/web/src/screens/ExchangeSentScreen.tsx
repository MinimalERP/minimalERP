import type { SentDocument } from '@minimalerp/ports';
import { useEffect, useState } from 'preact/hooks';
import { useCommandHandler, useServices, useSubscriptions } from '../shell/hooks';
import { ListView } from '../ui/ListView';

const SCOPE = 'screen:exchange-sent';
const KIND: Readonly<Record<string, string>> = { purchaseOrder: 'Purchase Order', sales: 'Sales Invoice', payment: 'Payment' };
const THEIR_KIND: Readonly<Record<string, string>> = { salesOrder: 'Sales Order', purchase: 'Purchase Invoice', receipt: 'Receipt' };
const STATUS: Readonly<Record<SentDocument['status'], string>> = { sent: 'Sent — waiting', accepted: 'Accepted', rejected: 'Rejected' };
const day = (iso: string | undefined) => (iso ? iso.slice(0, 10).split('-').reverse().join('-') : '');

/**
 * What this company sent to the owner's other companies with "Send via ERP" (ADR-0025), newest first: to whom, as what, and whether it
 * was accepted there (with the number it got) or rejected (with their reason). Enter opens our voucher.
 */
export function ExchangeSentScreen() {
  const { books: host, app } = useServices();
  useSubscriptions(host);
  const books = host.current;
  const [rows, setRows] = useState<readonly SentDocument[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!books) return;
    void books.sentToCompanies().then((r) => (r.ok ? setRows(r.value) : setProblem(r.issues.map((i) => i.message).join(' '))));
  }, [books]);

  const n = rows?.length ?? 0;
  const open = (i: number) => {
    const row = rows?.[i];
    if (row) app.navigate({ type: 'voucher', mode: 'display', id: row.voucherId });
  };
  useCommandHandler(SCOPE, 'nav.down', () => (n > 0 && setIndex((i) => Math.min(n - 1, i + 1)), true));
  useCommandHandler(SCOPE, 'nav.up', () => (setIndex((i) => Math.max(0, i - 1)), true));
  useCommandHandler(SCOPE, 'nav.activate', () => (open(index), true));

  return (
    <section class="screen" aria-labelledby="sent-title" data-testid="exchange-sent">
      <h1 id="sent-title">Sent to Companies</h1>
      <p class="lede">Vouchers sent to your other companies with Send via ERP (Alt+Shift+S on a Purchase Order, Sales Invoice or Payment).</p>
      {problem && (
        <p class="notice error" role="alert">
          {problem}
        </p>
      )}
      {!rows && !problem && <p class="empty">Loading…</p>}
      {rows && rows.length === 0 && <p class="empty">Nothing sent yet.</p>}
      {rows && rows.length > 0 && (
        <ListView
          items={rows}
          index={index}
          itemKey={(r) => r.id}
          label="Sent to companies"
          onActivate={open}
          renderItem={(r) => (
            <>
              <span class="row-title">
                {KIND[r.kind] ?? r.kind} {r.number} → {r.toCompany} ({THEIR_KIND[r.toKind] ?? r.toKind})
              </span>
              <span class="row-desc" data-status={r.status}>
                {STATUS[r.status]}
                {r.toNumber ? ` as ${r.toNumber}` : ''}
                {r.reason ? `: ${r.reason}` : ''} · sent {day(r.sentAt)}
                {r.decidedAt ? `, ${r.status} ${day(r.decidedAt)}` : ''}
              </span>
            </>
          )}
        />
      )}
    </section>
  );
}
