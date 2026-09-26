import { formatMoney, money, parseMoney } from '../money';
import type { Extraction } from './extraction';

/**
 * Fixed rules for customers' purchase orders that arrive in the same layout every time, read straight from the PDF's text — no Gemini, so
 * no wait, no quota and no misreading. A PO no rule recognises is left to the reader.
 *
 * Eclipse Combustion (Honeywell's SAP "Purchase order", many pages of terms after the items): one row per PO line —
 *   Item · Material · Quantity · UoM · Unit Price "/ per UoM" · Net Amount · TAX
 * followed by its short description, "HSN/SAC Code : …" and "Honeywell Request Date: DD-MON-YYYY" (the line's due date). The unit price may
 * be per 1,000 ("195,000.00 /1,000 EA"). The last page prints "Total net value excl. tax INR …", which the rows must add up to.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUM = String.raw`(\d[\d,]*\.\d+)`;
const ROW = new RegExp(String.raw`^(\d+) (\S+) ${NUM} ([A-Z]+) ${NUM} ?\/ ?(\d[\d,]*)? ?[A-Z]+ ${NUM} [YN]$`, 'gm');

/** Letters only, upper case: PDF text breaks words at odd places. */
const squeezed = (text: string): string => text.toUpperCase().replace(/[^A-Z]/g, '');
const amountOf = (s: string) => parseMoney(s.replace(/,/g, ''));
const plain = (s: string) => s.replace(/,/g, '');

/** "26-AUG-2026" → "2026-08-26". */
function isoDate(d: string | undefined): string | undefined {
  const m = d ? /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(d) : null;
  const month = m ? MONTHS.indexOf((m[2] as string).toLowerCase()) + 1 : 0;
  return m && month > 0 ? `${m[3]}-${String(month).padStart(2, '0')}-${(m[1] as string).padStart(2, '0')}` : undefined;
}

/** Unit price ÷ its "per" quantity, to 4 decimals at most: "195,000.00" per "1,000" → "195". */
function rateOf(price: string, per: string | undefined): string | undefined {
  const p = Number(plain(price));
  const n = per ? Number(plain(per)) : 1;
  if (!Number.isFinite(p) || !Number.isFinite(n) || n <= 0) return undefined;
  return String(Math.round((p / n) * 10_000) / 10_000);
}

function eclipsePurchaseOrder(text: string): Extraction | undefined {
  const letters = squeezed(text);
  if (!letters.includes('ECLIPSECOMBUSTION') || !letters.includes('PURCHASEORDER') || !letters.includes('HONEYWELLREQUESTDATE') || !letters.includes('TOTALNETVALUEEXCLTAX')) return undefined;
  const t = text.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n');

  const rows = [...t.matchAll(ROW)];
  const lines: Extraction['lines'] = [];
  let sum = 0n;
  for (const [i, m] of rows.entries()) {
    const [, , code, qty, unit, price, per, net] = m;
    const amount = amountOf(net as string);
    const rate = rateOf(price as string, per);
    if (amount === undefined || rate === undefined) return undefined;
    sum += amount;
    // what belongs to this row runs to the next row (a page break may fall in between: its headers are skipped by the patterns)
    const block = t.slice((m.index ?? 0) + m[0].length, rows[i + 1]?.index ?? t.indexOf('Total net value'));
    const description = block.split('\n').find((l) => l !== '');
    const hsn = /HSN\/SAC Code\s*:\s*(\d{4,8})/.exec(block)?.[1];
    const dueDate = isoDate(/Honeywell Request Date\s*:\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/.exec(block)?.[1]);
    lines.push({
      code: code as string,
      ...(description ? { description: description.slice(0, 200) } : {}),
      ...(hsn ? { hsn } : {}),
      qty: plain(qty as string),
      unit: unit as string,
      rate,
      amount: formatMoney(money(amount)),
      ...(dueDate ? { dueDate } : {}),
    });
  }
  const total = /Total net value excl\. tax INR\s*(\d[\d,]*\.\d{2})/.exec(t);
  const totalNet = total ? amountOf(total[1] as string) : undefined;
  // every row read, or nothing: the rows must come to the printed total
  if (lines.length === 0 || totalNet === undefined || totalNet !== sum) return undefined;

  const poNumber = /Purchase order\nNumber\n(\d{6,})/.exec(t)?.[1] ?? /PO Number:\s*(\d{6,})/.exec(t)?.[1];
  const date = isoDate(/\nDate\n(\d{1,2}-[A-Za-z]{3}-\d{4})/.exec(t)?.[1]);
  // the customer's GSTIN is the bill-to one (the other GSTIN on the page is ours, under "Vendor Address")
  const gstin = /Bill to address:[\s\S]{0,40}?GSTIN\s*:\s*([0-9A-Z]{15})/.exec(t)?.[1];

  return {
    partyName: 'Eclipse Combustion Pvt Ltd',
    ...(gstin ? { partyGstin: gstin } : {}),
    ...(poNumber ? { poNumber } : {}),
    ...(date ? { date } : {}),
    subtotal: formatMoney(money(sum)),
    lines,
    bills: [],
  } as Extraction;
}

/** The sales order a known customer PO's text says, or undefined when no rule knows the layout (or the rows do not add up). */
export function readPurchaseOrder(text: string): Extraction | undefined {
  return eclipsePurchaseOrder(text);
}
