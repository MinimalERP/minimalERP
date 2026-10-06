import { GST_STATE_NAMES, type Issue, canonicalId, gstinProblem, prepareMasterCommand, stateOfGstin } from '@minimalerp/domain';
import type { Books } from '../books/books';

/**
 * A stock item or a customer made on the phone, in the few fields a sale needs. It is the desktop's own master command (`create` of a
 * `stockItem` / `party`): `prepareMasterCommand` judges it here with the rules the server then applies again, and `books.execute` sends it.
 * Everything else about the record (opening stock, addresses, credit terms, drawings) is filled in on the desktop, on the same record.
 */

export type CreateWhat = 'item' | 'customer';

export interface ItemFields {
  readonly name: string;
  readonly unitId: string;
  readonly itemType: string;
  readonly hsn: string;
  readonly gstRateId: string;
}

export interface CustomerFields {
  readonly name: string;
  readonly phone: string;
  readonly gstin: string;
  readonly stateCode: string;
  readonly address: string;
}

export const ITEM_TYPE_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'finished', label: 'Finished goods' },
  { value: 'trading', label: 'Trading goods' },
  { value: 'raw', label: 'Raw material' },
  { value: 'service', label: 'Service' },
];

export const STATE_CHOICES: readonly { readonly value: string; readonly label: string }[] = Object.entries(GST_STATE_NAMES)
  .map(([value, name]) => ({ value, label: `${name} (${value})` }))
  .sort((a, b) => a.label.localeCompare(b.label));

/** What a new item starts as: the name that was searched for, counted in Nos (or the first unit), finished goods, no tax details yet. */
export function blankItem(books: Books, name = ''): ItemFields {
  const units = books.masters.units.filter((u) => u.isActive);
  return { name, unitId: (units.find((u) => u.symbol === 'Nos') ?? units[0])?.id ?? '', itemType: 'finished', hsn: '', gstRateId: '' };
}

/** What a new customer starts as: the name that was searched for, in the company's own state. */
export const blankCustomer = (books: Books, name = ''): CustomerFields => ({ name, phone: '', gstin: '', stateCode: books.masters.company.stateCode ?? '', address: '' });

/** A GSTIN typed in says its own state: the state follows it. */
export function withGstin(fields: CustomerFields, typed: string): CustomerFields {
  const gstin = canonicalId(typed);
  return { ...fields, gstin, ...(gstin.length === 15 && !gstinProblem(gstin) ? { stateCode: stateOfGstin(gstin) } : {}) };
}

const text = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());

export function itemCommand(id: string, f: ItemFields): unknown {
  return { op: 'create', kind: 'stockItem', id, data: { name: f.name.trim(), unitId: f.unitId, itemType: f.itemType, groupId: null, gstRateId: f.gstRateId === '' ? null : f.gstRateId, ...(text(f.hsn) ? { hsn: text(f.hsn) } : {}) } };
}

export function customerCommand(id: string, f: CustomerFields): unknown {
  return {
    op: 'create',
    kind: 'party',
    id,
    data: {
      name: f.name.trim(),
      roles: ['customer'],
      ...(text(f.phone) ? { phone: text(f.phone) } : {}),
      ...(text(f.gstin) ? { gstin: canonicalId(f.gstin) } : {}),
      ...(text(f.stateCode) ? { stateCode: text(f.stateCode) } : {}),
      ...(text(f.address) ? { address: text(f.address) } : {}),
    },
  };
}

/** What the rules say of the command as it stands — each problem under the field it names (the first segment of its path). */
export function createProblems(books: Books, command: unknown): Readonly<Record<string, string>> {
  const r = prepareMasterCommand(command, books.masters);
  if (r.ok) return {};
  const out: Record<string, string> = {};
  for (const i of r.issues as readonly Issue[]) {
    const field = (i.path ?? '').split('.')[0] || 'general';
    if (out[field] === undefined) out[field] = i.message;
  }
  return out;
}
