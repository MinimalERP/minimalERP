import {
  type CompanyId,
  type Extraction,
  type Masters,
  type OrderBook,
  type Result,
  type Voucher,
  canonicalPercent,
  deterministicUuid,
  proposeFromExtraction,
} from '@minimalerp/domain';
import type { PostgresBackend } from '@minimalerp/adapter-postgres';
import type { ZohoInvoice, ZohoLine } from './csv';

const num = (s: string): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

/** One line's GST rate as a single percentage (Zoho splits it into CGST+SGST or IGST) — "" (untaxed) when all three are 0. */
function lineGstRateOf(l: ZohoLine): string | undefined {
  const rate = num(l.cgstRate) + num(l.sgstRate) || num(l.igstRate);
  return rate > 0 ? canonicalPercent(String(rate)) : undefined;
}

/** Zoho's "Item Name" already follows this company's own "<code> - <description>" convention for most lines
 *  (the same one `matchItem`'s AI Inbox matcher is tuned for) — split it so `code` carries just the part
 *  number and `description` the readable text, instead of handing the whole string to both. */
function splitItemName(name: string): { code: string | undefined; description: string | undefined } {
  const m = /^([^\s-]+)\s*-\s*(.+)$/.exec(name);
  return m ? { code: m[1], description: m[2] } : { code: undefined, description: name || undefined };
}

/** Turns one grouped Zoho invoice into the same `Extraction` shape a document reader would have produced —
 *  mechanical, since the CSV is already structured data, not something to read with an AI. */
export function buildExtraction(invoice: ZohoInvoice): Extraction {
  const first = invoice.rows[0] as ZohoLine;
  return {
    partyName: first.customerName || undefined,
    partyGstin: first.gstin || undefined,
    partyAddress: [first.billingAddress, first.billingCity, first.billingState, first.billingCode].filter((s) => s !== '').join(', ') || undefined,
    date: first.invoiceDate || undefined,
    poNumber: first.purchaseOrder || undefined,
    dueDate: first.dueDate || undefined,
    lines: invoice.rows.map((l) => {
      const split = splitItemName(l.itemName);
      return {
        description: l.itemDesc || split.description,
        code: split.code,
        hsn: l.hsn || undefined,
        qty: l.quantity || undefined,
        unit: l.usageUnit || undefined,
        rate: l.itemPrice || undefined,
        gstRate: lineGstRateOf(l),
      };
    }),
    subtotal: first.subtotal || undefined,
    grandTotal: first.total || undefined,
    bills: [],
  };
}

export interface StageContext {
  readonly masters: Masters;
  readonly vouchers: readonly Voucher[];
  readonly orders: OrderBook;
  readonly today: string;
}

export interface StageResult {
  readonly zohoNumber: string;
  readonly inboxId?: string | undefined;
  readonly party?: string | undefined;
  readonly notes: string[];
  readonly error?: string | undefined;
}

/** Builds the Extraction, proposes it against the company's masters, and queues it in the AI Inbox — the
 *  same three steps a real document goes through, minus the reading. Never posts anything. */
export async function stageInvoice(backend: Pick<PostgresBackend, 'submitInbox'>, companyId: CompanyId, ctx: StageContext, invoice: ZohoInvoice): Promise<StageResult> {
  const extraction = buildExtraction(invoice);
  const proposal = proposeFromExtraction('sales', extraction, { masters: ctx.masters, vouchers: ctx.vouchers, orders: ctx.orders, today: ctx.today as never });
  const id = deterministicUuid(`zoho-invoice|${companyId}|${invoice.rows[0]?.invoiceId || invoice.invoiceNumber}`);
  const submitted: Result<{ readonly id: string }> = await backend.submitInbox({
    companyId,
    id,
    proposal,
    mailSubject: `Zoho ${invoice.invoiceNumber}`.slice(0, 200),
    mailFrom: 'Zoho Books CSV import',
  });
  const party = proposal.party.partyId ? ctx.masters.party(proposal.party.partyId as never)?.name : proposal.party.name;
  if (!submitted.ok) {
    return { zohoNumber: invoice.invoiceNumber, party, notes: proposal.notes.map((n) => n.message), error: submitted.issues.map((i) => i.message).join('; ') };
  }
  return { zohoNumber: invoice.invoiceNumber, inboxId: submitted.value.id, party, notes: proposal.notes.map((n) => n.message) };
}
