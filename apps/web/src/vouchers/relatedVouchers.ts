import { allocatedLinesOf, type Masters, type Voucher } from '@minimalerp/domain';

export interface RelatedVoucherEntry {
  readonly voucher: Voucher;
  readonly relationship: string;
  readonly detail: string;
  readonly amount?: bigint;
  readonly received?: bigint;
  readonly tds?: bigint;
  readonly account?: string;
}

type Content = {
  readonly accountLedgerId?: unknown;
  readonly quotationId?: unknown;
  readonly returnOf?: unknown;
  readonly reference?: unknown;
  readonly lines?: readonly {
    readonly itemId?: unknown;
    readonly description?: unknown;
    readonly qty?: unknown;
    readonly orderRef?: { readonly orderId?: unknown; readonly lineId?: unknown };
    readonly challanRef?: { readonly challanId?: unknown; readonly lineId?: unknown };
  }[];
};

const contentOf = (v: Voucher): Content => v.content as Content;
const kindOf = (v: Voucher, masters: Masters): string => masters.voucherType(v.voucherTypeId)?.baseKind ?? 'voucher';
const kindName = (v: Voucher, masters: Masters): string => masters.voucherType(v.voucherTypeId)?.name ?? 'Voucher';

function documentLinks(voucher: Voucher, masters: Masters): { target: string; detail: string }[] {
  const content = contentOf(voucher);
  const links: { target: string; detail: string }[] = [];
  if (typeof content.quotationId === 'string') links.push({ target: content.quotationId, detail: 'Sales order from quotation' });
  if (typeof content.returnOf === 'string') links.push({ target: content.returnOf, detail: 'Return of challan' });
  for (const line of content.lines ?? []) {
    const item = typeof line.itemId === 'string' ? masters.stockItem(line.itemId as never)?.name ?? 'Stock item' : typeof line.description === 'string' ? line.description : 'Written line';
    const qty = typeof line.qty === 'string' ? line.qty : '';
    const entry = `${item}${qty ? ` · ${qty}` : ''}`;
    if (typeof line.orderRef?.orderId === 'string') links.push({ target: line.orderRef.orderId, detail: `Order line · ${entry}` });
    if (typeof line.challanRef?.challanId === 'string') links.push({ target: line.challanRef.challanId, detail: `Challan line · ${entry}` });
  }
  return links;
}

function documentRelationship(source: Voucher, target: Voucher, masters: Masters): string {
  const from = kindOf(source, masters);
  const to = kindOf(target, masters);
  if (to === 'quotation') return 'Sales order from quotation';
  if ((from === 'sales' || from === 'purchase') && (to === 'salesOrder' || to === 'purchaseOrder')) return `${kindName(source, masters)} fulfillment`;
  if ((from === 'sales' || from === 'purchase') && to === 'deliveryChallan') return `${kindName(source, masters)} for challan`;
  if (from === 'salesOrder' || from === 'purchaseOrder') return `${kindName(source, masters)} fulfillment`;
  if (from === 'returnableChallan') return `${kindName(source, masters)} return`;
  if (to === 'returnableChallan') return 'Returned challan';
  if (to === 'deliveryChallan') return 'Invoiced challan';
  if (to === 'salesOrder' || to === 'purchaseOrder') return `${kindName(target, masters)} filled`;
  return 'Related document';
}

function allocationRelationship(current: Voucher, other: Voucher, ref: string, settles: boolean, masters: Masters): string {
  const currentName = kindName(current, masters);
  const otherName = kindName(other, masters);
  return settles ? `${otherName} settles ${currentName} ${ref}` : `${currentName} settled by ${otherName} ${ref}`;
}

/** Related posted vouchers with the exact allocation or document entries that link them. */
export function relatedVoucherEntries(current: Voucher, vouchers: readonly Voucher[], masters: Masters): RelatedVoucherEntry[] {
  const entries: RelatedVoucherEntry[] = [];
  const add = (entry: RelatedVoucherEntry) => {
    if (entry.voucher.id !== current.id && entry.voucher.status === 'posted') entries.push(entry);
  };

  const currentAllocations = allocatedLinesOf(current, masters);
  for (const other of vouchers) {
    if (other.id === current.id || other.status !== 'posted') continue;
    const otherAllocations = allocatedLinesOf(other, masters);
    for (const own of currentAllocations) {
      for (const ownPart of own.allocations) {
        if (ownPart.kind !== 'new' && ownPart.kind !== 'against') continue;
        const ref = (ownPart.ref ?? '').trim();
        if (!ref) continue;
        for (const theirs of otherAllocations) {
          if (theirs.ledgerId !== own.ledgerId || theirs.side === own.side) continue;
          for (const theirPart of theirs.allocations) {
            const settles = ownPart.kind === 'new' && theirPart.kind === 'against';
            const isRaisedBill = ownPart.kind === 'against' && theirPart.kind === 'new';
            if ((!settles && !isRaisedBill) || (theirPart.ref ?? '').trim() !== ref) continue;
            const settlement = settles ? theirPart : ownPart;
            const tds = settlement.tds ?? 0n;
            const accountId = contentOf(other).accountLedgerId;
            const account = typeof accountId === 'string' ? masters.ledger(accountId as never)?.name : undefined;
            add({
              voucher: other,
              relationship: allocationRelationship(current, other, ref, settles, masters),
              detail: settles ? `Against ${ref}` : `Bill ${ref}`,
              amount: settlement.amount,
              ...(account ? { account } : {}),
              ...(kindOf(other, masters) === 'receipt' || kindOf(current, masters) === 'receipt' ? { received: settlement.amount - tds, tds } : {}),
            });
          }
        }
      }
    }

    const ownLinks = documentLinks(current, masters).filter((link) => link.target === other.id);
    const otherLinks = documentLinks(other, masters).filter((link) => link.target === current.id);
    for (const link of ownLinks) add({ voucher: other, relationship: documentRelationship(current, other, masters), detail: link.detail });
    for (const link of otherLinks) add({ voucher: other, relationship: documentRelationship(other, current, masters), detail: link.detail });

    // Purchase orders created from a sales order retain its number as their reference.
    const currentKind = kindOf(current, masters);
    const otherKind = kindOf(other, masters);
    if ((currentKind === 'salesOrder' && otherKind === 'purchaseOrder' || currentKind === 'purchaseOrder' && otherKind === 'salesOrder')) {
      const salesOrder = currentKind === 'salesOrder' ? current : other;
      const purchaseOrder = currentKind === 'purchaseOrder' ? current : other;
      if (contentOf(purchaseOrder).reference === salesOrder.number) {
        add({ voucher: other, relationship: 'Purchase order for sales order', detail: `Reference ${salesOrder.number}` });
      }
    }
  }

  return entries.sort((a, b) => a.voucher.date.localeCompare(b.voucher.date) || a.voucher.number.localeCompare(b.voucher.number, undefined, { numeric: true }) || a.relationship.localeCompare(b.relationship));
}
