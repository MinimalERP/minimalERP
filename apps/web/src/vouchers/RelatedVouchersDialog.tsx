import type { Voucher } from '@minimalerp/domain';
import { useCommandHandler, useScope } from '../shell/hooks';
import { Hint } from '../shell/Hint';
import { formatAmount, formatDate } from './format';
import type { RelatedVoucherEntry } from './relatedVouchers';

const SCOPE = 'overlay:related-vouchers';

export function RelatedVouchersDialog({ current, entries, onOpen, onClose }: {
  current: Voucher;
  entries: readonly RelatedVoucherEntry[];
  onOpen: (voucher: Voucher) => void;
  onClose: () => void;
}) {
  useScope(SCOPE, 'overlay', true);
  useCommandHandler(SCOPE, 'app.back', () => (onClose(), true));

  return (
    <div class="overlay-backdrop" data-testid="related-vouchers-backdrop">
      <div class="palette dialog related-vouchers-dialog" role="dialog" aria-modal="true" aria-label={`Related vouchers for ${current.number}`} data-testid="related-vouchers-dialog">
        <h2 class="dialog-title">Related vouchers · {current.number}</h2>
        <div class="dialog-body related-vouchers-body">
          {entries.length === 0 ? (
            <p class="empty" data-testid="related-vouchers-empty">No related vouchers or entries are recorded for this voucher.</p>
          ) : (
            <table class="due-table" data-testid="related-vouchers-table">
              <thead>
                <tr><th>Voucher</th><th>Date</th><th>Relationship</th><th>Entry</th><th>Account</th><th class="num">Amount</th></tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => (
                  <tr key={`${entry.voucher.id}:${entry.relationship}:${i}`}>
                    <td>
                      <button type="button" class="action related-voucher-open" onClick={() => onOpen(entry.voucher)} aria-label={`Open ${entry.voucher.number}`}>
                        {entry.voucher.number}
                      </button>
                    </td>
                    <td>{formatDate(entry.voucher.date)}</td>
                    <td>{entry.relationship}</td>
                    <td>{entry.detail}</td>
                    <td>{entry.account ?? '—'}</td>
                    <td class="num">
                      {entry.received !== undefined && entry.tds !== undefined
                        ? `Received ${formatAmount(entry.received)} · TDS ${formatAmount(entry.tds)} · settled ${formatAmount(entry.amount ?? 0n)}`
                        : entry.amount !== undefined ? formatAmount(entry.amount) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div class="palette-foot">
          <Hint command="app.back" fallback="Esc">close</Hint>
          <button type="button" class="action" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
