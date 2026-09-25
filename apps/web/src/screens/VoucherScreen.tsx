import type { Frame } from '@minimalerp/command';
import { type VoucherKindRegistry, defaultVoucherKinds } from '@minimalerp/domain';
import type { InboxItem } from '@minimalerp/ports';
import { useServices, useSubscriptions } from '../shell/hooks';
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
  const layout = typeId ? voucherLayoutOf(books.masters, typeId, kinds) : undefined;
  if (layout === 'stock') {
    return <StockVoucherEntry frame={frame} books={books} mode={mode} typeId={typeId!} voucher={voucher} />;
  }
  if (layout === 'item-invoice') {
    return <ItemInvoiceEntry frame={frame} books={books} mode={mode} typeId={typeId!} voucher={voucher} fromOrder={fromOrder} fromQuotation={fromQuotation} fromInbox={mode === 'create' ? fromInbox : undefined} />;
  }
  if (!typeId || !layoutOf(books.masters, typeId, kinds)) {
    return (
      <section class="screen" aria-labelledby="voucher-title">
        <h1 id="voucher-title">{heading}</h1>
        <p class="empty">This voucher type cannot be entered on this screen yet.</p>
      </section>
    );
  }
  return <LedgerVoucherEntry frame={frame} books={books} mode={mode} typeId={typeId} voucher={voucher} fromInbox={mode === 'create' ? fromInbox : undefined} />;
}

