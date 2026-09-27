import type { LocalDate } from '../dates';
import { inr } from '../reports/digest';
import { dayBookRows } from '../reports/books';
import { type AssistantBooks, findItems, invoices, orders, outstanding, stockOf } from './lookups';

/**
 * The floating assistant's rules and look-ups (v1: read only). The model is only the "ears": it understands the question and picks a
 * look-up; the look-ups answer from the books, and the rules below keep business answers to what the books say.
 */

/** A look-up as the model sees it (Gemini's schema subset). */
export interface AssistantTool {
  readonly name: string;
  readonly description: string;
  readonly parameters?: { readonly type: 'OBJECT'; readonly properties: Record<string, { readonly type: string; readonly description?: string; readonly enum?: readonly string[] }>; readonly required?: readonly string[] };
}

const S = (description: string) => ({ type: 'STRING', description });

export const ASSISTANT_TOOLS: readonly AssistantTool[] = [
  {
    name: 'find_items',
    description: 'Search stock items by code or name (e.g. "14188", "orifice", "MX20042"); returns code, name, type and stock in hand.',
    parameters: { type: 'OBJECT', properties: { query: S('A part code or words of the name') }, required: ['query'] },
  },
  {
    name: 'stock',
    description: "One item's stock in hand, per godown. An exact code (\"14188-1\") is that item only; a family code (\"14188\") also lists its variants (14188-1, 14188-18…).",
    parameters: { type: 'OBJECT', properties: { item: S('The item code or name') }, required: ['item'] },
  },
  {
    name: 'orders',
    description: "Order lines: customers' sales orders (side sales, default) or our purchase orders to suppliers (side purchase) — order no., customer PO, party, item, due date, ordered / delivered / pending, overdue. Only lines still pending unless include_done.",
    parameters: {
      type: 'OBJECT',
      properties: {
        party: S('Part of the customer or supplier name'),
        item: S('Item code or name'),
        side: { type: 'STRING', enum: ['sales', 'purchase'] },
        include_done: { type: 'BOOLEAN', description: 'Also lines already delivered and closed orders' },
      },
    },
  },
  {
    name: 'outstanding',
    description: 'Money outstanding: what customers owe us (receivable, default) or what we owe suppliers (payable). With a party: its open bills with due dates and days late; without: the total and each party.',
    parameters: { type: 'OBJECT', properties: { party: S('Part of the party name'), side: { type: 'STRING', enum: ['receivable', 'payable'] } } },
  },
  {
    name: 'invoices',
    description: 'Sales invoices (default) or purchase bills, newest first: number, date, party, customer PO / bill reference, amount, paid or not.',
    parameters: {
      type: 'OBJECT',
      properties: { party: S('Part of the party name'), number: S('Our invoice number, e.g. 26-27/150 or 150'), reference: S('Customer PO or supplier bill number'), side: { type: 'STRING', enum: ['sales', 'purchase'] } },
    },
  },
  {
    name: 'remember',
    description: 'Save a fact the person teaches about the business ("we keep 50 blanks of 14188"). Only when they ask to remember something.',
    parameters: { type: 'OBJECT', properties: { fact: S('The fact, in one short sentence') }, required: ['fact'] },
  },
  {
    name: 'forget',
    description: 'Remove a saved fact, by its number from the facts list.',
    parameters: { type: 'OBJECT', properties: { number: S('The fact number') }, required: ['number'] },
  },
];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** Runs a look-up the model asked for (not remember / forget: those write, and are the server's). */
export function runLookup(b: AssistantBooks, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'find_items':
      return findItems(b, str(args['query']) ?? '');
    case 'stock':
      return stockOf(b, str(args['item']) ?? '');
    case 'orders':
      return orders(b, {
        ...(str(args['party']) ? { party: str(args['party']) as string } : {}),
        ...(str(args['item']) ? { item: str(args['item']) as string } : {}),
        side: args['side'] === 'purchase' ? 'purchase' : 'sales',
        includeDone: args['include_done'] === true,
      });
    case 'outstanding':
      return outstanding(b, { ...(str(args['party']) ? { party: str(args['party']) as string } : {}), side: args['side'] === 'payable' ? 'payable' : 'receivable' });
    case 'invoices':
      return invoices(b, {
        ...(str(args['party']) ? { party: str(args['party']) as string } : {}),
        ...(str(args['number']) ? { number: str(args['number']) as string } : {}),
        ...(str(args['reference']) ? { reference: str(args['reference']) as string } : {}),
        side: args['side'] === 'purchase' ? 'purchase' : 'sales',
      });
    default:
      return { error: `There is no look-up called ${name}` };
  }
}

/** What is open on the person's screen, as the browser says it (only a type and an id: the server reads the record itself). */
export interface ScreenContext {
  readonly type: string;
  readonly id?: string | undefined;
  readonly kind?: string | undefined;
  /** The screen's own title (a report's name), shown as is. */
  readonly title?: string | undefined;
}

/** One line saying what the person is looking at, from the books — "Sales invoice 26-27/150 of 25 Sep 2026, Eclipse Combustion…". */
export function describeScreen(b: AssistantBooks, ctx: ScreenContext | undefined): string | undefined {
  if (!ctx) return undefined;
  const title = ctx.title?.slice(0, 80);
  if (ctx.type === 'voucher' && ctx.id) {
    const v = b.vouchers.find((x) => x.id === ctx.id);
    if (!v) return title;
    const row = dayBookRows({ vouchers: [v], lines: b.lines.filter((l) => l.voucherId === v.id), masters: b.masters })[0];
    const ref = (v.content as { reference?: string; billNo?: string }).reference ?? (v.content as { billNo?: string }).billNo;
    const amount = row ? (row.debit > row.credit ? row.debit : row.credit) : 0n;
    return `${row?.voucherType ?? 'Voucher'} ${v.number} dated ${v.date}${row?.particulars ? `, party ${row.particulars}` : ''}${ref ? `, reference ${ref}` : ''}${amount ? `, amount ${inr(amount)}` : ''}${v.status === 'cancelled' ? ' (cancelled)' : ''}`;
  }
  if (ctx.type === 'master' && ctx.id) {
    if (ctx.kind === 'stockItem') {
      const i = b.masters.stockItem(ctx.id as never);
      if (i) return `Stock item ${i.code ? `${i.code} — ` : ''}${i.name}`;
    }
    if (ctx.kind === 'party') {
      const p = b.masters.party(ctx.id as never);
      if (p) return `Party ${p.name}`;
    }
    const l = b.masters.ledger(ctx.id as never);
    if (l) return `Ledger ${l.name}`;
  }
  return title;
}

export interface AssistantFact {
  readonly number: number;
  readonly text: string;
}

/** The system instruction: who it works for, today, what it was taught, what is on screen, and the rules. */
export function assistantPrompt(p: { readonly company: string; readonly today: LocalDate; readonly facts: readonly AssistantFact[]; readonly screen?: string | undefined }): string {
  return [
    `You are the assistant inside MinimalERP, the accounting and inventory system of "${p.company}", an Indian manufacturing business. Today is ${p.today}.`,
    '',
    'Rules:',
    '- Anything about this business — stock, items, orders, customers\' POs, invoices, payments, money owed — you answer ONLY from the look-ups. Never guess or invent a figure, a part, an order or a date. If the look-ups do not have it, say so plainly.',
    '- Part codes are exact: 14188-1 is not 14188-18. If a look-up says several items match, ask which one.',
    '- Other questions (general knowledge, calculations, drafting a message, translation) you answer normally.',
    '- Reply in the language the person used (English, Hindi or Marathi, or their mix). Keep answers short and practical: a few lines, lists for several items.',
    '- Write amounts in Indian style (₹ 1,23,456.00) and dates like 30 Sep 2026. Mention order and invoice numbers and customer PO numbers when they matter.',
    '- You can only read the books. If asked to create or change something (an invoice, an order), say that is not possible yet and how to do it in the ERP.',
    '- Use "remember" only when the person asks you to remember something, and "forget" when they ask to forget a saved fact.',
    '',
    p.facts.length > 0 ? `What you have been taught (numbered):\n${p.facts.map((f) => `${f.number}. ${f.text}`).join('\n')}` : 'You have not been taught anything yet.',
    ...(p.screen ? ['', `On the person's screen now: ${p.screen}. "This", "this invoice", "this item" mean it.`] : []),
  ].join('\n');
}
