import type { LocalDate } from '../dates';
import type { StockItemId } from '../ids';
import type { Masters } from '../masters/masters';
import type { StockItem } from '../masters/records';
import { orderBookOf } from '../orders/orderBook';
import type { JournalLine } from '../posting/plan';
import { dayBookRows } from '../reports/books';
import { inr } from '../reports/digest';
import { orderRegisterRows } from '../reports/orderRegister';
import { outstandingBills, outstandingByParty } from '../reports/outstanding';
import type { StockMovement } from '../stock/movement';
import { type Qty, formatQty, qty } from '../stock/quantity';
import type { Voucher } from '../vouchers/voucher';

/**
 * THE ASSISTANT'S LOOK-UPS (the floating assistant, v1): each answers one kind of question from the live books, as small plain JSON the
 * model can read — names, codes, quantities with units, amounts in rupees, dates as YYYY-MM-DD. Read only; nothing here changes the books.
 * Lists are capped (the model gets facts, not screens) and say how many more there were.
 */

export interface AssistantBooks {
  readonly masters: Masters;
  /** Posted and cancelled vouchers, as the backend lists them. */
  readonly vouchers: readonly Voucher[];
  readonly lines: readonly JournalLine[];
  readonly movements: readonly StockMovement[];
  /** Today in India. */
  readonly today: LocalDate;
}

const LIMIT = 30;
const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
const capped = <T>(rows: readonly T[], limit = LIMIT) => ({ rows: rows.slice(0, limit), ...(rows.length > limit ? { more: rows.length - limit } : {}) });

// ---- items ----------------------------------------------------------------------------------------------------------------------

/**
 * The items a word means. An exact code (or alias, or whole name) wins alone — "14188-1" is never 14188-18 — else the items whose code
 * starts with it or whose name contains it.
 */
export function resolveItems(masters: Masters, text: string): { readonly exact?: StockItem; readonly matches: readonly StockItem[] } {
  const t = norm(text);
  if (t === '') return { matches: [] };
  const items = masters.stockItems.filter((i) => i.isActive);
  const exact = items.find((i) => norm(i.code) === t || norm(i.alias) === t || norm(i.name) === t);
  if (exact) return { exact, matches: [exact] };
  // "14188-1 - PLT,ORIF…": a name that starts with the typed code and a separator is that code
  const byNameCode = items.find((i) => norm(i.name).startsWith(`${t} -`) || norm(i.name).startsWith(`${t} `));
  if (byNameCode) return { exact: byNameCode, matches: [byNameCode] };
  const matches = items.filter((i) => norm(i.code).startsWith(t) || norm(i.name).includes(t) || norm(i.alias).includes(t));
  return { matches };
}

/** Quantity in hand per item and godown, from the stock movements. */
function positions(movements: readonly StockMovement[]): Map<StockItemId, Map<string, bigint>> {
  const out = new Map<StockItemId, Map<string, bigint>>();
  for (const m of movements) {
    const byWh = out.get(m.itemId) ?? new Map<string, bigint>();
    byWh.set(m.warehouseId, (byWh.get(m.warehouseId) ?? 0n) + (m.direction === 'in' ? m.qty : -m.qty));
    out.set(m.itemId, byWh);
  }
  return out;
}

const qtyText = (masters: Masters, item: StockItem, q: bigint) => {
  const unit = masters.unit(item.unitId);
  return `${formatQty(qty(q) as Qty, unit?.decimals ?? 0)}${unit ? ` ${unit.symbol}` : ''}`;
};

const TYPE_WORDS: Record<string, string> = { raw: 'raw material', wip: 'work in progress', finished: 'finished (made by us)', trading: 'trading', service: 'service' };
const itemNotes = (item: StockItem) => ({
  ...(item.mainDrawingId ? { mainDrawing: item.details?.flatMap((row) => row.files).find((file) => file.id === item.mainDrawingId)?.name ?? item.legacyMainDrawing?.name ?? '' } : item.legacyMainDrawing ? { mainDrawing: item.legacyMainDrawing.name } : {}),
  ...(item.details?.length ? { details: item.details.map((row) => ({ detail1: row.detail1, detail2: row.detail2, files: row.files.map((file) => file.name) })) } : {}),
});

/** find_items: a search — every item whose code starts with the words or whose name contains them (an exact code first), with its stock. */
export function findItems(b: AssistantBooks, query: string) {
  const t = norm(query);
  const { exact } = resolveItems(b.masters, query);
  const matches =
    t === ''
      ? []
      : [...(exact ? [exact] : []), ...b.masters.stockItems.filter((i) => i.isActive && i.id !== exact?.id && (norm(i.code).startsWith(t) || norm(i.name).includes(t) || norm(i.alias).includes(t)))];
  const pos = positions(b.movements);
  const total = (i: StockItem) => [...(pos.get(i.id)?.values() ?? [])].reduce((a, x) => a + x, 0n);
  return {
    query,
    found: matches.length,
    ...capped(matches.map((i) => ({ code: i.code ?? '', name: i.name, type: TYPE_WORDS[i.itemType] ?? i.itemType, inStock: qtyText(b.masters, i, total(i)), ...itemNotes(i) }))),
  };
}

/**
 * stock: one item's stock in hand, per godown. When the word names a family ("14188": the blank, and 14188-1, 14188-18… made from it),
 * the family's other members are listed with their stock too.
 */
export function stockOf(b: AssistantBooks, item: string) {
  const { exact, matches } = resolveItems(b.masters, item);
  const pos = positions(b.movements);
  const one = (i: StockItem) => {
    const byWh = pos.get(i.id) ?? new Map<string, bigint>();
    const total = [...byWh.values()].reduce((a, x) => a + x, 0n);
    return {
      code: i.code ?? '',
      name: i.name,
      type: TYPE_WORDS[i.itemType] ?? i.itemType,
      inStock: qtyText(b.masters, i, total),
      byGodown: [...byWh.entries()].filter(([, q]) => q !== 0n).map(([wh, q]) => ({ godown: b.masters.warehouse(wh as never)?.name ?? '', qty: qtyText(b.masters, i, q) })),
      ...itemNotes(i),
    };
  };
  if (!exact) {
    if (matches.length === 0) return { item, found: false, note: 'No item has this code or name.' };
    return { item, found: false, note: 'Several items match: say which one.', ...capped(matches.map(one)) };
  }
  const code = norm(exact.code);
  const family = code === '' ? [] : b.masters.stockItems.filter((i) => i.isActive && i.id !== exact.id && norm(i.code).startsWith(`${code}-`));
  return { found: true, ...one(exact), ...(family.length > 0 ? { family: capped(family.map(one)) } : {}) };
}

// ---- orders ---------------------------------------------------------------------------------------------------------------------

/** orders: order lines (customers' by default), open lines with something pending unless `includeDone`. */
export function orders(b: AssistantBooks, q: { party?: string; item?: string; side?: 'sales' | 'purchase'; includeDone?: boolean }) {
  const side = q.side ?? 'sales';
  const book = orderBookOf(b.vouchers.filter((v) => v.status === 'posted'), b.masters);
  let rows = orderRegisterRows(book, b.masters, '0001-01-01' as LocalDate, '9999-12-31' as LocalDate, { side, asOf: b.today });
  if (!q.includeDone) rows = rows.filter((r) => r.actionable);
  if (q.party) rows = rows.filter((r) => norm(r.party).includes(norm(q.party)));
  if (q.item) {
    const { exact, matches } = resolveItems(b.masters, q.item);
    const ids = new Set((exact ? [exact] : matches).map((i) => i.id as string));
    rows = rows.filter((r) => ids.has(r.itemId));
  }
  rows = [...rows].sort((a, c) => (a.due < c.due ? -1 : a.due > c.due ? 1 : 0));
  const text = (r: (typeof rows)[number], v: bigint) => `${formatQty(qty(v) as Qty, r.decimals)}${r.unit ? ` ${r.unit}` : ''}`;
  return {
    side: side === 'sales' ? "customers' orders" : 'our purchase orders',
    lines: rows.length,
    ...capped(
      rows.map((r) => ({
        order: r.number,
        date: r.date,
        [side === 'sales' ? 'customerPo' : 'supplierRef']: r.reference,
        party: r.party,
        item: r.item,
        due: r.due,
        ordered: text(r, r.ordered),
        [side === 'sales' ? 'delivered' : 'received']: text(r, r.delivered),
        pending: text(r, r.pending),
        status: r.status,
        ...(r.overdue ? { overdue: true } : {}),
      })),
    ),
  };
}

// ---- money ----------------------------------------------------------------------------------------------------------------------

/** outstanding: what customers owe us (or we owe suppliers) — per party, or one party's open bills. */
export function outstanding(b: AssistantBooks, q: { party?: string; side?: 'receivable' | 'payable' }) {
  const side = q.side ?? 'receivable';
  const posted = b.vouchers.filter((v) => v.status === 'posted');
  if (q.party) {
    const bills = outstandingBills({ vouchers: posted, masters: b.masters, side, asOn: b.today }).filter((x) => norm(x.party).includes(norm(q.party)));
    const total = bills.reduce((a, x) => a + x.pending, 0n);
    const late = bills.filter((x) => x.daysOverdue > 0).reduce((a, x) => a + x.pending, 0n);
    return {
      side: side === 'receivable' ? 'they owe us' : 'we owe them',
      party: q.party,
      total: inr(total),
      overdue: inr(late),
      ...capped(bills.map((x) => ({ party: x.party, bill: x.ref, date: x.billDate, due: x.dueDate, pending: inr(x.pending), ...(x.daysOverdue > 0 ? { daysLate: x.daysOverdue } : {}) }))),
    };
  }
  const parties = outstandingByParty({ vouchers: posted, lines: b.lines, masters: b.masters, side, asOn: b.today })
    .filter((p) => p.pending !== 0n)
    .sort((a, c) => (c.pending > a.pending ? 1 : c.pending < a.pending ? -1 : 0));
  const total = parties.reduce((a, p) => a + p.pending, 0n);
  return {
    side: side === 'receivable' ? 'customers owe us' : 'we owe suppliers',
    total: inr(total),
    ...capped(parties.map((p) => ({ party: p.name, pending: inr(p.pending), overdue: inr(p.pending - p.buckets.notDue), openBills: p.bills }))),
  };
}

/** invoices: sales (or purchase) invoices, newest first, with amount, reference and whether paid. */
export function invoices(b: AssistantBooks, q: { party?: string; number?: string; reference?: string; side?: 'sales' | 'purchase' }) {
  const kind = q.side ?? 'sales';
  const posted = b.vouchers.filter((v) => v.status === 'posted');
  const rows = dayBookRows({ vouchers: posted, lines: [...b.lines], masters: b.masters }).filter((r) => r.baseKind === kind);
  const pendingOf = new Map(outstandingBills({ vouchers: posted, masters: b.masters, side: kind === 'sales' ? 'receivable' : 'payable', asOn: b.today }).map((x) => [x.voucherId as string, x]));
  const byId = new Map(posted.map((v) => [v.id as string, v]));
  const found = rows
    .map((r) => {
      const content = byId.get(r.voucherId)?.content as { reference?: string; billNo?: string } | undefined;
      return { r, ref: content?.reference ?? content?.billNo ?? '' };
    })
    .filter(({ r, ref }) => (!q.party || norm(r.particulars).includes(norm(q.party))) && (!q.number || norm(r.number) === norm(q.number) || norm(r.number).endsWith(`/${norm(q.number)}`)) && (!q.reference || norm(ref).includes(norm(q.reference))))
    .sort((a, c) => (a.r.date < c.r.date ? 1 : a.r.date > c.r.date ? -1 : 0));
  return {
    kind: kind === 'sales' ? 'sales invoices' : 'purchase bills',
    found: found.length,
    ...capped(
      found.map(({ r, ref }) => {
        const amount = r.debit > r.credit ? r.debit : r.credit;
        const open = pendingOf.get(r.voucherId);
        return {
          number: r.number,
          date: r.date,
          party: r.particulars,
          ...(ref ? { reference: ref } : {}),
          amount: inr(amount),
          paid: !open ? 'yes' : open.pending === amount ? 'no' : `part — ${inr(open.pending)} still due`,
          ...(open ? { due: open.dueDate, ...(open.daysOverdue > 0 ? { daysLate: open.daysOverdue } : {}) } : {}),
        };
      }),
      20,
    ),
  };
}
