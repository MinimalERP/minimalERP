import type { LocalDate } from '../dates';
import type { StockItemId } from '../ids';
import type { Masters } from '../masters/masters';
import { formatRate, parseRate } from '../stock/quantity';
import type { Voucher } from '../vouchers/voucher';

/**
 * An item's last sale: the most recently dated posted Sales Invoice line that names it — its rate, date, party and invoice number — read
 * straight off the invoice's own content, the way the item master shows it without digging through the Sales Register. Pure and
 * derived, like every other report here; nothing stored.
 */
export interface LastSale {
  readonly rate: string;
  readonly date: LocalDate;
  readonly party: string;
  readonly number: string;
}

interface SalesContent {
  readonly partyId?: string | undefined;
  readonly lines?: readonly { readonly itemId?: string | undefined; readonly rate?: string | undefined }[] | undefined;
}

export function lastSaleOf(vouchers: readonly Voucher[], masters: Masters, itemId: StockItemId): LastSale | undefined {
  let best: LastSale | undefined;
  for (const v of vouchers) {
    if (v.status !== 'posted' || masters.voucherType(v.voucherTypeId)?.baseKind !== 'sales') continue;
    const c = v.content as SalesContent;
    const line = c.lines?.find((l) => l.itemId === itemId);
    const rate = line?.rate !== undefined ? parseRate(line.rate) : undefined;
    if (rate === undefined) continue;
    if (!best || v.date > best.date) best = { rate: formatRate(rate), date: v.date, party: masters.party(c.partyId as never)?.name ?? '', number: v.number };
  }
  return best;
}
