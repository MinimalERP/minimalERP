import { csvOf, parseCsvRecords } from './format';
import type { Extraction, ExtractionLine, IntakeKind } from '../intake/extraction';
import type { Masters } from '../masters/masters';
import { formatMoney } from '../money';
import { invoiceTotal } from '../vouchers/kinds/documents';
import { gstOfContent, grandTotal } from '../vouchers/kinds/gstDoc';
import type { Voucher } from '../vouchers/voucher';

/**
 * The native Vouchers/Sales Orders CSV: one row per LINE ITEM, header fields repeated per row and grouped by a
 * `docRef` column — the shape a spreadsheet-comfortable person expects (it's what Zoho's own export looks like
 * too), and mechanical to turn into an `Extraction` since the column names ARE `extraction.ts`'s own field
 * names. `kind` is a per-row column, not one fixed choice per file, so a single import/export can mix Sales
 * Invoices and Sales Orders.
 */

const HEADER_COLUMNS = ['docRef', 'kind', 'partyName', 'partyGstin', 'partyAddress', 'date', 'poNumber', 'invoiceNumber', 'dueDate', 'subtotal', 'grandTotal'] as const;
const LINE_COLUMNS = ['description', 'code', 'hsn', 'qty', 'unit', 'rate', 'amount', 'gstRate', 'lineDueDate'] as const;
const COLUMNS = [...HEADER_COLUMNS, ...LINE_COLUMNS] as const;

export interface VoucherEntry {
  readonly docRef: string;
  readonly kind: IntakeKind;
  readonly extraction: Extraction;
}

const str = (v: string): string | undefined => (v === '' ? undefined : v);

/** Groups rows sharing one `docRef` into one `Extraction` each, in the file's own order. A row whose `kind`
 *  isn't one of the five intake kinds, or with no `docRef`, is dropped (reported by the caller if it wants to). */
export function parseVouchersCsv(text: string): VoucherEntry[] {
  const order: string[] = [];
  const byRef = new Map<string, { kind: IntakeKind; rows: Record<string, string>[] }>();
  for (const r of parseCsvRecords(text)) {
    const docRef = (r['docRef'] ?? '').trim();
    const kind = (r['kind'] ?? '').trim() as IntakeKind;
    if (docRef === '' || !INTAKE_ITEM_KINDS.has(kind)) continue;
    if (!byRef.has(docRef)) {
      order.push(docRef);
      byRef.set(docRef, { kind, rows: [] });
    }
    byRef.get(docRef)?.rows.push(r);
  }
  return order.map((docRef) => {
    const { kind, rows } = byRef.get(docRef) as { kind: IntakeKind; rows: Record<string, string>[] };
    const first = rows[0] as Record<string, string>;
    const lines: ExtractionLine[] = rows.map((r) => ({
      description: str((r['description'] ?? '').trim()),
      code: str((r['code'] ?? '').trim()),
      hsn: str((r['hsn'] ?? '').trim()),
      qty: str((r['qty'] ?? '').trim()),
      unit: str((r['unit'] ?? '').trim()),
      rate: str((r['rate'] ?? '').trim()),
      amount: str((r['amount'] ?? '').trim()),
      gstRate: str((r['gstRate'] ?? '').trim()),
      dueDate: str((r['lineDueDate'] ?? '').trim()),
    }));
    const extraction: Extraction = {
      partyName: str((first['partyName'] ?? '').trim()),
      partyGstin: str((first['partyGstin'] ?? '').trim()),
      partyAddress: str((first['partyAddress'] ?? '').trim()),
      date: str((first['date'] ?? '').trim()),
      poNumber: str((first['poNumber'] ?? '').trim()),
      invoiceNumber: str((first['invoiceNumber'] ?? '').trim()),
      dueDate: str((first['dueDate'] ?? '').trim()),
      lines,
      subtotal: str((first['subtotal'] ?? '').trim()),
      grandTotal: str((first['grandTotal'] ?? '').trim()),
      bills: [],
    };
    return { docRef, kind, extraction };
  });
}

const INTAKE_ITEM_KINDS = new Set<string>(['salesOrder', 'sales', 'purchase']);

/** A sample file to start from: a two-line Sales Invoice (both rows share `docRef` SAMPLE-1, header fields
 *  repeated) and a one-line Sales Order — delete them before importing. */
export function vouchersCsvTemplate(): string {
  const acme = ['Acme Engineering Pvt Ltd', '27AAACE9659G1ZB', 'Plot 12, MIDC, Pune'];
  return csvOf([
    [...COLUMNS],
    ['SAMPLE-1', 'sales', ...acme, '2026-04-15', 'PO-7781', '', '2026-05-15', '1500.00', '1770.00', 'Bolt M8 x 25', 'BLT-825', '7318', '100', 'Nos', '10.00', '1000.00', '18', ''],
    ['SAMPLE-1', 'sales', ...acme, '2026-04-15', 'PO-7781', '', '2026-05-15', '1500.00', '1770.00', 'Machining charges', 'SRV-01', '998898', '1', 'Nos', '500.00', '500.00', '18', ''],
    ['SAMPLE-2', 'salesOrder', ...acme, '2026-04-20', 'PO-7790', '', '', '', '', 'Bolt M8 x 25', 'BLT-825', '7318', '500', 'Nos', '10.00', '5000.00', '18', '2026-05-30'],
  ]);
}

/** The same columns `parseVouchersCsv` reads — a true round trip: one row per line, `docRef` and every header
 *  field repeated on each of an entry's rows. */
export function serializeVouchersCsv(entries: readonly VoucherEntry[]): string {
  const rows: string[][] = [[...COLUMNS]];
  for (const e of entries) {
    const x = e.extraction;
    const header = [e.docRef, e.kind, x.partyName ?? '', x.partyGstin ?? '', x.partyAddress ?? '', x.date ?? '', x.poNumber ?? '', x.invoiceNumber ?? '', x.dueDate ?? '', x.subtotal ?? '', x.grandTotal ?? ''];
    if (x.lines.length === 0) {
      rows.push([...header, '', '', '', '', '', '', '', '', '']);
      continue;
    }
    for (const l of x.lines) {
      rows.push([...header, l.description ?? '', l.code ?? '', l.hsn ?? '', l.qty ?? '', l.unit ?? '', l.rate ?? '', l.amount ?? '', l.gstRate ?? '', l.dueDate ?? '']);
    }
  }
  return csvOf(rows);
}

interface VoucherContent {
  readonly partyId?: string;
  readonly partyDetails?: { readonly gstin?: string; readonly billTo?: { readonly lines?: string } };
  readonly reference?: string;
  readonly dueDate?: string;
  readonly lines?: readonly { readonly itemId?: string; readonly description?: string; readonly unit?: string; readonly qty: string; readonly rate: string; readonly gstRate?: string; readonly hsn?: string; readonly dueDate?: string }[];
}

const KIND_OF_BASE: Readonly<Record<string, IntakeKind | undefined>> = { sales: 'sales', purchase: 'purchase', salesOrder: 'salesOrder' };

/** Which vouchers Export takes: dates inclusive (ISO `yyyy-mm-dd`), `kinds` a subset — each part optional. */
export interface VoucherExportFilter {
  readonly from?: string;
  readonly to?: string;
  readonly kinds?: readonly IntakeKind[];
}

/** Reverses posted Sales Invoices, Purchase Invoices and Sales Orders back into the same row shape
 *  `parseVouchersCsv` reads — Export's half of the round trip. `docRef` is the voucher's own number. */
export function voucherEntriesOf(vouchers: readonly Voucher[], masters: Masters, filter: VoucherExportFilter = {}): VoucherEntry[] {
  const out: VoucherEntry[] = [];
  for (const v of vouchers) {
    if (v.status !== 'posted') continue;
    if ((filter.from && v.date < filter.from) || (filter.to && v.date > filter.to)) continue;
    const base = masters.voucherType(v.voucherTypeId)?.baseKind;
    const kind = base ? KIND_OF_BASE[base] : undefined;
    if (!kind || (filter.kinds && !filter.kinds.includes(kind))) continue;
    const c = v.content as unknown as VoucherContent;
    if (!Array.isArray(c.lines)) continue;
    const party = c.partyId ? masters.party(c.partyId as never) : undefined;
    const header = gstOfContent(v.content);
    const lines: ExtractionLine[] = c.lines.map((l) => {
      const item = l.itemId ? masters.stockItem(l.itemId as never) : undefined;
      return {
        description: item?.name ?? l.description,
        code: item?.code,
        hsn: l.hsn ?? item?.hsn,
        qty: l.qty,
        unit: l.unit ?? (item ? masters.unit(item.unitId)?.symbol : undefined),
        rate: l.rate,
        gstRate: l.gstRate,
        dueDate: l.dueDate,
      };
    });
    const priceable = c.lines.filter((l): l is typeof l & { qty: string; rate: string } => l.qty !== undefined && l.rate !== undefined);
    const subtotal = invoiceTotal(priceable.map((l) => ({ qty: l.qty, rate: l.rate })));
    out.push({
      docRef: v.number,
      kind,
      extraction: {
        partyName: party?.name,
        partyGstin: c.partyDetails?.gstin ?? party?.gstin,
        partyAddress: c.partyDetails?.billTo?.lines,
        date: v.date,
        poNumber: c.reference,
        dueDate: c.dueDate,
        lines,
        subtotal: kind === 'salesOrder' ? undefined : formatMoney(subtotal),
        grandTotal: kind === 'salesOrder' ? undefined : formatMoney(grandTotal(priceable.map((l) => ({ qty: l.qty, rate: l.rate, gstRate: l.gstRate })), header)),
        bills: [],
      },
    });
  }
  return out;
}
