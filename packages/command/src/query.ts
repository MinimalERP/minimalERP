import type { ParsedQuery } from './types';

/**
 * Optional prefixes narrow a query to one kind of result:
 *   `>trial`   commands only        `l:abc`  ledgers        `i:bolt`  stock items
 *   `v:S/24`   vouchers             `@abc`   parties
 *   `u:kg`     units                `w:main` warehouses
 * Providers for those kinds arrive with their phases; the prefixes are parsed now so the query
 * language does not change later.
 */
const PREFIXES: readonly (readonly [prefix: string, scope: string])[] = [
  ['>', 'command'],
  ['@', 'party'],
  ['l:', 'ledger'],
  ['g:', 'group'],
  ['i:', 'item'],
  ['u:', 'unit'],
  ['w:', 'warehouse'],
  ['v:', 'voucher'],
];

export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  for (const [prefix, scope] of PREFIXES) {
    if (lower.startsWith(prefix)) {
      const text = trimmed.slice(prefix.length).trim();
      return { raw, text, terms: text.split(/\s+/).filter(Boolean), scope };
    }
  }
  return { raw, text: trimmed, terms: trimmed.split(/\s+/).filter(Boolean) };
}
