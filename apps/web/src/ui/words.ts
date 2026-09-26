/** Indian numbering (thousand / lakh / crore) — the words come from the same figure that prints as a number. */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigitWords(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? ` ${ONES[o]}` : '');
}
function threeDigitWords(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  let s = h ? `${ONES[h]} Hundred` : '';
  if (r) s += (s ? ' ' : '') + twoDigitWords(r);
  return s;
}
function numberToWordsIndian(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  const parts: string[] = [];
  if (crore) parts.push(`${threeDigitWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigitWords(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigitWords(thousand)} Thousand`);
  if (n) parts.push(threeDigitWords(n));
  return parts.join(' ');
}
/** `grandTotal` is minor units (paise, per the app's own money convention). */
export function amountInWords(grandTotal: bigint): string {
  const rupees = Number(grandTotal / 100n);
  const paise = Number(grandTotal % 100n);
  let s = `Rupees ${numberToWordsIndian(rupees)}`;
  if (paise > 0) s += ` and ${numberToWordsIndian(paise)} Paise`;
  return `${s} Only`;
}
