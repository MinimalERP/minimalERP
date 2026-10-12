import type { Masters, Voucher } from '@minimalerp/domain';
import { formatDate } from './format';
import { trimPlaces } from './salesModel';

/**
 * WHAT AN ITEM LAST WENT FOR — the rate on its latest posted sales invoice (or purchase invoice), said under a voucher line so the person
 * entering a rate has an idea of it. Read from the books, never stored: invoices only (an order or a quotation is not a sale), the latest
 * by date; to (or from) the voucher's own party if there is one, else anyone's.
 */

export type DealSide = 'sales' | 'purchase';

export interface LastDeal {
  /** As a person would have typed it: "35000", "58.25". */
  readonly rate: string;
  readonly date: string;
  /** With the party asked for (false: the latest with anyone, there being none with that party). */
  readonly own: boolean;
}

interface Deal {
  readonly rate: string;
  readonly date: string;
}

interface ItemDeals {
  latest?: Deal;
  readonly byParty: Map<string, Deal>;
}

export type LastDeals = (itemId: string, side: DealSide, partyId?: string) => LastDeal | undefined;

/** Every item's latest invoice rate, each way, read once from the posted vouchers. */
export function lastDeals(vouchers: readonly Voucher[], masters: Masters): LastDeals {
  const index: Record<DealSide, Map<string, ItemDeals>> = { sales: new Map(), purchase: new Map() };
  for (const v of vouchers) {
    if (v.status !== 'posted') continue;
    const kind = masters.voucherType(v.voucherTypeId)?.baseKind;
    if (kind !== 'sales' && kind !== 'purchase') continue;
    const c = v.content as unknown as { partyId?: string; lines?: { itemId?: string; rate?: string }[] };
    for (const l of c.lines ?? []) {
      if (typeof l.itemId !== 'string' || typeof l.rate !== 'string' || l.rate.trim() === '') continue;
      let item = index[kind].get(l.itemId);
      if (!item) index[kind].set(l.itemId, (item = { byParty: new Map() }));
      const deal: Deal = { rate: trimPlaces(l.rate), date: v.date };
      // the latest by date; of two on one day, the one posted later
      if (!item.latest || deal.date >= item.latest.date) item.latest = deal;
      if (typeof c.partyId === 'string') {
        const own = item.byParty.get(c.partyId);
        if (!own || deal.date >= own.date) item.byParty.set(c.partyId, deal);
      }
    }
  }
  return (itemId, side, partyId) => {
    const item = index[side].get(itemId);
    if (!item?.latest) return undefined;
    const own = partyId ? item.byParty.get(partyId) : undefined;
    return own ? { ...own, own: true } : { ...item.latest, own: partyId === undefined || partyId === '' };
  };
}

/** "Last sold @ ₹35000 on 27-Sep-2026" — and "(another customer)" where it was not to the voucher's own party. */
export function lastDealText(deal: LastDeal | undefined, side: DealSide): string {
  if (!deal) return '';
  const other = deal.own ? '' : side === 'sales' ? ' (another customer)' : ' (another supplier)';
  return `Last ${side === 'sales' ? 'sold' : 'bought'} @ ₹${deal.rate} on ${formatDate(deal.date as never)}${other}`;
}
