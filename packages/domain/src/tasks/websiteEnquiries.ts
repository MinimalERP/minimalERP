import { z } from 'zod';

/**
 * WEBSITE ENQUIRIES — what customers send from the quote form on the company's website (micro-components.com), written straight into the
 * ERP's database. The ERP follows each one new → contacted → quoted → won / lost, calls or writes to the customer, downloads their drawing,
 * and may turn one into a Gateway enquiry (a task of kind 'enquiry', source 'website') to keep dated notes on it.
 */

export const WEBSITE_ENQUIRY_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'] as const;
export type WebsiteEnquiryStatus = (typeof WEBSITE_ENQUIRY_STATUSES)[number];

export interface WebsiteEnquiry {
  readonly id: string;
  /** When it was sent (ISO timestamp). */
  readonly createdAt: string;
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  /** What they want, in their words: part, material, size, quantity. */
  readonly requirement: string;
  /** Older forms only. */
  readonly company?: string | undefined;
  readonly quantity?: string | undefined;
  readonly material?: string | undefined;
  readonly message?: string | undefined;
  /** The drawing's name in the bucket, when they attached one. */
  readonly drawing?: string | undefined;
  /** The page it came from: `home`, `capability:<category>/<item>`, `thread:<slug>`, `tool:<name>`, `chart:<slug>`. */
  readonly source?: string | undefined;
  /** The item that page filled in, e.g. "CNC Turning". */
  readonly context?: string | undefined;
  readonly status: WebsiteEnquiryStatus;
  /** The Gateway enquiry it became, while that exists. */
  readonly taskId?: string | undefined;
}

export interface WebsiteEnquiryList {
  /** False for a company the website does not belong to: it has no website enquiries. */
  readonly site: boolean;
  readonly enquiries: readonly WebsiteEnquiry[];
}

export const websiteEnquiryCommandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status'), id: z.string().uuid(), status: z.enum(WEBSITE_ENQUIRY_STATUSES) }),
  z.object({ op: z.literal('convert'), id: z.string().uuid() }),
  /** Erased from the database for good, with its drawing. */
  z.object({ op: z.literal('delete'), id: z.string().uuid() }),
]);
export type WebsiteEnquiryCommand = z.output<typeof websiteEnquiryCommandSchema>;

/** The phone as India dials it from anywhere: +91 and ten digits (a leading 0 or 91 dropped). Undefined when it is not ten digits. */
function indianNumber(phone: string): string | undefined {
  const digits = phone.replace(/\D/g, '').replace(/^0+/, '');
  const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^\d{10}$/.test(ten) ? `91${ten}` : undefined;
}

/** WhatsApp chat with the customer, or undefined when the number is not one WhatsApp can be given. */
export function whatsappUrl(phone: string): string | undefined {
  const n = indianNumber(phone);
  return n ? `https://wa.me/${n}` : undefined;
}

/** A call: the Indian number as +91…, anything else as written (digits and a leading +). */
export function telUrl(phone: string): string | undefined {
  const n = indianNumber(phone);
  if (n) return `tel:+${n}`;
  const as = phone.trim().replace(/[^\d+]/g, '');
  return as.replace(/\D/g, '').length >= 6 ? `tel:${as}` : undefined;
}

/** Where on the website it was sent from, in words: "Capability: machining / cnc-turning", "Tool: pipe-chart", "Home page". */
export function sourceWords(source: string | undefined): string {
  if (!source) return '';
  if (source === 'home') return 'Home page';
  const at = source.indexOf(':');
  if (at < 0) return source;
  const kind = source.slice(0, at);
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}: ${source.slice(at + 1).split('/').join(' / ')}`;
}
