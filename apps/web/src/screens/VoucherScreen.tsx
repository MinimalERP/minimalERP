import type { Frame } from '@minimalerp/command';
import { type Voucher, type VoucherKindRegistry, defaultVoucherKinds } from '@minimalerp/domain';
import type { InboxItem } from '@minimalerp/ports';
import type { Books } from '../books/books';
import { useCommandHandler, useServices, useSubscriptions } from '../shell/hooks';
import type { ScreenRef, VoucherMode } from '../shell/router';
import { resolveTypeId, voucherLayoutOf } from '../vouchers/entryHelpers';
import { kindTitle } from '../vouchers/kinds';
import { ItemInvoiceEntry } from '../vouchers/layouts/itemInvoiceEntry';
import { LedgerVoucherEntry } from '../vouchers/layouts/ledgerEntry';
import { StockVoucherEntry } from '../vouchers/layouts/stockEntry';
import { layoutOf } from '../vouchers/model';

/**
 * The voucher window's router: which layout draws a voucher type — the accounting vouchers (ledgerEntry), the item documents
 * (itemInvoiceEntry) or the Stock Journal (stockEntry). Each layout is its own component on the shared worksheet (worksheetKit).
 */
const kinds: VoucherKindRegistry = defaultVoucherKinds();

/**
 * A voucher being displayed turns to the previous / next voucher of the same type, in date-and-number order (the list's order): the ‹ › arrows
 * at its sides, ← / → or PgUp / PgDn. Turned over in the same window, so Esc still goes back to wherever it was opened from.
 */
function VoucherPaging({ frame, books, voucher }: { frame: Frame<ScreenRef>; books: Books; voucher: Voucher }) {
  const { app } = useServices();
  const same = books.vouchers
    .filter((v) => v.voucherTypeId === voucher.voucherTypeId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.number.localeCompare(b.number, undefined, { numeric: true })));
  const at = same.findIndex((v) => v.id === voucher.id);
  const prev = same[at - 1];
  const next = same[at + 1];
  const turn = (to: Voucher | undefined): boolean => {
    if (!to) return true;
    frame.state.clear(); // the next voucher's window starts from that voucher, not this one's saved state
    app.replace({ type: 'voucher', mode: 'display', id: to.id });
    return true;
  };
  useCommandHandler('screen:voucher', 'nav.pageUp', () => turn(prev));
  useCommandHandler('screen:voucher', 'nav.pageDown', () => turn(next));
  useCommandHandler('screen:voucher', 'nav.left', () => turn(prev));
  useCommandHandler('screen:voucher', 'nav.right', () => turn(next));
  return (
    <>
      <button type="button" class="voucher-turn prev" tabIndex={-1} disabled={!prev} onMouseDown={(e) => e.preventDefault()} onClick={() => turn(prev)} aria-label="Previous voucher" title={prev ? `Previous: ${prev.number} (← or PgUp)` : 'This is the first one'}>
        ‹
      </button>
      <button type="button" class="voucher-turn next" tabIndex={-1} disabled={!next} onMouseDown={(e) => e.preventDefault()} onClick={() => turn(next)} aria-label="Next voucher" title={next ? `Next: ${next.number} (→ or PgDn)` : 'This is the last one'}>
        ›
      </button>
    </>
  );
}

// ---- outer: figure out what to show ------------------------------------------------------------------------------

interface Props {
  readonly frame: Frame<ScreenRef>;
  readonly mode: VoucherMode;
  /** create: a base kind ("payment") or a voucher type id. */
  readonly typeKey?: string | undefined;
  /** display / alter: the voucher. */
  readonly id?: string | undefined;
  /** create: a sales order starts from this posted quotation. */
  readonly fromQuotation?: string | undefined;
  /** create, sales invoice: the sales order whose pending lines it starts with. */
  readonly fromOrder?: string | undefined;
  /** create: an AI Inbox proposal it starts from (and posts under the id of). */
  readonly fromInbox?: InboxItem | undefined;
}

export function VoucherScreen({ frame, mode, typeKey, id, fromOrder, fromQuotation, fromInbox }: Props) {
  const { books: host, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const books = host.current;
  const heading = mode === 'create' ? `New ${kindTitle(typeKey ?? '') ?? 'Voucher'} Voucher` : 'Voucher';

  if (!books) {
    return (
      <section class="screen" aria-labelledby="voucher-title">
        <h1 id="voucher-title">{heading}</h1>
        <p class="lede">Open a company first: press Alt+G and choose “Create Company” or “Load Demo Company”.</p>
      </section>
    );
  }
  const voucher = mode === 'create' ? undefined : books.voucher(id ?? '');
  if (mode !== 'create' && !voucher) {
    return (
      <section class="screen" aria-labelledby="voucher-title">
        <h1 id="voucher-title">Voucher</h1>
        <p class="empty">That voucher does not exist.</p>
      </section>
    );
  }
  const typeId = voucher ? voucher.voucherTypeId : resolveTypeId(books.masters, typeKey ?? '');
  // a voucher shown is its own window: turning to the next one (PgDn) starts it afresh
  const key = voucher?.id ?? 'new';
  const paging = mode === 'display' && voucher ? <VoucherPaging frame={frame} books={books} voucher={voucher} /> : null;
  const layout = typeId ? voucherLayoutOf(books.masters, typeId, kinds) : undefined;
  if (layout === 'stock') {
    return (
      <>
        {paging}
        <StockVoucherEntry key={key} frame={frame} books={books} mode={mode} typeId={typeId!} voucher={voucher} />
      </>
    );
  }
  if (layout === 'item-invoice') {
    return (
      <>
        {paging}
        <ItemInvoiceEntry key={key} frame={frame} books={books} mode={mode} typeId={typeId!} voucher={voucher} fromOrder={fromOrder} fromQuotation={fromQuotation} fromInbox={mode === 'create' ? fromInbox : undefined} />
      </>
    );
  }
  if (!typeId || !layoutOf(books.masters, typeId, kinds)) {
    return (
      <section class="screen" aria-labelledby="voucher-title">
        <h1 id="voucher-title">{heading}</h1>
        <p class="empty">This voucher type cannot be entered on this screen yet.</p>
      </section>
    );
  }
  return (
    <>
      {paging}
      <LedgerVoucherEntry key={key} frame={frame} books={books} mode={mode} typeId={typeId} voucher={voucher} fromInbox={mode === 'create' ? fromInbox : undefined} />
    </>
  );
}

