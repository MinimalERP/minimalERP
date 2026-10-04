import { type ColumnSpec, type LocalDate, type Masters, type Voucher, gstInvoices } from '@minimalerp/domain';
import { formatAmount, formatQuantity } from '../vouchers/format';

/**
 * Item Movement by Party: ONE ROW PER PARTY AND ITEM — what was bought from the party (In) and sold to it (Out) in the period, as quantity and
 * value. It adds up the lines of `gstInvoices()` (the same posted-invoice reading the Sales Invoice Register and GSTR-1 use), so it counts
 * invoices only: a challan, an order or a stock journal is not in it. The value is the line's taxable value — before GST.
 */

export interface PartyItemRow {
  /** Unique per party and item. */
  readonly key: string;
  readonly party: string;
  /** The item's name, or a one-time line's own description. */
  readonly item: string;
  readonly unit: string;
  readonly decimals: number;
  readonly inQty: bigint;
  readonly inValue: bigint;
  readonly outQty: bigint;
  readonly outValue: bigint;
}

/** One row per party and item on the posted Sales and Purchase Invoices dated in the period, by party and then by item. */
export function partyItemRows(vouchers: readonly Voucher[], masters: Masters, from: LocalDate, to: LocalDate): PartyItemRow[] {
  const by = new Map<string, { -readonly [K in keyof PartyItemRow]: PartyItemRow[K] }>();
  for (const side of ['purchase', 'sales'] as const) {
    for (const inv of gstInvoices({ vouchers, masters, side, range: { from, to } })) {
      for (const l of inv.lines) {
        const key = `${inv.partyId}|${l.itemId ?? `text:${l.description}`}`;
        let row = by.get(key);
        if (!row) {
          const unit = l.itemId ? masters.unit(masters.stockItem(l.itemId)?.unitId as never) : undefined;
          // a one-time line has only its GST unit code; "others" and a service's "NA" say nothing
          row = { key, party: inv.party, item: l.description, unit: unit?.symbol ?? (l.itemId || l.uqc === 'OTH' || l.uqc === 'NA' ? '' : l.uqc), decimals: unit?.decimals ?? 0, inQty: 0n, inValue: 0n, outQty: 0n, outValue: 0n };
          by.set(key, row);
        }
        if (side === 'purchase') {
          row.inQty += l.qty;
          row.inValue += l.taxable;
        } else {
          row.outQty += l.qty;
          row.outValue += l.taxable;
        }
      }
    }
  }
  return [...by.values()].sort((a, b) => a.party.localeCompare(b.party) || a.item.localeCompare(b.item));
}

const num = (q: bigint): number => Number(q) / 10_000;
const qty = (r: PartyItemRow, v: bigint): string => (v === 0n ? '' : formatQuantity(v as never, r.decimals));
const money = (m: bigint): string => (m === 0n ? '' : formatAmount(m as never));

export function partyItemColumns(): ColumnSpec<PartyItemRow>[] {
  return [
    { id: 'party', label: 'Party', type: 'text', value: (r) => r.party },
    { id: 'item', label: 'Item', type: 'text', value: (r) => r.item },
    { id: 'unit', label: 'Unit', type: 'text', value: (r) => r.unit },
    { id: 'inQty', label: 'In qty', type: 'number', align: 'right', value: (r) => num(r.inQty), text: (r) => qty(r, r.inQty) },
    { id: 'inValue', label: 'In value', type: 'money', align: 'right', value: (r) => r.inValue as never, text: (r) => money(r.inValue) },
    { id: 'outQty', label: 'Out qty', type: 'number', align: 'right', value: (r) => num(r.outQty), text: (r) => qty(r, r.outQty) },
    { id: 'outValue', label: 'Out value', type: 'money', align: 'right', value: (r) => r.outValue as never, text: (r) => money(r.outValue) },
  ];
}

/** What the shown rows add up to: the value bought and the value sold. */
export function partyItemTotals(rows: readonly PartyItemRow[]): { inward: bigint; outward: bigint } {
  let inward = 0n;
  let outward = 0n;
  for (const r of rows) {
    inward += r.inValue;
    outward += r.outValue;
  }
  return { inward, outward };
}
