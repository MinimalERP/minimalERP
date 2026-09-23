import { z } from 'zod';
import { INTAKE_KINDS } from './extraction';

/**
 * A PROPOSAL: what the ERP makes of one document a person sent it, waiting in the AI Inbox until a person opens it, completes it and
 * accepts it (Ctrl+A) — or rejects it. It is deliberately NOT a voucher draft: a line may still be only the document's own text (no item
 * chosen yet), the party may be only a name. The voucher window turns it into its form; the engine sees only what a person accepted.
 *
 * Only this is stored (and only until it is decided): never the document itself, never the raw reading.
 */

const str = (max: number) => z.string().trim().max(max);
const opt = (max: number) => str(max).optional();

export const PROPOSAL_NOTE_CODES = [
  'PARTY_UNMATCHED',
  'PARTY_ROLE_MISSING',
  'ITEM_UNMATCHED',
  'QTY_MISSING',
  'RATE_MISSING',
  'DATE_MISSING',
  'BILL_NO_MISSING',
  'DUPLICATE_PO',
  'DUPLICATE_BILL',
  'DUPLICATE_UTR',
  'TOTAL_MISMATCH',
  'BILL_NOT_OPEN',
  'UNALLOCATED',
  'AMOUNT_MISSING',
  'BANK_UNMATCHED',
  'NO_LINES',
  /** The document could not be read at all (the reader was busy): the item only says so — send the mail again. */
  'READ_FAILED',
] as const;
export type ProposalNoteCode = (typeof PROPOSAL_NOTE_CODES)[number];

export const proposalNoteSchema = z.object({
  code: z.enum(PROPOSAL_NOTE_CODES),
  message: str(300),
  /** The field it is about, in the form's terms: "party", "lines.2.item", "billNo"… */
  path: opt(60),
});
export type ProposalNote = z.output<typeof proposalNoteSchema>;

export const proposalLineSchema = z.object({
  /** The item, when it was matched with certainty; absent = the person picks it (or creates it) from `text`. */
  itemId: opt(128),
  /** The line as the document prints it, kept short: what the item cell shows until an item is chosen. */
  text: str(80),
  qty: str(30),
  rate: str(30),
  unit: opt(20),
  hsn: opt(10),
  gstRate: opt(8),
  /** Orders: when the line is wanted. */
  dueDate: opt(10),
});
export type ProposalLine = z.output<typeof proposalLineSchema>;

export const proposalBillSchema = z.object({
  ref: str(60),
  amount: str(30),
  tds: opt(30),
  /** True when the ref is one of the party's open bills. */
  open: z.boolean(),
});
export type ProposalBill = z.output<typeof proposalBillSchema>;

export const proposalSchema = z.object({
  kind: z.enum(INTAKE_KINDS),
  date: str(10),
  party: z.object({
    /** The party, when it was matched with certainty (and has the role the document needs). */
    partyId: opt(128),
    /** What the document calls it: the picker's search text, and a new party's name. */
    name: opt(120),
    gstin: opt(15),
    address: opt(400),
  }),
  /** The customer's PO number. */
  reference: opt(60),
  /** Purchase: the supplier's invoice number. */
  billNo: opt(60),
  dueDate: opt(10),
  /** Sales invoice: the customer's open order this delivers against — the window fills the pending lines from it (as Alt+I does). */
  fromOrderId: opt(128),
  lines: z.array(proposalLineSchema).max(200),
  // ---- receipt / payment ----
  amount: opt(30),
  /** The bank (or cash) ledger, when the advice named one we could find. */
  accountLedgerId: opt(128),
  /** UTR / UPI ref / cheque number: goes into the narration. */
  instrument: opt(40),
  bills: z.array(proposalBillSchema).max(100),
  notes: z.array(proposalNoteSchema).max(300),
});
export type Proposal = z.output<typeof proposalSchema>;
