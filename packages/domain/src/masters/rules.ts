/**
 * Format and checksum rules for identifiers that appear on masters. Pure functions returning a problem
 * message, or undefined when the value is fine. Blank is the caller's business (these validate a
 * value that is present).
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_SHAPE = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$/;

/** GST state / union-territory codes in use (01–38, plus 97 Other Territory and 99 Centre Jurisdiction). */
export const GST_STATE_CODES: ReadonlySet<string> = new Set([
  ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')),
  '97',
  '99',
]);

/** The state / union territory each GST code stands for — for printing ("Place of Supply: Maharashtra (27)"). */
export const GST_STATE_NAMES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (Old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
};

/** The GSTIN check character: base-36 weighted sum (weights 1,2,1,2…) over the first 14 characters. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < first14.length; i++) {
    const value = ALPHABET.indexOf(first14.charAt(i));
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET.charAt((36 - (sum % 36)) % 36);
}

export function gstinProblem(gstin: string): string | undefined {
  const m = GSTIN_SHAPE.exec(gstin);
  if (!m) return 'A GSTIN is 15 characters: 2-digit state code, 10-character PAN, entity number, "Z", check digit';
  if (!GST_STATE_CODES.has(m[1] as string)) return `${m[1]} is not a GST state code`;
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin.charAt(14)) return 'The GSTIN check digit does not match — please re-check the number';
  return undefined;
}

/** The PAN embedded in a GSTIN (characters 3–12). */
export const panOfGstin = (gstin: string): string => gstin.slice(2, 12);
export const stateOfGstin = (gstin: string): string => gstin.slice(0, 2);

export function panProblem(pan: string): string | undefined {
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? undefined : 'A PAN is 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F)';
}

/** HSN (goods) is 4, 6 or 8 digits; SAC (services) is 6 digits starting 99 — covered by the 6-digit rule. */
export function hsnProblem(code: string): string | undefined {
  return /^(\d{4}|\d{6}|\d{8})$/.test(code) ? undefined : 'An HSN/SAC code is 4, 6 or 8 digits';
}

export function phoneProblem(phone: string): string | undefined {
  const digits = phone.replace(/[\s-]/g, '');
  return /^(\+?91)?[6-9]\d{9}$/.test(digits) || /^0[1-9]\d{8,10}$/.test(digits)
    ? undefined
    : 'Enter a 10-digit mobile number (or a landline with its STD code)';
}

export function emailProblem(email: string): string | undefined {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? undefined : 'That does not look like an email address';
}

/** A party's email field holds one address or several, separated by commas or semicolons: trimmed, empty parts and repeats (any case) left out. */
export function emailsOf(text: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (text ?? '').split(/[,;]/)) {
    const email = part.trim();
    if (email === '' || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push(email);
  }
  return out;
}

/** The first address in a list that is not an email address, named. */
export function emailListProblem(text: string): string | undefined {
  const emails = emailsOf(text);
  if (emails.length === 0) return 'Enter an email address';
  const bad = emails.find((e) => emailProblem(e) !== undefined);
  return bad === undefined ? undefined : `“${bad}” does not look like an email address`;
}

/** Collapses runs of whitespace and trims: "  ABC   Industries " → "ABC Industries". */
export const normalizeName = (name: string): string => name.replace(/\s+/g, ' ').trim();

/** The key names are compared by: case-insensitive, whitespace-insensitive. */
export const nameKey = (name: string): string => normalizeName(name).toLowerCase();

/** A non-negative decimal like "18", "12.5", "0.05". */
export const isDecimalText = (s: string): boolean => /^\d+(\.\d{1,4})?$/.test(s);

/** Uppercases and strips spaces from an identifier the user typed (GSTIN, PAN). */
export const canonicalId = (s: string): string => s.replace(/\s+/g, '').toUpperCase();
