/**
 * The email a voucher is sent with: which kinds are mailed, and the subject/body templates a company keeps (on its master record) — plain
 * data and text, depending on nothing else, so the masters can hold them. Filling one from a voucher is in mail/voucherMail.ts.
 */

/** The vouchers that are sent to their party by email: the item documents, each naming its customer or supplier. */
export const MAIL_KINDS = ['sales', 'salesOrder', 'quotation', 'purchase', 'purchaseOrder'] as const;
export type MailKind = (typeof MAIL_KINDS)[number];
export const isMailKind = (s: string | undefined): s is MailKind => (MAIL_KINDS as readonly string[]).includes(s ?? '');

export interface MailTemplate {
  readonly subject: string;
  readonly body: string;
}
/** A company's own templates, by voucher kind; a kind without one uses the default. */
export type MailTemplates = Readonly<Partial<Record<MailKind, MailTemplate>>>;

/** What a template may say: each `{name}` is filled from the voucher. */
export const MAIL_PLACEHOLDERS = ['number', 'date', 'party', 'amount', 'due', 'reference', 'company'] as const;

export const MAIL_DOC_NAMES: Readonly<Record<MailKind, string>> = {
  sales: 'Invoice',
  salesOrder: 'Order confirmation',
  quotation: 'Quotation',
  purchase: 'Purchase invoice',
  purchaseOrder: 'Purchase order',
};

export const DEFAULT_MAIL_TEMPLATES: Readonly<Record<MailKind, MailTemplate>> = {
  sales: {
    subject: 'Invoice {number} from {company}',
    body: 'Dear {party},\n\nPlease find attached our invoice {number} dated {date} for ₹{amount}, due on {due}.\nYour PO: {reference}\n\nThank you,\n{company}',
  },
  salesOrder: {
    subject: 'Order confirmation {number} from {company}',
    body: 'Dear {party},\n\nThank you for your order. Please find attached our order confirmation {number} dated {date}.\nYour PO: {reference}\n\nRegards,\n{company}',
  },
  quotation: {
    subject: 'Quotation {number} from {company}',
    body: 'Dear {party},\n\nPlease find attached our quotation {number} dated {date}. We look forward to your order.\n\nRegards,\n{company}',
  },
  purchase: {
    subject: 'Purchase invoice {number} — {company}',
    body: 'Dear {party},\n\nPlease find attached the purchase invoice {number} dated {date} for ₹{amount}.\n\nRegards,\n{company}',
  },
  purchaseOrder: {
    subject: 'Purchase order {number} from {company}',
    body: 'Dear {party},\n\nPlease find attached our purchase order {number} dated {date}. Kindly confirm and supply as per the order.\n\nRegards,\n{company}',
  },
};

/** The template a kind uses: the company's own (each part that is set), else the default. */
export function templateFor(templates: MailTemplates | undefined, kind: MailKind): MailTemplate {
  const own = templates?.[kind];
  const d = DEFAULT_MAIL_TEMPLATES[kind];
  return { subject: own?.subject?.trim() ? own.subject : d.subject, body: own?.body?.trim() ? own.body : d.body };
}

/** `{name}` → its value; a name that is not a placeholder is left as it was typed. */
export function fillTemplate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? (values[name] as string) : whole));
}

/**
 * A message filled in: a line that names a placeholder with nothing to say (no PO on this invoice: "Your PO: {reference}") is left out
 * whole, rather than sent with a blank.
 */
export function fillMessage(text: string, values: Readonly<Record<string, string>>): string {
  return text
    .split('\n')
    .filter((line) => ![...line.matchAll(/\{(\w+)\}/g)].some((m) => (m[1] as string) in values && values[m[1] as string] === ''))
    .map((line) => fillTemplate(line, values))
    .join('\n');
}

