import type { InboxItem } from '@minimalerp/ports';
import type { Books } from '../books/books';

/**
 * Scan: a document photographed, chosen or shared on the phone is sent to be read, and what was read waits to be checked and saved. The
 * reading, matching and the waiting list are the AI Inbox's own (`books.sendDocument`, `books.inbox`, `books.rejectInbox`, ADR-0023): this
 * is only what the phone asks and how it says what came back.
 */

/** What a document can be, in the words a person on a phone would use. */
export const SCAN_KINDS: readonly { readonly kind: InboxItem['kind']; readonly label: string; readonly hint: string }[] = [
  { kind: 'purchase', label: 'Purchase bill', hint: "A supplier's invoice" },
  { kind: 'salesOrder', label: 'Customer PO', hint: 'An order from a customer' },
  { kind: 'sales', label: 'Sales invoice', hint: 'Goods to bill to a customer' },
  { kind: 'receipt', label: 'Receipt', hint: "A customer's payment advice" },
  { kind: 'payment', label: 'Payment', hint: 'A payment we made to a supplier' },
];

export const scanLabel = (kind: InboxItem['kind']): string => SCAN_KINDS.find((k) => k.kind === kind)?.label ?? kind;

/** What can be read, and how big (the reader's own limits, as the desktop inbox checks them before sending anything). */
export const MAX_SCAN_BYTES = 10 * 1024 * 1024;
const READABLE = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif))$/;

/** Why this file cannot be sent — or nothing when it can. */
export function scanProblem(file: { readonly name: string; readonly type: string; readonly size: number }): string | undefined {
  if (!READABLE.test(file.type)) return `${file.name || 'That file'} is not a PDF or a picture. Share or choose a PDF, JPG or PNG.`;
  if (file.size > MAX_SCAN_BYTES) return `${file.name || 'That file'} is larger than 10 MB. Take the photo again at a lower size, or send a smaller PDF.`;
  return undefined;
}

/** A file's content as base64 (without the `data:` prefix). */
export const base64Of = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('The file could not be opened'));
    r.readAsDataURL(file);
  });

/** A document the reader could not read at all (it was busy): there is nothing to open, only "send it again". */
export const unread = (item: InboxItem): boolean => item.proposal.notes.some((n) => n.code === 'READ_FAILED');

/** A waiting document in two lines: whose it is and which, then what it holds. */
export function scanSummary(item: InboxItem): { readonly title: string; readonly sub: string; readonly value: string | undefined; readonly attention: boolean } {
  const p = item.proposal;
  const number = p.billNo ?? p.reference;
  const holds = unread(item)
    ? undefined
    : p.kind === 'receipt' || p.kind === 'payment'
      ? p.amount
        ? `₹ ${p.amount}`
        : undefined
      : p.lines.length > 0
        ? `${p.lines.length} line${p.lines.length === 1 ? '' : 's'}`
        : undefined;
  return {
    title: unread(item) ? 'Could not be read' : (p.party.name ?? 'Party not read'),
    sub: [scanLabel(item.kind), number, p.date].filter(Boolean).join(' · '),
    value: holds,
    // something the reader could not settle: the row says so, and the page it opens on lists it
    attention: p.notes.length > 0,
  };
}

/**
 * How many documents wait, for the Gateway's row — asked of the server at most once a minute and never while the Gateway is being drawn
 * (going back to the Gateway must not wait on the network). Undefined until it has been asked once.
 */
const waiting = new WeakMap<Books, { count: number; at: number }>();
export const scanWaiting = (books: Books): number | undefined => waiting.get(books)?.count;
export const noteWaiting = (books: Books, count: number, at = Date.now()): void => void waiting.set(books, { count, at });
export async function refreshWaiting(books: Books, now = Date.now()): Promise<number | undefined> {
  const known = waiting.get(books);
  if (known && now - known.at < 60_000) return known.count;
  const r = await books.inbox().catch(() => undefined);
  if (!r?.ok) return known?.count;
  noteWaiting(books, r.value.length, now);
  return r.value.length;
}
