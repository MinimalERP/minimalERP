import { type ColumnSpec, type Gstr2bRow, type Gstr2bStatus, GSTR2B_STATUS_LABELS, gstr2bPeriodLabel } from '@minimalerp/domain';
import { formatAmount, formatDate } from '../vouchers/format';

/**
 * GSTR-2B matching on the one grid: a row per invoice — of the file, of the books, or of both — with the status the matching gave it and
 * the figures of each side next to each other. The matching itself is the domain's (`matchGstr2b`); this is the columns.
 */

export type Gstr2bGridRow = Gstr2bRow & { readonly rowType: 'gstr2b' };

export const gstr2bGridRows = (rows: readonly Gstr2bRow[]): Gstr2bGridRow[] => rows.map((r) => ({ ...r, rowType: 'gstr2b' }));

const STATUSES: readonly Gstr2bStatus[] = ['mismatch', 'not-in-books', 'not-on-portal', 'matched'];
const money0 = (m: bigint | undefined): string => (m === undefined ? '' : formatAmount(m as never));
const taxOf = (f: Gstr2bRow['book']): bigint | undefined => (f ? f.cgst + f.sgst + f.igst : undefined);

export function gstr2bColumns(): ColumnSpec<Gstr2bGridRow>[] {
  return [
    { id: 'status', label: 'Status', type: 'choice', value: (r) => GSTR2B_STATUS_LABELS[r.status], choices: STATUSES.map((s) => ({ value: GSTR2B_STATUS_LABELS[s], label: GSTR2B_STATUS_LABELS[s] })) },
    { id: 'supplier', label: 'Supplier', type: 'text', value: (r) => r.supplier },
    { id: 'gstin', label: 'GSTIN', type: 'text', value: (r) => r.gstin },
    { id: 'number', label: 'Supplier inv no.', type: 'text', value: (r) => r.number },
    { id: 'fileDate', label: 'Inv date', type: 'date', value: (r) => r.fileDate ?? '', text: (r) => (r.fileDate ? formatDate(r.fileDate) : '') },
    { id: 'voucher', label: 'Voucher', type: 'text', value: (r) => r.voucherNumber ?? '' },
    { id: 'bookDate', label: 'Entered on', type: 'date', value: (r) => r.bookDate ?? '', text: (r) => (r.bookDate ? formatDate(r.bookDate) : '') },
    { id: 'fileTaxable', label: 'Taxable (GST site)', type: 'money', align: 'right', value: (r) => r.file?.taxable ?? (0n as never), text: (r) => money0(r.file?.taxable) },
    { id: 'bookTaxable', label: 'Taxable (books)', type: 'money', align: 'right', value: (r) => r.book?.taxable ?? (0n as never), text: (r) => money0(r.book?.taxable) },
    { id: 'fileTax', label: 'GST (GST site)', type: 'money', align: 'right', value: (r) => (taxOf(r.file) ?? 0n) as never, text: (r) => money0(taxOf(r.file)) },
    { id: 'bookTax', label: 'GST (books)', type: 'money', align: 'right', value: (r) => (taxOf(r.book) ?? 0n) as never, text: (r) => money0(taxOf(r.book)) },
    { id: 'tagged', label: 'Tagged', type: 'text', value: (r) => (r.tagged ? `2B ${gstr2bPeriodLabel(r.tagged)}` : '') },
    { id: 'note', label: 'Note', type: 'text', value: (r) => r.note },
  ];
}
