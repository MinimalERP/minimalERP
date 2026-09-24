import { csvOf } from '../csv/format';
import type { DateRange, LocalDate } from '../dates';
import { type TaxSlab, canonicalPercent, isIntraState, percentHundredths } from '../gst/tax';
import type { StockItemId, VoucherId } from '../ids';
import type { Masters } from '../masters/masters';
import { GST_STATE_CODES, gstinProblem, stateOfGstin } from '../masters/rules';
import type { SystemLedgerKey } from '../masters/systemLedgers';
import { type Money, ZERO, allocateMoney, formatMoney, money } from '../money';
import type { JournalLine } from '../posting/plan';
import { type Qty, parseQty } from '../stock/quantity';
import { type PartyDetails } from '../vouchers/drafts';
import { lineValue } from '../vouchers/kinds/documents';
import { breakdownOf, gstOfContent, lineGstRate } from '../vouchers/kinds/gstDoc';
import type { Voucher } from '../vouchers/voucher';

/**
 * GSTR-1 and GSTR-3B, as REPORTS (ADR-0019): pure functions of the posted Sales and Purchase Invoices and the journal — nothing is stored, nothing is
 * posted, and every figure is the invoice's own (its header and its lines, added up by the same `computeGst` the posting used), so it can be followed
 * back from a report row to the voucher and from the voucher to the ledger. The reports state what the books hold; they do not file anything.
 */

export type GstSide = 'sales' | 'purchase';

export interface GstLineFact {
  /** Absent on a one-time (written) line. */
  readonly itemId: StockItemId | undefined;
  /** What the line is: the item's name, or a one-time line's text. */
  readonly description: string;
  readonly hsn: string;
  /** The GST unit quantity code: NOS, KGS, LTR… */
  readonly uqc: string;
  readonly qty: Qty;
  readonly rate: string;
  readonly taxable: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
}

export interface GstInvoice {
  readonly voucherId: VoucherId;
  readonly number: string;
  readonly date: LocalDate;
  readonly side: GstSide;
  readonly partyId: string;
  readonly party: string;
  readonly gstin: string;
  readonly registration: PartyDetails['gstRegistration'];
  /** Where the supply is made to (sales) — or, on a purchase, the company's state — as a two-digit code, '' when nothing says. */
  readonly placeOfSupply: string;
  readonly supplyState: string;
  readonly intra: boolean;
  /** The invoice states its GST (a header): false for an invoice made while GST was off, or with no rated line. */
  readonly hasGst: boolean;
  readonly slabs: readonly TaxSlab[];
  readonly taxable: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
  readonly tax: Money;
  /** The invoice total: the items plus the tax. */
  readonly value: Money;
  readonly lines: readonly GstLineFact[];
  /** Lines (1-based) that name no GST rate at all. */
  readonly unrated: readonly number[];
}

const UQC: Readonly<Record<string, string>> = { Nos: 'NOS', Kg: 'KGS', Ltr: 'LTR', Mtr: 'MTR', Box: 'BOX' };

interface Content {
  partyId?: string;
  partyDetails?: PartyDetails;
  lines?: { itemId?: string; description?: string; unit?: string; qty: string; rate: string; gstRate?: string; hsn?: string }[];
}

const inRange = (d: LocalDate, r: DateRange): boolean => (r.from === undefined || d >= r.from) && (r.to === undefined || d <= r.to);

/** The posted invoices of one side dated in the period, oldest first, each read back into its taxable value, tax and lines. */
export function gstInvoices({ vouchers, masters, side, range }: { vouchers: readonly Voucher[]; masters: Masters; side: GstSide; range: DateRange }): GstInvoice[] {
  const out: GstInvoice[] = [];
  for (const v of vouchers) {
    if (v.status !== 'posted' || !inRange(v.date, range)) continue;
    if (masters.voucherType(v.voucherTypeId)?.baseKind !== (side === 'sales' ? 'sales' : 'purchase')) continue;
    const c = v.content as unknown as Content;
    if (!Array.isArray(c.lines) || typeof c.partyId !== 'string') continue;
    const header = gstOfContent(v.content);
    const b = breakdownOf(c.lines, header);
    const party = masters.party(c.partyId as never);
    const d = c.partyDetails;
    const gstin = (d?.gstin ?? party?.gstin ?? '').trim();
    const own = masters.company.stateCode ?? '';
    const partyState = d?.placeOfSupply || d?.billTo?.stateCode || (gstin && !gstinProblem(gstin) ? stateOfGstin(gstin) : '') || party?.stateCode || '';
    const supplyState = header?.supplyState ?? (side === 'sales' ? own : partyState);
    const placeOfSupply = header?.placeOfSupply ?? (side === 'sales' ? partyState : own);

    // each rate's tax is shared out over its lines in proportion to their taxable value, so the lines add up to the invoice to the paisa
    const facts: GstLineFact[] = c.lines.map((l) => {
      const item = l.itemId ? masters.stockItem(l.itemId as never) : undefined;
      const unit = item ? masters.unit(item.unitId)?.symbol : l.unit;
      return {
        itemId: l.itemId as StockItemId | undefined,
        description: item?.name ?? l.description ?? '',
        hsn: (l.hsn ?? item?.hsn ?? '').trim(),
        // a one-time line without a unit: GST's code for "others"
        uqc: unit ? (UQC[unit] ?? unit.toUpperCase()) : l.itemId === undefined ? 'OTH' : '',
        qty: (parseQty(l.qty) ?? 0n) as Qty,
        rate: canonicalPercent(lineGstRate(l)),
        taxable: lineValue(l),
        cgst: ZERO,
        sgst: ZERO,
        igst: ZERO,
      };
    });
    for (const slab of b.slabs) {
      const idx = facts.map((f, i) => (f.rate === slab.rate ? i : -1)).filter((i) => i >= 0);
      const weights = idx.map((i) => (facts[i] as GstLineFact).taxable);
      if (weights.every((w) => w === 0n)) continue;
      const share = (total: Money): Money[] => (total === 0n ? idx.map(() => ZERO) : allocateMoney(total, weights));
      const [cg, sg, ig] = [share(slab.cgst), share(slab.sgst), share(slab.igst)];
      idx.forEach((i, k) => {
        facts[i] = { ...(facts[i] as GstLineFact), cgst: cg[k] as Money, sgst: sg[k] as Money, igst: ig[k] as Money };
      });
    }
    out.push({
      voucherId: v.id,
      number: v.number,
      date: v.date,
      side,
      partyId: c.partyId,
      party: party?.name ?? d?.mailingName ?? '',
      gstin,
      registration: d?.gstRegistration ?? party?.gstRegistration ?? (gstin ? 'regular' : undefined),
      placeOfSupply,
      supplyState,
      intra: header ? isIntraState(header.supplyState, header.placeOfSupply) : true,
      hasGst: header !== undefined,
      slabs: b.slabs,
      taxable: b.taxable,
      cgst: b.cgst,
      sgst: b.sgst,
      igst: b.igst,
      tax: b.tax,
      value: money(b.taxable + b.tax),
      lines: facts.map(({ ...f }) => f),
      unrated: c.lines.flatMap((l, i) => (lineGstRate(l) === undefined ? [i + 1] : [])),
    });
  }
  return out.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
}

// ---- GSTR-1 ------------------------------------------------------------------------------------------------------------

export type Gstr1Section = 'B2B' | 'B2CL' | 'B2CS' | 'Export';

/** An unregistered customer's inter-state invoice above this is reported invoice by invoice (B2CL): ₹2,50,000. */
export const B2CL_LIMIT: Money = money(25_000_000n);

export function gstr1Section(inv: GstInvoice): Gstr1Section {
  if (inv.registration === 'overseas') return 'Export';
  if (inv.gstin !== '' && !gstinProblem(inv.gstin)) return 'B2B';
  if (!inv.intra && inv.value > B2CL_LIMIT) return 'B2CL';
  return 'B2CS';
}

export interface Gstr1Row {
  readonly rowType: 'gstr1';
  /** Unique per invoice and rate. */
  readonly key: string;
  readonly voucherId: VoucherId;
  readonly number: string;
  readonly date: LocalDate;
  readonly party: string;
  readonly gstin: string;
  readonly placeOfSupply: string;
  readonly section: Gstr1Section;
  readonly rate: string;
  readonly taxable: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
  /** The whole invoice's value (the same on each of its rate rows). */
  readonly value: Money;
  /** The HSN codes on the invoice, so the grid's search finds an invoice by its HSN. */
  readonly hsns: string;
}

/** One row per invoice and rate, in invoice order — the invoice-level GSTR-1. */
export function gstr1Rows(invoices: readonly GstInvoice[]): Gstr1Row[] {
  return invoices.flatMap((inv) =>
    inv.slabs.map((s) => ({
      rowType: 'gstr1' as const,
      key: `${inv.voucherId}|${s.rate}`,
      voucherId: inv.voucherId,
      number: inv.number,
      date: inv.date,
      party: inv.party,
      gstin: inv.gstin,
      placeOfSupply: inv.placeOfSupply,
      section: gstr1Section(inv),
      rate: s.rate,
      taxable: s.taxable,
      cgst: s.cgst,
      sgst: s.sgst,
      igst: s.igst,
      value: inv.value,
      hsns: [...new Set(inv.lines.filter((l) => l.rate === s.rate).map((l) => l.hsn).filter((h) => h !== ''))].join(', '),
    })),
  );
}

export interface GstTotals {
  readonly invoices: number;
  readonly taxable: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
  readonly tax: Money;
  readonly value: Money;
}

export function gstTotals(invoices: readonly GstInvoice[]): GstTotals {
  const sum = (pick: (i: GstInvoice) => bigint): Money => money(invoices.reduce((t, i) => t + pick(i), 0n));
  return { invoices: invoices.length, taxable: sum((i) => i.taxable), cgst: sum((i) => i.cgst), sgst: sum((i) => i.sgst), igst: sum((i) => i.igst), tax: sum((i) => i.tax), value: sum((i) => i.value) };
}

export interface HsnRow {
  readonly rowType: 'hsn';
  readonly key: string;
  readonly hsn: string;
  readonly uqc: string;
  readonly rate: string;
  readonly qty: Qty;
  readonly taxable: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
  readonly value: Money;
  /** The invoice lines behind the row (voucher and line), for tracing it back. */
  readonly invoices: number;
}

/** The HSN-wise summary: per HSN, unit and rate — read from the invoice lines' own HSN (a snapshot of the item's at the time), so it adds up to the invoices. */
export function hsnRows(invoices: readonly GstInvoice[]): HsnRow[] {
  const by = new Map<string, { hsn: string; uqc: string; rate: string; qty: bigint; taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint; vouchers: Set<string> }>();
  for (const inv of invoices) {
    for (const l of inv.lines) {
      const key = `${l.hsn}|${l.uqc}|${l.rate}`;
      const row = by.get(key) ?? { hsn: l.hsn, uqc: l.uqc, rate: l.rate, qty: 0n, taxable: 0n, cgst: 0n, sgst: 0n, igst: 0n, vouchers: new Set<string>() };
      row.qty += l.qty;
      row.taxable += l.taxable;
      row.cgst += l.cgst;
      row.sgst += l.sgst;
      row.igst += l.igst;
      row.vouchers.add(inv.voucherId);
      by.set(key, row);
    }
  }
  return [...by.entries()]
    .map(([key, r]) => ({
      rowType: 'hsn' as const,
      key,
      hsn: r.hsn,
      uqc: r.uqc,
      rate: r.rate,
      qty: r.qty as Qty,
      taxable: money(r.taxable),
      cgst: money(r.cgst),
      sgst: money(r.sgst),
      igst: money(r.igst),
      value: money(r.taxable + r.cgst + r.sgst + r.igst),
      invoices: r.vouchers.size,
    }))
    .sort((a, b) => (a.hsn !== b.hsn ? (a.hsn < b.hsn ? -1 : 1) : Number(percentHundredths(a.rate) - percentHundredths(b.rate))));
}

// ---- validation ----------------------------------------------------------------------------------------------------------

export interface GstIssue {
  /** An error blocks the export; a warning is said but does not. */
  readonly severity: 'error' | 'warning';
  readonly voucherId?: VoucherId | undefined;
  readonly number?: string | undefined;
  readonly message: string;
}

/** What is missing or wrong in the data the return is built from — said before anything is exported. Nothing is invented to fill a gap. */
export function gstr1Validation(masters: Masters, invoices: readonly GstInvoice[]): GstIssue[] {
  const out: GstIssue[] = [];
  const c = masters.company;
  if (c.chargeGst !== true) out.push({ severity: 'warning', message: 'GST is not switched on for this company (Company settings › Charge GST): invoices made now carry no GST' });
  if (!c.gstin) out.push({ severity: 'error', message: 'The company has no GSTIN: set it in Company settings' });
  else if (gstinProblem(c.gstin)) out.push({ severity: 'error', message: `The company’s GSTIN is not valid: ${gstinProblem(c.gstin)}` });
  if (!c.stateCode) out.push({ severity: 'error', message: 'The company has no state: set it in Company settings' });

  for (const inv of invoices) {
    const at = { voucherId: inv.voucherId, number: inv.number };
    const registered = inv.registration === 'regular' || inv.registration === 'composition' || inv.registration === 'sez';
    if (inv.gstin !== '') {
      const p = gstinProblem(inv.gstin);
      if (p) out.push({ severity: 'error', ...at, message: `${inv.party}: the GSTIN ${inv.gstin} is not valid (${p})` });
    } else if (registered) {
      out.push({ severity: 'error', ...at, message: `${inv.party} is registered (${inv.registration}) but the invoice has no GSTIN` });
    }
    if (inv.placeOfSupply === '') out.push({ severity: 'error', ...at, message: 'The place of supply is not known: give the party a state (or set it in Party details)' });
    else if (!GST_STATE_CODES.has(inv.placeOfSupply)) out.push({ severity: 'error', ...at, message: `The place of supply ${inv.placeOfSupply} is not a GST state code` });
    if (inv.registration === 'overseas') out.push({ severity: 'warning', ...at, message: `${inv.party} is overseas: export invoices are listed, but exports are not modelled (no shipping-bill details)` });
    if (masters.company.chargeGst === true && inv.unrated.length > 0) {
      out.push({ severity: 'error', ...at, message: `Line ${inv.unrated.join(', ')} ${inv.unrated.length === 1 ? 'has' : 'have'} no GST rate: enter 0 for a nil-rated supply` });
    }
    const noHsn = inv.lines.map((l, i) => (l.hsn === '' ? i + 1 : 0)).filter((i) => i > 0);
    if (noHsn.length > 0) out.push({ severity: 'warning', ...at, message: `Line ${noHsn.join(', ')} ${noHsn.length === 1 ? 'has' : 'have'} no HSN: set it on the item` });
  }
  return out;
}

// ---- reconciliation with the journal -------------------------------------------------------------------------------------

export interface HeadCheck {
  readonly head: 'CGST' | 'SGST' | 'IGST';
  /** What the invoices say. */
  readonly report: Money;
  /** What the journal says: the lines the same vouchers posted to the tax ledger. */
  readonly ledger: Money;
  readonly ok: boolean;
}

/**
 * Whether the tax the invoices state is the tax the books hold: for the invoices of the period, the amounts on their headers against the lines those
 * same vouchers posted to the Output (sales) or Input (purchase) ledgers. Equal by construction — this is the check that says so.
 */
export function gstReconciliation({ invoices, lines, masters, side }: { invoices: readonly GstInvoice[]; lines: Iterable<JournalLine>; masters: Masters; side: GstSide }): HeadCheck[] {
  const ids = new Set<string>(invoices.map((i) => i.voucherId));
  const kind = side === 'sales' ? 'output' : 'input';
  const ledgerOf = (h: 'cgst' | 'sgst' | 'igst') => masters.systemLedger(`gst-${kind}-${h}` as SystemLedgerKey)?.id;
  const journal = { cgst: 0n, sgst: 0n, igst: 0n };
  for (const l of lines) {
    if (!ids.has(l.voucherId)) continue;
    for (const h of ['cgst', 'sgst', 'igst'] as const) {
      if (l.ledgerId === ledgerOf(h)) journal[h] += side === 'sales' ? (l.side === 'credit' ? l.amount : -l.amount) : l.side === 'debit' ? l.amount : -l.amount;
    }
  }
  const report = gstTotals(invoices);
  return (['cgst', 'sgst', 'igst'] as const).map((h) => ({ head: h.toUpperCase() as HeadCheck['head'], report: report[h], ledger: money(journal[h]), ok: report[h] === journal[h] }));
}

// ---- GSTR-1 export -------------------------------------------------------------------------------------------------------

const amt = (m: Money): number => Number(formatMoney(m));
const ddmmyyyy = (d: string): string => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
const tax = (s: { taxable: Money; cgst: Money; sgst: Money; igst: Money }, rate: string) => ({ rt: Number(rate), txval: amt(s.taxable), iamt: amt(s.igst), camt: amt(s.cgst), samt: amt(s.sgst), csamt: 0 });

export interface Gstr1Export {
  /** The structured return, in the shape the GST offline tool reads (b2b / b2cl / b2cs / hsn), ready for a later portal integration. */
  readonly json: Record<string, unknown>;
  readonly invoicesCsv: string;
  readonly hsnCsv: string;
}

/** The GSTR-1 of a month as structured data. It says nothing the invoices do not: what is missing stays missing (see `gstr1Validation`). */
export function gstr1Export({ masters, invoices, period }: { masters: Masters; invoices: readonly GstInvoice[]; period: { from: LocalDate } }): Gstr1Export {
  const fp = `${period.from.slice(5, 7)}${period.from.slice(0, 4)}`;
  const sectionOf = (i: GstInvoice) => gstr1Section(i);
  const items = (inv: GstInvoice) => inv.slabs.map((s, n) => ({ num: n + 1, itm_det: tax(s, s.rate) }));

  const b2bBy = new Map<string, GstInvoice[]>();
  for (const inv of invoices.filter((i) => sectionOf(i) === 'B2B')) b2bBy.set(inv.gstin, [...(b2bBy.get(inv.gstin) ?? []), inv]);
  const b2b = [...b2bBy.entries()].map(([ctin, invs]) => ({
    ctin,
    inv: invs.map((i) => ({ inum: i.number, idt: ddmmyyyy(i.date), val: amt(i.value), pos: i.placeOfSupply, rchrg: 'N', inv_typ: 'R', itms: items(i) })),
  }));

  const b2clBy = new Map<string, GstInvoice[]>();
  for (const inv of invoices.filter((i) => sectionOf(i) === 'B2CL')) b2clBy.set(inv.placeOfSupply, [...(b2clBy.get(inv.placeOfSupply) ?? []), inv]);
  const b2cl = [...b2clBy.entries()].map(([pos, invs]) => ({ pos, inv: invs.map((i) => ({ inum: i.number, idt: ddmmyyyy(i.date), val: amt(i.value), itms: items(i) })) }));

  // B2CS is a summary: by place of supply, rate and whether within the state
  const b2cs = new Map<string, { sply_ty: string; pos: string; rate: string; taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint }>();
  for (const inv of invoices.filter((i) => sectionOf(i) === 'B2CS')) {
    for (const s of inv.slabs) {
      const key = `${inv.placeOfSupply}|${s.rate}|${inv.intra}`;
      const r = b2cs.get(key) ?? { sply_ty: inv.intra ? 'INTRA' : 'INTER', pos: inv.placeOfSupply, rate: s.rate, taxable: 0n, cgst: 0n, sgst: 0n, igst: 0n };
      r.taxable += s.taxable;
      r.cgst += s.cgst;
      r.sgst += s.sgst;
      r.igst += s.igst;
      b2cs.set(key, r);
    }
  }
  const b2csRows = [...b2cs.values()].map((r) => ({ sply_ty: r.sply_ty, typ: 'OE', pos: r.pos, ...tax({ taxable: money(r.taxable), cgst: money(r.cgst), sgst: money(r.sgst), igst: money(r.igst) }, r.rate) }));

  const hsn = hsnRows(invoices).map((h, n) => ({ num: n + 1, hsn_sc: h.hsn, uqc: h.uqc, qty: Number(h.qty) / 10_000, val: amt(h.value), txval: amt(h.taxable), iamt: amt(h.igst), camt: amt(h.cgst), samt: amt(h.sgst), csamt: 0 }));

  const invoicesCsv = csvOf([
    ['Invoice no', 'Date', 'Customer', 'GSTIN', 'Place of supply', 'Type', 'Rate %', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Invoice value'],
    ...gstr1Rows(invoices).map((r) => [r.number, r.date, r.party, r.gstin, r.placeOfSupply, r.section, r.rate, formatMoney(r.taxable), formatMoney(r.cgst), formatMoney(r.sgst), formatMoney(r.igst), formatMoney(r.value)]),
  ]);
  const hsnCsv = csvOf([
    ['HSN', 'UQC', 'Rate %', 'Quantity', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Total value'],
    ...hsnRows(invoices).map((h) => [h.hsn, h.uqc, h.rate, Number(h.qty) / 10_000, formatMoney(h.taxable), formatMoney(h.cgst), formatMoney(h.sgst), formatMoney(h.igst), formatMoney(h.value)]),
  ]);

  return { json: { gstin: masters.company.gstin ?? '', fp, b2b, b2cl, b2cs: b2csRows, hsn: { data: hsn } }, invoicesCsv, hsnCsv };
}

// ---- GSTR-3B -------------------------------------------------------------------------------------------------------------

export interface Gstr3bRow {
  readonly rowType: 'gstr3b';
  readonly key: string;
  /** Which invoices lie behind the row, for the drill: the period's sales or purchases (none for a computed row). */
  readonly drill: GstSide | undefined;
  readonly label: string;
  /** Heading rows have no figures. */
  readonly heading: boolean;
  readonly taxable: Money | undefined;
  readonly cgst: Money | undefined;
  readonly sgst: Money | undefined;
  readonly igst: Money | undefined;
  readonly total: Money | undefined;
  /** Something a reader should look at (input tax whose eligibility is not established). */
  readonly review: boolean;
}

export interface Gstr3b {
  readonly rows: Gstr3bRow[];
  readonly sales: GstInvoice[];
  readonly purchases: GstInvoice[];
  readonly output: { cgst: Money; sgst: Money; igst: Money; tax: Money };
  /** Input tax on the period's purchases whose eligibility the books cannot establish. */
  readonly toReview: { taxable: Money; cgst: Money; sgst: Money; igst: Money; tax: Money };
  /** Input tax marked eligible: none can be, from the data the invoices hold. */
  readonly eligible: { cgst: Money; sgst: Money; igst: Money; tax: Money };
  /** Output tax less the eligible input tax (what is payable if nothing under review is claimed). */
  readonly net: { cgst: Money; sgst: Money; igst: Money; tax: Money };
  /** The same, as if every input tax under review were found eligible. */
  readonly netIfAllEligible: { cgst: Money; sgst: Money; igst: Money; tax: Money };
  readonly reconciliation: { sales: HeadCheck[]; purchases: HeadCheck[] };
}

/**
 * Whether the tax on a purchase is claimable as input tax credit. The books cannot say: a supplier's GSTIN does not settle it (blocked credits, a
 * supplier who has not filed, goods for personal use…), and an invoice carries no eligibility. So every purchase's tax is "to review" — shown
 * separately, never silently claimed. This is the one place to change if the invoice ever records a decision.
 */
export const itcStatus = (_inv: GstInvoice): 'eligible' | 'to-review' => 'to-review';

const zero4 = () => ({ cgst: 0n, sgst: 0n, igst: 0n });

export function gstr3b({ vouchers, lines, masters, range }: { vouchers: readonly Voucher[]; lines: Iterable<JournalLine>; masters: Masters; range: DateRange }): Gstr3b {
  const journal = [...lines];
  const sales = gstInvoices({ vouchers, masters, side: 'sales', range });
  const purchases = gstInvoices({ vouchers, masters, side: 'purchase', range });

  const outTaxable = { taxable: 0n, ...zero4() };
  let nil = 0n;
  for (const inv of sales) {
    for (const s of inv.slabs) {
      if (s.rate === '0') nil += s.taxable;
      else {
        outTaxable.taxable += s.taxable;
        outTaxable.cgst += s.cgst;
        outTaxable.sgst += s.sgst;
        outTaxable.igst += s.igst;
      }
    }
  }
  const inToReview = { taxable: 0n, ...zero4() };
  const inEligible = zero4();
  let inNil = 0n;
  for (const inv of purchases) {
    for (const s of inv.slabs) {
      if (s.rate === '0') inNil += s.taxable;
      else if (itcStatus(inv) === 'eligible') {
        inEligible.cgst += s.cgst;
        inEligible.sgst += s.sgst;
        inEligible.igst += s.igst;
      } else {
        inToReview.taxable += s.taxable;
        inToReview.cgst += s.cgst;
        inToReview.sgst += s.sgst;
        inToReview.igst += s.igst;
      }
    }
  }
  const t = (x: { cgst: bigint; sgst: bigint; igst: bigint }): Money => money(x.cgst + x.sgst + x.igst);
  const heads = (x: { cgst: bigint; sgst: bigint; igst: bigint }) => ({ cgst: money(x.cgst), sgst: money(x.sgst), igst: money(x.igst), tax: t(x) });
  const minus = (a: { cgst: bigint; sgst: bigint; igst: bigint }, b: { cgst: bigint; sgst: bigint; igst: bigint }) => ({ cgst: a.cgst - b.cgst, sgst: a.sgst - b.sgst, igst: a.igst - b.igst });
  const plus = (a: { cgst: bigint; sgst: bigint; igst: bigint }, b: { cgst: bigint; sgst: bigint; igst: bigint }) => ({ cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst, igst: a.igst + b.igst });

  const output = heads(outTaxable);
  const toReview = { taxable: money(inToReview.taxable), ...heads(inToReview) };
  const eligible = heads(inEligible);
  const net = heads(minus(outTaxable, inEligible));
  const netIfAll = heads(minus(outTaxable, plus(inEligible, inToReview)));

  const row = (key: string, label: string, drill: GstSide | undefined, f: { taxable?: bigint; cgst?: bigint; sgst?: bigint; igst?: bigint }, review = false): Gstr3bRow => {
    const total = (f.cgst ?? 0n) + (f.sgst ?? 0n) + (f.igst ?? 0n);
    return { rowType: 'gstr3b', key, drill, label, heading: false, taxable: f.taxable === undefined ? undefined : money(f.taxable), cgst: f.cgst === undefined ? undefined : money(f.cgst), sgst: f.sgst === undefined ? undefined : money(f.sgst), igst: f.igst === undefined ? undefined : money(f.igst), total: money(total), review };
  };
  const heading = (key: string, label: string): Gstr3bRow => ({ rowType: 'gstr3b', key, drill: undefined, label, heading: true, taxable: undefined, cgst: undefined, sgst: undefined, igst: undefined, total: undefined, review: false });

  const rows: Gstr3bRow[] = [
    heading('h31', '3.1  Outward supplies (sales) and the tax on them'),
    row('3.1a', '(a) Taxable outward supplies (rate above 0%)', 'sales', outTaxable),
    row('3.1c', '(c) Outward supplies: nil-rated / exempt', 'sales', { taxable: nil }),
    heading('h4', '4  Input tax on purchases'),
    row('4a-eligible', 'Input tax credit — eligible (none marked)', 'purchase', { taxable: 0n, ...inEligible }),
    row('4-review', 'Input tax — TO REVIEW (eligibility unknown)', 'purchase', inToReview, true),
    row('5', 'Inward supplies: nil-rated / exempt', 'purchase', { taxable: inNil }),
    heading('hnet', 'Net GST position'),
    row('net-out', 'Output tax', undefined, { cgst: outTaxable.cgst, sgst: outTaxable.sgst, igst: outTaxable.igst }),
    row('net-in', 'Less: eligible input tax credit', undefined, inEligible),
    row('net', 'Net GST payable, claiming nothing under review', undefined, minus(outTaxable, inEligible)),
    row('net-all', 'Net GST if all input under review were eligible', undefined, minus(outTaxable, plus(inEligible, inToReview)), true),
  ];

  return {
    rows,
    sales,
    purchases,
    output,
    toReview,
    eligible,
    net,
    netIfAllEligible: netIfAll,
    reconciliation: { sales: gstReconciliation({ invoices: sales, lines: journal, masters, side: 'sales' }), purchases: gstReconciliation({ invoices: purchases, lines: journal, masters, side: 'purchase' }) },
  };
}
