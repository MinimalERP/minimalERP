import { csvOf, parseCsvRecords } from './format';
import { GST_REGISTRATIONS } from '../vouchers/drafts';
import { PARTY_ROLES, type Party, type PartyRole } from '../masters/records';
import { formatMoney, parseMoney } from '../money';

/** One row of the native Parties CSV — `partyDef`'s own flat field names (`commands.ts`), not any external
 *  format. `roles` is a `|`-separated cell (`"customer|vendor"`) since a party can be both. The nested
 *  `addresses[]` array is out of scope for this flat format (a future addition, not v1). */
export interface PartyRow {
  readonly name: string;
  readonly gstin: string;
  readonly pan: string;
  readonly phone: string;
  readonly email: string;
  readonly address: string;
  readonly stateCode: string;
  readonly creditDays: string;
  readonly creditLimit: string;
  readonly gstRegistration: string;
  readonly pincode: string;
  readonly country: string;
  readonly shippingLines: string;
  readonly shippingStateCode: string;
  readonly shippingPincode: string;
  readonly shippingCountry: string;
  readonly roles: string;
}

const COLUMNS = [
  'name',
  'gstin',
  'pan',
  'phone',
  'email',
  'address',
  'stateCode',
  'creditDays',
  'creditLimit',
  'gstRegistration',
  'pincode',
  'country',
  'shippingLines',
  'shippingStateCode',
  'shippingPincode',
  'shippingCountry',
  'roles',
] as const;

export function parsePartiesCsv(text: string): PartyRow[] {
  return parseCsvRecords(text).map((r) => {
    const row: Record<string, string> = {};
    for (const c of COLUMNS) row[c] = (r[c] ?? '').trim();
    return row as unknown as PartyRow;
  });
}

/** The same columns `parsePartiesCsv` reads — a true round trip (`addresses[]` is not exported either). */
export function serializePartiesCsv(parties: readonly Party[]): string {
  return csvOf([
    [...COLUMNS],
    ...parties.map((p) => [
      p.name,
      p.gstin ?? '',
      p.pan ?? '',
      p.phone ?? '',
      p.email ?? '',
      p.address ?? '',
      p.stateCode ?? '',
      p.creditDays !== undefined ? String(p.creditDays) : '',
      p.creditLimit !== undefined ? formatMoney(p.creditLimit) : '',
      p.gstRegistration ?? '',
      p.pincode ?? '',
      p.country ?? '',
      p.shipping?.lines ?? '',
      p.shipping?.stateCode ?? '',
      p.shipping?.pincode ?? '',
      p.shipping?.country ?? '',
      (p.roles ?? []).join('|'),
    ]),
  ]);
}

export interface ResolvedPartyRow {
  readonly ok: true;
  readonly data: Record<string, unknown>;
}
export interface UnresolvedPartyRow {
  readonly ok: false;
  readonly errors: string[];
}

/** Turns one row into the `party` master command's `data` — parsing `roles` and the money/number fields.
 *  Does not itself validate GSTIN format, name clashes, etc. — `prepareMasterCommand` does, same as the
 *  app's own Party screen, so the two never disagree about what's valid. */
export function resolvePartyRow(row: PartyRow): ResolvedPartyRow | UnresolvedPartyRow {
  const errors: string[] = [];
  if (row.name === '') errors.push('name is required');

  const roles: PartyRole[] = [];
  if (row.roles !== '') {
    for (const r of row.roles.split('|').map((s) => s.trim().toLowerCase())) {
      if (r === '') continue;
      if (!PARTY_ROLES.includes(r as PartyRole)) errors.push(`roles: "${r}" must be customer or vendor`);
      else roles.push(r as PartyRole);
    }
  }

  let creditDays: number | undefined;
  if (row.creditDays !== '') {
    const n = Number(row.creditDays);
    if (!Number.isInteger(n)) errors.push('creditDays must be a whole number');
    else creditDays = n;
  }

  let creditLimit: string | undefined;
  if (row.creditLimit !== '') {
    if (parseMoney(row.creditLimit) === undefined) errors.push('creditLimit must be a decimal amount like 50000 or 50000.00');
    else creditLimit = row.creditLimit;
  }

  if (row.gstRegistration !== '' && !GST_REGISTRATIONS.includes(row.gstRegistration as (typeof GST_REGISTRATIONS)[number])) {
    errors.push(`gstRegistration must be one of ${GST_REGISTRATIONS.join(', ')}`);
  }

  if (errors.length > 0) return { ok: false, errors };

  const shipping =
    row.shippingLines || row.shippingStateCode || row.shippingPincode || row.shippingCountry
      ? {
          ...(row.shippingLines !== '' ? { lines: row.shippingLines } : {}),
          ...(row.shippingStateCode !== '' ? { stateCode: row.shippingStateCode } : {}),
          ...(row.shippingPincode !== '' ? { pincode: row.shippingPincode } : {}),
          ...(row.shippingCountry !== '' ? { country: row.shippingCountry } : {}),
        }
      : undefined;

  return {
    ok: true,
    data: {
      name: row.name,
      ...(row.gstin !== '' ? { gstin: row.gstin } : {}),
      ...(row.pan !== '' ? { pan: row.pan } : {}),
      ...(row.phone !== '' ? { phone: row.phone } : {}),
      ...(row.email !== '' ? { email: row.email } : {}),
      ...(row.address !== '' ? { address: row.address } : {}),
      ...(row.stateCode !== '' ? { stateCode: row.stateCode } : {}),
      ...(creditDays !== undefined ? { creditDays } : {}),
      ...(creditLimit !== undefined ? { creditLimit } : {}),
      ...(row.gstRegistration !== '' ? { gstRegistration: row.gstRegistration } : {}),
      ...(row.pincode !== '' ? { pincode: row.pincode } : {}),
      ...(row.country !== '' ? { country: row.country } : {}),
      ...(shipping ? { shipping } : {}),
      ...(roles.length > 0 ? { roles } : {}),
    },
  };
}
