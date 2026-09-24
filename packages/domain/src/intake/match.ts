import type { Masters } from '../masters/masters';
import type { Party, PartyRole, StockItem } from '../masters/records';
import { canonicalId, gstinProblem, nameKey } from '../masters/rules';

/**
 * Finding the party and the items a document names among the company's masters. CAUTIOUS by design: a match is made only when it is
 * certain (an exact GSTIN, code or name) or when one candidate is clearly better than every other. Anything less is left unmatched, and the
 * review screen shows the document's own text for a person to pick or create — a wrong match is worse than none.
 */

/** Lower case, punctuation to spaces, one space between words. */
export const looseKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const bigrams = (s: string): string[] => {
  const t = looseKey(s).replace(/ /g, '');
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
};

/** How alike two names are, 0..1 (Sørensen–Dice over letter pairs; word order and punctuation do not matter much). */
export function similarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.length === 0 || y.length === 0) return looseKey(a) === looseKey(b) && looseKey(a) !== '' ? 1 : 0;
  const pool = new Map<string, number>();
  for (const g of y) pool.set(g, (pool.get(g) ?? 0) + 1);
  let common = 0;
  for (const g of x) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      common++;
      pool.set(g, n - 1);
    }
  }
  return (2 * common) / (x.length + y.length);
}

/** A fuzzy match is taken only above this… */
const FUZZY_MIN = 0.82;
/** …and only when the runner-up is at least this far behind. */
const FUZZY_MARGIN = 0.08;

function best<T>(candidates: readonly T[], score: (c: T) => number): T | undefined {
  let top: { c: T; s: number } | undefined;
  let second = 0;
  for (const c of candidates) {
    const s = score(c);
    if (!top || s > top.s) {
      second = top?.s ?? 0;
      top = { c, s };
    } else if (s > second) second = s;
  }
  return top && top.s >= FUZZY_MIN && top.s - second >= FUZZY_MARGIN ? top.c : undefined;
}

// The own company is never the party of its own document, and some of its name words ("Pvt", "Ltd", "Industries") mean nothing on their own.
const NOISE = /\b(m s|messrs|pvt|private|ltd|limited|llp|co|company|the|and|india|enterprises?)\b/g;
const partyKey = (s: string): string => looseKey(s).replace(NOISE, ' ').replace(/\s+/g, ' ').trim();

export type PartyMatch =
  | { readonly kind: 'matched'; readonly party: Party }
  /** The document's party exists, but without the role this document needs. */
  | { readonly kind: 'wrongRole'; readonly party: Party }
  | { readonly kind: 'none' };

/** The party a document names: by GSTIN first (certain), then by name (exact, then clearly the closest). */
export function matchParty(masters: Masters, hint: { name?: string | undefined; gstin?: string | undefined }, role: PartyRole): PartyMatch {
  const active = masters.parties.filter((p) => p.isActive);
  const withRole = (p: Party): PartyMatch => ((p.roles ?? []).includes(role) ? { kind: 'matched', party: p } : { kind: 'wrongRole', party: p });

  const gstin = hint.gstin ? canonicalId(hint.gstin) : '';
  if (gstin !== '' && !gstinProblem(gstin)) {
    const byGstin = active.filter((p) => p.gstin !== undefined && canonicalId(p.gstin) === gstin);
    // one GSTIN may sit on two profiles (a head office billed twice); prefer the one with the role
    const found = byGstin.find((p) => (p.roles ?? []).includes(role)) ?? byGstin[0];
    if (found) return withRole(found);
  }
  const name = hint.name?.trim() ?? '';
  if (name === '') return { kind: 'none' };
  const exact = active.find((p) => nameKey(p.name) === nameKey(name));
  if (exact) return withRole(exact);
  const key = partyKey(name);
  const loose = active.filter((p) => partyKey(p.name) === key && key !== '');
  if (loose.length === 1 && loose[0]) return withRole(loose[0]);
  const fuzzy = best(active, (p) => similarity(partyKey(p.name), key));
  return fuzzy ? withRole(fuzzy) : { kind: 'none' };
}

/** The stock item a document line names: by code, then exact name or alias, then (for the same HSN when both have one) clearly the closest name. */
export function matchItem(masters: Masters, hint: { description?: string | undefined; code?: string | undefined; hsn?: string | undefined }): StockItem | undefined {
  const active = masters.stockItems.filter((i) => i.isActive);
  const code = hint.code ? canonicalId(hint.code) : '';
  if (code !== '') {
    const byCode = active.find((i) => i.code !== undefined && canonicalId(i.code) === code);
    if (byCode) return byCode;
    // items named "<part number> - <description>" ("841010384-Washer", "841012360 - Adapter,Hex"): the part number leading the name
    const bare = code.replace(/[^A-Z0-9]/g, '');
    const leading = active.filter((i) => canonicalId(i.name.split(/\s*-\s*|\s/)[0] ?? '').replace(/[^A-Z0-9]/g, '') === bare);
    if (bare.length >= 4 && leading.length === 1) return leading[0];
  }
  const text = hint.description?.trim() ?? '';
  if (text === '') return undefined;
  const key = looseKey(text);
  const exact = active.find((i) => looseKey(i.name) === key || (i.alias !== undefined && looseKey(i.alias) === key));
  if (exact) return exact;
  // a code printed inside the description ("BLT-M8 Hex bolt") still names the item
  const words = new Set(key.split(' '));
  const coded = active.filter((i) => i.code !== undefined && looseKey(i.code) !== '' && words.has(looseKey(i.code)));
  if (coded.length === 1) return coded[0];
  // an item's whole name inside the line ("MS Sheet 2mm, cut to 1250x2500" names "MS Sheet 2mm") — when exactly one item's name is
  // there; the longest wins only when the others are part of it ("MS Sheet" inside "MS Sheet 2mm")
  const padded = ` ${key} `;
  const named = active.filter((i) => [i.name, i.alias].some((n) => n !== undefined && looseKey(n).length >= 6 && padded.includes(` ${looseKey(n)} `)));
  const longest = [...named].sort((a, b) => looseKey(b.name).length - looseKey(a.name).length)[0];
  if (longest && named.every((i) => i === longest || ` ${looseKey(longest.name)} `.includes(` ${looseKey(i.name)} `))) return longest;
  const hsn = hint.hsn?.replace(/\s+/g, '') ?? '';
  const pool = hsn === '' ? active : active.filter((i) => i.hsn === undefined || i.hsn === '' || i.hsn === hsn);
  return best(pool, (i) => Math.max(similarity(i.name, text), i.alias ? similarity(i.alias, text) : 0));
}
