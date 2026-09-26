import { type Voucher, isExchangeKind } from '@minimalerp/domain';
import { useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { Only } from '../shell/Only';

/** What a voucher becomes in the company it is sent to. */
const THEIR_KIND: Readonly<Record<string, string>> = { salesOrder: 'Sales Order', purchase: 'Purchase Invoice', receipt: 'Receipt' };

export type SendOutcome = { readonly text: string; readonly tone: 'ok' | 'error' };

/**
 * "Send via ERP" (ADR-0025) on a posted Purchase Order, Sales Invoice or Payment in the online books: it goes into the inbox of your
 * company whose GSTIN is this voucher's party's, as what it is to them, and waits there to be accepted or rejected. Where it cannot go
 * (no GSTIN, no such company of yours, sent already), the server says why. The status is under Transactions › Sent to Companies.
 */
export function SendViaErp({ books, voucher, scope, onDone }: { books: Books; voucher: Voucher | undefined; scope: string; onDone: (outcome: SendOutcome) => void }) {
  const [busy, setBusy] = useState(false);
  const base = voucher ? books.masters.voucherType(voucher.voucherTypeId)?.baseKind : undefined;
  if (!voucher || voucher.status !== 'posted' || !books.canSendToCompanies || !isExchangeKind(base) || busy) return null;

  const send = () => {
    setBusy(true);
    void books.sendToCompany(voucher.id).then(
      (r) => {
        setBusy(false);
        onDone(
          r.ok
            ? { text: `Sent ${voucher.number} to ${r.value.toCompany}: it waits in their inbox as a ${THEIR_KIND[r.value.toKind] ?? r.value.toKind}.`, tone: 'ok' }
            : { text: r.issues.map((i) => i.message).join(' '), tone: 'error' },
        );
      },
      (error: unknown) => {
        setBusy(false);
        onDone({ text: `Could not send it: ${String(error instanceof Error ? error.message : error)}`, tone: 'error' });
      },
    );
    return true;
  };
  return <Only scope={scope} command="voucher.sendErp" run={send} />;
}
