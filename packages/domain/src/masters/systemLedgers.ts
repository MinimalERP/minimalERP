import { asLedgerId, deterministicUuid } from '../ids';
import type { GroupTree, ReservedGroupKey } from './groups';
import type { Ledger, Masters, SystemLedgerKey } from './masters';

export type { SystemLedgerKey };

/**
 * The ledgers the books need to exist before the first GST or TDS entry (ADR-0019): one per tax head, output (a liability we owe) and input (a
 * credit we hold), and the TDS a customer deducted before paying us. They are ordinary ledgers in every way that matters to the books — they post,
 * appear in the Trial Balance and the ledger report — but carry a RESERVED KEY so the posting engine can find them without a configuration screen,
 * and so they cannot be renamed, moved or deactivated (which would silently break GST).
 */

export interface SystemLedgerSpec {
  readonly key: SystemLedgerKey;
  readonly name: string;
  readonly group: ReservedGroupKey;
}

export const SYSTEM_LEDGERS: readonly SystemLedgerSpec[] = [
  { key: 'gst-output-cgst', name: 'Output CGST', group: 'duties-and-taxes' },
  { key: 'gst-output-sgst', name: 'Output SGST', group: 'duties-and-taxes' },
  { key: 'gst-output-igst', name: 'Output IGST', group: 'duties-and-taxes' },
  { key: 'gst-input-cgst', name: 'Input CGST', group: 'loans-and-advances-asset' },
  { key: 'gst-input-sgst', name: 'Input SGST', group: 'loans-and-advances-asset' },
  { key: 'gst-input-igst', name: 'Input IGST', group: 'loans-and-advances-asset' },
  { key: 'tds-receivable', name: 'TDS Receivable', group: 'loans-and-advances-asset' },
  { key: 'round-off', name: 'Round Off', group: 'indirect-expenses' },
];

/** The id a company's system ledger has: derived from the company and the key, so seeding and upgrading a saved company always agree. */
export const systemLedgerId = (companyId: string, key: SystemLedgerKey) => asLedgerId(deterministicUuid(`system-ledger|${companyId}|${key}`));

const groupOf = (groups: GroupTree, key: ReservedGroupKey) => groups.all.find((g) => g.reservedKey === key);

/** The system ledgers of a company (all of them, as ledger records). */
export function systemLedgersFor(masters: Pick<Masters, 'company' | 'groups'>): Ledger[] {
  const out: Ledger[] = [];
  for (const spec of SYSTEM_LEDGERS) {
    const group = groupOf(masters.groups, spec.group);
    if (!group) continue;
    out.push({ id: systemLedgerId(masters.company.id, spec.key), companyId: masters.company.id, name: spec.name, groupId: group.id, isActive: true, reservedKey: spec.key });
  }
  return out;
}

/**
 * Makes sure a company has every system ledger — the step that upgrades a company saved before GST existed. Matched by reserved key, so running it
 * twice, or on a company that already has them, changes nothing. A company that had already made an ordinary ledger of the same NAME (say a
 * "TDS Receivable" it set up by hand) keeps that ledger and its entries: it is adopted as the system ledger rather than duplicated.
 */
export function ensureSystemLedgers(masters: Masters): Masters {
  const have = new Set<string>(masters.ledgers.flatMap((l) => (l.reservedKey === undefined ? [] : [l.reservedKey])));
  const missing = systemLedgersFor(masters).filter((l) => l.reservedKey !== undefined && !have.has(l.reservedKey));
  if (missing.length === 0) return masters;
  const adopt = new Map<string, SystemLedgerKey>();
  const add: Ledger[] = [];
  for (const l of missing) {
    const same = masters.ledgers.find((x) => x.reservedKey === undefined && x.partyId === undefined && x.name.trim().toLowerCase() === l.name.toLowerCase());
    if (same) adopt.set(same.id, l.reservedKey as SystemLedgerKey);
    else add.push(l);
  }
  return masters.with({ ledgers: [...masters.ledgers.map((x) => (adopt.has(x.id) ? { ...x, reservedKey: adopt.get(x.id) } : x)), ...add] });
}
