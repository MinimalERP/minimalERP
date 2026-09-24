import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import { type GstBreakdown, canonicalPercent, computeGst, isIntraState, isPercentText } from '../../gst/tax';
import type { Masters } from '../../masters/masters';
import { GST_STATE_CODES, stateOfGstin, gstinProblem } from '../../masters/rules';
import type { SystemLedgerKey } from '../../masters/systemLedgers';
import { absMoney, formatMoney, money, parseMoney, type Money } from '../../money';
import type { PlannedLine } from '../../posting/plan';
import type { LedgerId } from '../../ids';
import { type PartyDetails, moneySchema } from '../drafts';
import { lineValue } from './documents';

/**
 * The GST of a Sales or Purchase Invoice (ADR-0019). An invoice's lines carry a rate and its header carries the two states that decide the tax
 * (`supplyState`: where the supply is made from; `placeOfSupply`: where it is made to) and the CGST / SGST / IGST the lines come to. The header
 * amounts are DERIVED — the browser fills them with the same `computeGst` the engine then re-checks — so a stored invoice can always be added up
 * from its own lines, and the SQL bill mirror can add them without repeating any tax arithmetic.
 */

const stateSchema = z.string().trim().length(2);

export const gstHeaderSchema = z.object({
  /** The state the supply is made from: the company's (sales) or the supplier's (purchase). */
  supplyState: stateSchema,
  /** The state it is made to: the customer's (sales) or the company's (purchase). */
  placeOfSupply: stateSchema,
  cgst: moneySchema,
  sgst: moneySchema,
  igst: moneySchema,
});
export type GstHeader = z.output<typeof gstHeaderSchema>;

export type InvoiceSide = 'sales' | 'purchase';

interface GstInputLine {
  readonly qty: string;
  readonly rate: string;
  readonly gstRate?: string | undefined;
}

/** A line's rate, when it names one (an empty rate is an untaxed line). */
export const lineGstRate = (l: Pick<GstInputLine, 'gstRate'>): string | undefined => (l.gstRate === undefined || l.gstRate === '' ? undefined : canonicalPercent(l.gstRate));

export const isRated = (lines: readonly GstInputLine[]): boolean => lines.some((l) => lineGstRate(l) !== undefined && lineGstRate(l) !== '0');

/** The breakdown of an invoice's lines for a header (or the zero breakdown when there is none). */
export function breakdownOf(lines: readonly GstInputLine[], header: Pick<GstHeader, 'supplyState' | 'placeOfSupply'> | undefined): GstBreakdown {
  return computeGst(
    lines.map((l) => ({ taxable: lineValue(l), rate: l.gstRate })),
    header === undefined ? true : isIntraState(header.supplyState, header.placeOfSupply),
  );
}

/**
 * Signed adjustment that rounds `total` to the nearest rupee, half up (Round Off, ADR-0025): +0.37 when
 * rounded up (₹2549.63), -0.37 when rounded down (₹2549.37), 0 when already whole. The SQL mirror of this
 * lives in `sync_bill_allocations()` (supabase/migrations/20261005000100_round_off.sql) — keep the two in sync.
 */
export function roundOffAmount(total: Money): Money {
  const cents = ((total % 100n) + 100n) % 100n;
  if (cents === 0n) return money(0n);
  return money(cents >= 50n ? 100n - cents : -cents);
}

export interface GrandTotalParts {
  /** Items + tax, to the paisa — unrounded. */
  readonly raw: Money;
  /** The Round Off ledger's adjustment: raw + roundOff = rounded. */
  readonly roundOff: Money;
  /** What the customer/vendor actually owes: raw rounded to the nearest rupee. */
  readonly rounded: Money;
}

/** `grandTotal`, split into its unrounded and rounded parts, and the Round Off adjustment between them. */
export function grandTotalParts(lines: readonly GstInputLine[], header: Pick<GstHeader, 'cgst' | 'sgst' | 'igst'> | undefined): GrandTotalParts {
  const raw = money(lines.reduce((t, l) => t + lineValue(l), 0n) + (header ? header.cgst + header.sgst + header.igst : 0n));
  const roundOff = roundOffAmount(raw);
  return { raw, roundOff, rounded: money(raw + roundOff) };
}

/** What an invoice comes to with its GST, rounded to the nearest rupee (Round Off): what the customer/vendor is actually debited/credited. */
export const grandTotal = (lines: readonly GstInputLine[], header: Pick<GstHeader, 'cgst' | 'sgst' | 'igst'> | undefined): Money => grandTotalParts(lines, header).rounded;

/** The GST header of a stored voucher's content (money as a number or as decimal text, whichever the store keeps), or undefined. */
export function gstOfContent(content: unknown): GstHeader | undefined {
  const g = (content as { gst?: Record<string, unknown> } | undefined)?.gst;
  if (g === undefined || g === null || typeof g !== 'object') return undefined;
  const amount = (v: unknown): Money => (typeof v === 'bigint' ? money(v) : (parseMoney(String(v ?? '0')) ?? money(0n)));
  return {
    supplyState: String(g['supplyState'] ?? ''),
    placeOfSupply: String(g['placeOfSupply'] ?? ''),
    cgst: amount(g['cgst']),
    sgst: amount(g['sgst']),
    igst: amount(g['igst']),
  };
}

// ---- deriving the header the way the engine will check it --------------------------------------------------------------

interface HeaderInput {
  readonly partyId: string;
  readonly partyDetails?: PartyDetails | undefined;
  readonly lines: readonly GstInputLine[];
}

/** The state a party is in, as the voucher's snapshot says it: the place of supply, the billing state, or the GSTIN's. */
function stateOfParty(masters: Masters, input: HeaderInput, side: InvoiceSide): string | undefined {
  const d = input.partyDetails;
  const gstin = d?.gstin && !gstinProblem(d.gstin) ? stateOfGstin(d.gstin) : undefined;
  const party = masters.party(input.partyId as never);
  const fromParty = party?.stateCode ?? (party?.gstin && !gstinProblem(party.gstin) ? stateOfGstin(party.gstin) : undefined);
  // on a sale the customer's place of supply wins; on a purchase the supplier's state is where the supply is made from
  const first = side === 'sales' ? [d?.placeOfSupply, d?.billTo?.stateCode, gstin, fromParty] : [d?.billTo?.stateCode, gstin, d?.placeOfSupply, fromParty];
  return first.find((s) => s !== undefined && s !== '');
}

/**
 * The GST header for an invoice, or undefined when there is nothing to state (GST is off for the company, or no line has a rate). A party whose
 * state is not known at all is taken to be in the company's state — the over-the-counter case; the GST reports still flag it.
 */
export function deriveGstHeader(masters: Masters, side: InvoiceSide, input: HeaderInput): GstHeader | undefined {
  if (masters.company.chargeGst !== true || !isRated(input.lines)) return undefined;
  const own = masters.company.stateCode ?? '';
  const theirs = stateOfParty(masters, input, side) ?? own;
  const supplyState = side === 'sales' ? own : theirs;
  const placeOfSupply = side === 'sales' ? theirs : own;
  const b = breakdownOf(input.lines, { supplyState, placeOfSupply });
  return { supplyState, placeOfSupply, cgst: b.cgst, sgst: b.sgst, igst: b.igst };
}

// ---- the rules -----------------------------------------------------------------------------------------------------------

export interface InvoiceGst {
  readonly problems: Issue[];
  readonly breakdown: GstBreakdown;
  readonly header: GstHeader | undefined;
}

const HEADS: readonly { readonly pick: 'cgst' | 'sgst' | 'igst'; readonly label: string }[] = [
  { pick: 'cgst', label: 'CGST' },
  { pick: 'sgst', label: 'SGST' },
  { pick: 'igst', label: 'IGST' },
];

/** Whether the GST an invoice states is what its lines come to, and whether the company may state it at all. */
export function invoiceGst(draft: { lines: readonly GstInputLine[]; gst?: GstHeader | undefined }, masters: Masters, side: InvoiceSide): InvoiceGst {
  const problems: Issue[] = [];
  const header = draft.gst;
  const charge = masters.company.chargeGst === true;
  const rated = isRated(draft.lines);
  const stated = header !== undefined && header.cgst + header.sgst + header.igst > 0n;

  draft.lines.forEach((l, i) => {
    if (l.gstRate !== undefined && l.gstRate !== '' && !isPercentText(l.gstRate.trim())) {
      problems.push(issue(IssueCode.GstInvalid, 'A GST rate is a percentage like 5, 18 or 2.5', `lines.${i}.gstRate`));
    }
  });

  if (!charge) {
    if (rated || stated) problems.push(issue(IssueCode.GstInvalid, 'GST is not switched on for this company: turn on “Charge GST” in Company settings first', 'gst'));
    return { problems, breakdown: breakdownOf(draft.lines, undefined), header: undefined };
  }
  if (!masters.company.stateCode) {
    problems.push(issue(IssueCode.GstInvalid, 'GST needs the company’s state: set the GSTIN in Company settings', 'gst'));
    return { problems, breakdown: breakdownOf(draft.lines, undefined), header: undefined };
  }
  if (header === undefined) {
    if (rated) problems.push(issue(IssueCode.GstInvalid, 'These lines carry GST, but the invoice does not say where the supply is made from and to', 'gst'));
    return { problems, breakdown: breakdownOf(draft.lines, undefined), header: undefined };
  }

  if (!GST_STATE_CODES.has(header.supplyState)) problems.push(issue(IssueCode.GstInvalid, `${header.supplyState} is not a GST state code`, 'gst.supplyState'));
  if (!GST_STATE_CODES.has(header.placeOfSupply)) problems.push(issue(IssueCode.GstInvalid, `${header.placeOfSupply} is not a GST state code`, 'gst.placeOfSupply'));
  const own = masters.company.stateCode;
  if (side === 'sales' && header.supplyState !== own) problems.push(issue(IssueCode.GstInvalid, `A sale is made from the company’s state (${own})`, 'gst.supplyState'));
  if (side === 'purchase' && header.placeOfSupply !== own) problems.push(issue(IssueCode.GstInvalid, `A purchase is received in the company’s state (${own})`, 'gst.placeOfSupply'));

  const breakdown = breakdownOf(draft.lines, header);
  for (const { pick, label } of HEADS) {
    if (header[pick] !== breakdown[pick]) {
      problems.push(issue(IssueCode.GstInvalid, `The ${label} is ${formatMoney(header[pick])} but the lines come to ${formatMoney(breakdown[pick])}`, `gst.${pick}`));
    }
  }
  // the ledgers the tax is posted to must exist (an old company gets them when it is opened)
  if (problems.length === 0) {
    for (const key of ledgerKeys(side, breakdown)) {
      if (!masters.systemLedger(key)) problems.push(issue(IssueCode.GstInvalid, 'The GST ledgers are missing from this company: reopen the company to add them', 'gst'));
    }
  }
  return { problems, breakdown, header };
}

const ledgerKeys = (side: InvoiceSide, b: Pick<GstBreakdown, 'cgst' | 'sgst' | 'igst'>): SystemLedgerKey[] => {
  const kind = side === 'sales' ? 'output' : 'input';
  const out: SystemLedgerKey[] = [];
  if (b.cgst > 0n) out.push(`gst-${kind}-cgst` as SystemLedgerKey);
  if (b.sgst > 0n) out.push(`gst-${kind}-sgst` as SystemLedgerKey);
  if (b.igst > 0n) out.push(`gst-${kind}-igst` as SystemLedgerKey);
  return out;
};

/** The tax lines an invoice posts: credits to the Output ledgers on a sale, debits to the Input ledgers on a purchase. Nothing when there is no tax. */
export function taxPostings(masters: Masters, side: InvoiceSide, header: GstHeader | undefined): PlannedLine[] {
  if (header === undefined) return [];
  const out: PlannedLine[] = [];
  const kind = side === 'sales' ? 'output' : 'input';
  for (const { pick } of HEADS) {
    const amount = header[pick];
    if (amount <= 0n) continue;
    const ledger = masters.systemLedger(`gst-${kind}-${pick}` as SystemLedgerKey);
    if (ledger) out.push({ ledgerId: ledger.id as LedgerId, side: side === 'sales' ? 'credit' : 'debit', amount });
  }
  return out;
}

/**
 * The Round Off ledger's line, or none when the total is already a whole rupee. Balances the rounded grand
 * total against the unrounded lines + tax: on a SALE a rounded-UP total needs an extra CREDIT (the customer's
 * debit grew); on a PURCHASE the same rounded-UP total needs an extra DEBIT (the vendor's credit grew) —
 * purchase is the mirror image.
 */
export function roundOffPosting(masters: Masters, side: InvoiceSide, roundOff: Money): PlannedLine[] {
  if (roundOff === 0n) return [];
  const ledger = masters.systemLedger('round-off');
  if (!ledger) return [];
  const up = roundOff > 0n;
  const postSide = side === 'sales' ? (up ? 'credit' : 'debit') : up ? 'debit' : 'credit';
  return [{ ledgerId: ledger.id as LedgerId, side: postSide, amount: absMoney(roundOff) }];
}

/** Whether the Round Off ledger an invoice needs (because its total isn't a whole rupee) actually exists. */
export function roundOffProblems(masters: Masters, roundOff: Money): Issue[] {
  if (roundOff === 0n) return [];
  if (masters.systemLedger('round-off')) return [];
  return [issue(IssueCode.RoundOffInvalid, 'The Round Off ledger is missing from this company: reopen the company to add it', 'gst')];
}

