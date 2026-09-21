import { z } from 'zod';
import { parseLocalDate, type LocalDate } from '../dates';
import type { LedgerId, VoucherId, VoucherTypeId } from '../ids';
import { type Money, ZERO, isMoneyText, money, parseMoney } from '../money';

/**
 * Draft schemas. A draft is the *intent* a user (or API caller) submits: it has no number,
 * no company (that comes from the Masters snapshot) and no derived amounts.
 * Parsing is lenient about representation (money may be a bigint or a decimal string, so the same
 * schema serves the in-memory UI store and JSON on the wire) and strict about shape.
 * Business rules (positive amounts, cash/bank restrictions…) live in the VoucherKinds, not here.
 */

const brandedString = <T extends string>() =>
  z
    .string()
    .min(1)
    .max(128)
    .transform((s) => s as unknown as T);

export const voucherIdSchema = brandedString<VoucherId>();
export const voucherTypeIdSchema = brandedString<VoucherTypeId>();
export const ledgerIdSchema = brandedString<LedgerId>();

export const localDateSchema = z
  .string()
  .refine((s) => parseLocalDate(s) !== undefined, 'Must be a valid calendar date (YYYY-MM-DD)')
  .transform((s) => s as LocalDate);

export const moneySchema = z
  .union([z.bigint(), z.string().refine(isMoneyText, 'Must be a decimal amount like 1234.56')])
  .transform((v): Money => (typeof v === 'bigint' ? money(v) : (parseMoney(v) ?? ZERO)));

export const sideSchema = z.enum(['debit', 'credit']);

export const narrationSchema = z.string().max(500).optional();

/**
 * Bill-wise details of one party line: how its amount splits between a NEW bill (a reference and a due date), payment
 * AGAINST an existing bill, an ADVANCE, or ON ACCOUNT. The parts must add up to the line (see vouchers/allocations.ts).
 */
export const billAllocationSchema = z.object({
  kind: z.enum(['new', 'against', 'advance', 'onAccount']),
  ref: z.string().trim().max(60).optional(),
  dueDate: localDateSchema.optional(),
  amount: moneySchema,
  /**
   * TDS the customer deducted from THIS bill before paying (a Receipt only, ADR-0019). `amount` is still the whole bill settled; the bank receives
   * `amount − tds` and the tax deducted goes to TDS Receivable.
   */
  tds: moneySchema.optional(),
});
export type BillAllocation = z.output<typeof billAllocationSchema>;
export const allocationsSchema = z.array(billAllocationSchema).optional();

export const GST_REGISTRATIONS = ['regular', 'composition', 'unregistered', 'sez', 'overseas'] as const;
export type GstRegistration = (typeof GST_REGISTRATIONS)[number];

/** One address as printed on a document. `stateCode` is the two-digit GST state code. */
export const addressSchema = z.object({
  name: z.string().trim().max(120).optional(),
  lines: z.string().trim().max(400).optional(),
  stateCode: z.string().trim().max(2).optional(),
  country: z.string().trim().max(60).optional(),
  pincode: z.string().trim().max(10).optional(),
});
export type Address = z.output<typeof addressSchema>;

/**
 * The party details of ONE voucher: who it is billed to and shipped to, and the GST facts that decide the tax. It is a
 * SNAPSHOT copied from the party master when entered, so editing the master later never rewrites a posted voucher.
 * `shipTo` absent means "same as billing".
 */
export const partyDetailsSchema = z.object({
  partyId: z.string().max(128).optional(),
  mailingName: z.string().trim().max(120).optional(),
  billTo: addressSchema.optional(),
  shipTo: addressSchema.optional(),
  gstRegistration: z.enum(GST_REGISTRATIONS).optional(),
  gstin: z.string().trim().max(15).optional(),
  placeOfSupply: z.string().trim().max(2).optional(),
});
export type PartyDetails = z.output<typeof partyDetailsSchema>;

/** Fields every voucher draft has, whatever its kind. */
export const draftBaseShape = {
  id: voucherIdSchema,
  voucherTypeId: voucherTypeIdSchema,
  date: localDateSchema,
  narration: narrationSchema,
  partyDetails: partyDetailsSchema.optional(),
};

export const draftBaseSchema = z.object(draftBaseShape);
export type DraftBase = z.output<typeof draftBaseSchema>;

/** Journal: free-form debit and credit entries that must balance. */
export const journalDraftSchema = z.object({
  ...draftBaseShape,
  entries: z.array(
    z.object({
      ledgerId: ledgerIdSchema,
      side: sideSchema,
      amount: moneySchema,
      narration: narrationSchema,
      allocations: allocationsSchema,
    }),
  ),
});
export type JournalDraft = z.output<typeof journalDraftSchema>;

/**
 * Contra / Payment / Receipt ("single-entry" mode): one account ledger (cash or bank) plus any
 * number of particulars. The account's amount is DERIVED as the sum of the particulars, so these
 * vouchers cannot be unbalanced by construction.
 */
export const singleEntryDraftSchema = z.object({
  ...draftBaseShape,
  accountLedgerId: ledgerIdSchema,
  lines: z.array(
    z.object({
      ledgerId: ledgerIdSchema,
      amount: moneySchema,
      narration: narrationSchema,
      allocations: allocationsSchema,
    }),
  ),
});
export type SingleEntryDraft = z.output<typeof singleEntryDraftSchema>;
