import { formatMoney, money, parseMoney } from '../money';
import type { Extraction } from './extraction';

/**
 * Fixed rules for payment advices that arrive in the same layout every time, read straight from the PDF's text — no Gemini, so no wait,
 * no quota and no misreading. A document no rule recognises is left to the reader.
 *
 * Eclipse Combustion (paid through Honeywell's payables, "Remittance Advice"): one row per invoice —
 *   Invoice / Reference · Gross Amount · WHT Amount · GST Hold Amount · Net Amount
 * WHT is the TDS deducted; GST Hold is GST they keep back until our GSTR-1 shows on their side (still owed to us, so it stays open on the
 * invoice); Net is what reached the bank. So each invoice is settled by Net + WHT, WHT of it as TDS, and the receipt is the total Net.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const AMOUNT = String.raw`(\d[\d,]*\.\d{2})`;
const ROW = new RegExp(String.raw`(\d{2}-\d{2}\/\d+)\s+${AMOUNT}\s+${AMOUNT}\s+${AMOUNT}\s+${AMOUNT}`, 'g');
const TOTAL = new RegExp(String.raw`T\s*otal\s*:\s*${AMOUNT}\s+${AMOUNT}\s+${AMOUNT}\s+${AMOUNT}`);

/** Letters only, upper case: PDF text breaks words at odd places ("ECLIPSE COMBUSTION PVT\n L\nTD"). */
const squeezed = (text: string): string => text.toUpperCase().replace(/[^A-Z]/g, '');
const amountOf = (s: string) => parseMoney(s.replace(/,/g, ''));

function eclipseRemittance(text: string): Extraction | undefined {
  const letters = squeezed(text);
  if (!letters.includes('ECLIPSECOMBUSTION') || !letters.includes('REMITTANCEADVICE') || !letters.includes('WHTAMOUNT') || !letters.includes('GSTHOLDAMOUNT')) return undefined;
  const flat = text.replace(/\s+/g, ' ');

  const bills: { ref: string; amount: string; tds: string }[] = [];
  let net = 0n;
  for (const m of flat.matchAll(ROW)) {
    const [, ref, , wht, , paid] = m;
    const w = amountOf(wht as string);
    const n = amountOf(paid as string);
    if (w === undefined || n === undefined) return undefined;
    bills.push({ ref: ref as string, amount: formatMoney(money(n + w)), tds: formatMoney(w) });
    net += n;
  }
  const total = TOTAL.exec(flat);
  const totalNet = total ? amountOf(total[4] as string) : undefined;
  // every row read, or nothing: the rows must come to the printed total
  if (bills.length === 0 || totalNet === undefined || totalNet !== net) return undefined;

  const d = /Date\s*:\s*(\d{1,2})\s*([A-Za-z]{3})[a-z]*\s*,?\s*(\d{4})/.exec(flat);
  const month = d ? MONTHS.indexOf((d[2] as string).toLowerCase()) + 1 : 0;
  const date = d && month > 0 ? `${d[3]}-${String(month).padStart(2, '0')}-${(d[1] as string).padStart(2, '0')}` : undefined;
  const utr = /\b([A-Z]{4,5}\d{8,})\b/.exec(flat)?.[1];
  const account = /\*{2,}\s*(\d{4})/.exec(flat)?.[1];

  return {
    partyName: 'Eclipse Combustion Pvt Ltd',
    ...(date ? { date } : {}),
    amount: formatMoney(money(net)),
    ...(utr ? { instrument: utr } : {}),
    ...(account ? { bankAccount: account } : {}),
    lines: [],
    bills,
  } as Extraction;
}

/** The receipt a known payment advice's text says, or undefined when no rule knows the layout (or the numbers do not add up). */
export function readRemittanceAdvice(text: string): Extraction | undefined {
  return eclipseRemittance(text);
}
