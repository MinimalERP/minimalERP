import type { Voucher } from '@minimalerp/domain';
import type { Books } from '../books/books';
import { FieldsDialog } from '../screens/ReportDialogs';
import type { DocketDoc } from '../ui/PrintView';
import { defaultDate } from './entryHelpers';
import { formatDate, parseDateInput } from './format';
import { dispatchDocketOf } from './invoicePrint';

/**
 * The dispatch docket is only a print: nothing of it is stored in the books. The one thing remembered is the last Dispatch No. used, in this
 * browser, so the next one is offered already counted on (OD-2026-00125 → OD-2026-00126) — still editable.
 */
const lastNoKey = (books: Books) => `minimalerp:dispatch-no:${books.companyId}`;
function nextDispatchNo(books: Books, date: string): string {
  let last: string | null = null;
  try {
    last = window.localStorage.getItem(lastNoKey(books));
  } catch {
    // blocked storage: start a fresh series
  }
  const m = last ? /^(.*?)(\d+)$/.exec(last) : null;
  if (!m) return `OD-${date.slice(0, 4)}-00001`;
  const [, head = '', digits = '0'] = m;
  return `${head}${String(Number(digits) + 1).padStart(digits.length, '0')}`;
}
function rememberDispatchNo(books: Books, no: string): void {
  try {
    window.localStorage.setItem(lastNoKey(books), no);
  } catch {
    // not remembered: the next one is typed
  }
}

/** Asks for what the invoices do not say (Dispatch No., date, packages, transporter, LR No.) and hands back the docket to print. */
export function DocketDialog({ books, vouchers, onDone }: { books: Books; vouchers: readonly Voucher[]; onDone: (doc: DocketDoc | undefined) => void }) {
  const today = defaultDate(books.masters);
  const fy = books.masters.financialYears.find((y) => today >= y.start && today <= y.end) ?? books.masters.financialYears.at(-1);
  const ctx = { start: fy?.start ?? today, end: fy?.end ?? today, base: today };
  return (
    <FieldsDialog
      title={`Dispatch docket — ${vouchers.length} invoice${vouchers.length === 1 ? '' : 's'}`}
      enterOnly
      fields={[
        { key: 'dispatchNo', label: 'Dispatch No.', value: nextDispatchNo(books, today) },
        { key: 'date', label: 'Date', value: formatDate(today), hint: 'a date like 25-9-26' },
        { key: 'packages', label: 'Packages', value: '', hint: 'how many boxes / packages' },
        { key: 'transporter', label: 'Transporter', value: '' },
        { key: 'lrNo', label: 'LR No.', value: '' },
      ]}
      validate={(v) => {
        const errs: Record<string, string> = {};
        if ((v['dispatchNo'] ?? '').trim() === '') errs['dispatchNo'] = 'Enter the dispatch number';
        if (!parseDateInput(v['date'] ?? '', ctx)) errs['date'] = 'That is not a date';
        return errs;
      }}
      onDone={(v) => {
        if (!v) return onDone(undefined);
        const dispatchNo = (v['dispatchNo'] ?? '').trim();
        const doc = dispatchDocketOf(vouchers, books, {
          dispatchNo,
          date: parseDateInput(v['date'] ?? '', ctx) ?? today,
          packages: (v['packages'] ?? '').trim(),
          transporter: (v['transporter'] ?? '').trim(),
          lrNo: (v['lrNo'] ?? '').trim(),
        });
        if (typeof doc === 'string') return onDone(undefined);
        rememberDispatchNo(books, dispatchNo);
        onDone(doc);
      }}
    />
  );
}
