import type { EntityDoc } from '@minimalerp/command';
import { dayBookRows } from '@minimalerp/domain';
import type { Books } from './books';
import { formatAmount, formatDate } from '../vouchers/format';

const cache = new WeakMap<object, readonly EntityDoc[]>();

/**
 * Every voucher as a searchable document: findable by its number, party/ledger names, narration or amount (`v:12000`, `v:PAY/24-25/0012`).
 * Built once per version of the books, so a voucher posted a moment ago is found at once.
 */
export function voucherDocsOf(books: Books): readonly EntityDoc[] {
  const key = books.vouchers as object;
  const hit = cache.get(key);
  if (hit) return hit;
  const rows = dayBookRows({ vouchers: books.vouchers, lines: books.lines, masters: books.masters });
  const docs: EntityDoc[] = rows.map((r) => {
    const amount = r.debit;
    const plain = `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
    return {
      key: `voucher:${r.voucherId}`,
      kind: 'Voucher',
      scope: 'voucher',
      title: r.number,
      subtitle: [r.voucherType, formatDate(r.date), r.particulars, amount === 0n ? undefined : formatAmount(amount)].filter(Boolean).join(' · '),
      identifiers: [r.number, plain, `${amount / 100n}`],
      keywords: [r.particulars, r.narration, r.voucherType].filter((s) => s !== ''),
      badge: r.status === 'cancelled' ? 'Cancelled' : undefined,
      commandId: 'voucher.open',
      args: { id: r.voucherId, mode: 'display' },
      actions: [
        { label: 'Display voucher', commandId: 'voucher.open', args: { id: r.voucherId, mode: 'display' } },
        ...(r.status === 'posted' ? [{ label: 'Alter voucher', commandId: 'voucher.open', args: { id: r.voucherId, mode: 'alter' } }] : []),
      ],
    };
  });
  cache.set(key, docs);
  return docs;
}
