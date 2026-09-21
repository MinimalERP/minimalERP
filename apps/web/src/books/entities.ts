import type { EntityDoc } from '@minimalerp/command';
import {
  type MasterKind,
  type Masters,
  MASTER_LABELS,
  formatMoney,
  isMasterActive,
  listMasters,
  masterRecordName,
  partyLedgerId,
} from '@minimalerp/domain';

/** The kinds Go To searches, with the `l:`/`@`/`i:` prefix scope each answers to. */
export const SEARCHABLE: readonly { readonly kind: MasterKind; readonly scope: string; readonly label: string }[] = [
  { kind: 'ledger', scope: 'ledger', label: 'Ledger' },
  { kind: 'group', scope: 'group', label: 'Group' },
  { kind: 'party', scope: 'party', label: 'Party' },
  { kind: 'stockItem', scope: 'item', label: 'Stock Item' },
  { kind: 'stockGroup', scope: 'stockgroup', label: 'Stock Group' },
  { kind: 'unit', scope: 'unit', label: 'Unit' },
  { kind: 'warehouse', scope: 'warehouse', label: 'Warehouse' },
  { kind: 'voucherType', scope: 'setting', label: 'Voucher Type' },
  { kind: 'gstRate', scope: 'setting', label: 'GST Rate' },
];

export const ENTITY_SCOPES: readonly string[] = [...new Set(SEARCHABLE.map((s) => s.scope))];

/** "Customer · Vendor" for a party that is both. */
const rolesLabel = (roles: unknown): string =>
  Array.isArray(roles) ? roles.map((x) => (x === 'vendor' ? 'Vendor' : 'Customer')).join(' · ') : '';

const compact = (parts: readonly (string | undefined)[]): string[] => parts.filter((p): p is string => p !== undefined && p !== '');

/** How each kind describes itself: the line under its name and the codes that should find it outright. */
function describe(kind: MasterKind, masters: Masters, r: Record<string, unknown>): { title: string; subtitle?: string | undefined; identifiers: string[]; keywords: string[] } {
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : undefined);
  switch (kind) {
    case 'ledger': {
      const group = masters.groups.get(r.groupId as never)?.name;
      const party = r.partyId ? masters.party(r.partyId as never)?.name : undefined;
      return { title: str('name') ?? '', subtitle: compact([group, party]).join(' · '), identifiers: compact([str('code'), str('alias')]), keywords: compact([str('alias')]) };
    }
    case 'group':
      return { title: str('name') ?? '', subtitle: compact([masters.groups.get(r.parentId as never)?.name]).join(''), identifiers: [], keywords: [] };
    case 'party':
      return {
        title: str('name') ?? '',
        subtitle: compact([rolesLabel(r.roles), str('gstin'), str('phone'), str('address')]).join(' · '),
        identifiers: compact([str('gstin'), str('pan'), str('phone'), str('email')]),
        keywords: compact([str('address')]),
      };
    case 'stockItem': {
      const unit = masters.unit(r.unitId as never)?.symbol;
      const group = r.groupId ? masters.stockGroup(r.groupId as never)?.name : undefined;
      return {
        title: str('name') ?? '',
        subtitle: compact([unit, group, str('hsn') ? `HSN ${str('hsn')}` : undefined]).join(' · '),
        identifiers: compact([str('code'), str('alias'), str('hsn')]),
        keywords: compact([str('alias')]),
      };
    }
    case 'stockGroup':
      return { title: str('name') ?? '', identifiers: [], keywords: [] };
    case 'unit':
      return { title: `${str('name') ?? ''} (${str('symbol') ?? ''})`, identifiers: compact([str('symbol')]), keywords: [] };
    case 'warehouse':
      return { title: str('name') ?? '', subtitle: r.parentId ? masters.warehouse(r.parentId as never)?.name : undefined, identifiers: [], keywords: ['godown', 'location'] };
    case 'voucherType':
      return { title: str('name') ?? '', subtitle: str('baseKind'), identifiers: [], keywords: ['voucher'] };
    case 'gstRate':
      return { title: str('name') ?? '', subtitle: `${str('ratePercent') ?? ''}%`, identifiers: compact([str('ratePercent')]), keywords: ['tax'] };
    default:
      return { title: '', identifiers: [], keywords: [] };
  }
}

/** The ledgers whose report a record has: a ledger's own, a party's customer / vendor ledgers. (A stock item has its Stock ledger instead.) */
export function ledgersOfRecord(masters: Masters, kind: string, id: string): { id: string; role?: 'customer' | 'vendor' }[] {
  if (kind === 'ledger') return masters.ledger(id as never) ? [{ id }] : [];
  if (kind !== 'party') return [];
  const roles = masters.party(id as never)?.roles ?? [];
  return roles
    .filter((x): x is 'customer' | 'vendor' => x === 'customer' || x === 'vendor')
    .filter((role) => masters.ledger(partyLedgerId(id, role) as never) !== undefined)
    .map((role) => ({ id: partyLedgerId(id, role) as string, role }));
}

/** Whether an item's Stock ledger exists for it (services hold no stock). */
export const hasStockLedger = (masters: Masters, kind: string, id: string): boolean => kind === 'stockItem' && masters.stockItem(id as never)?.itemType !== undefined && masters.stockItem(id as never)?.itemType !== 'service';

/** A party's ledger report: one action per ledger it has ("as customer" / "as vendor" when it is both). */
function partyReports(masters: Masters, id: string, roles: unknown): { label: string; commandId: string; args: unknown }[] {
  if (!Array.isArray(roles)) return [];
  const mine = roles.filter((x): x is 'customer' | 'vendor' => x === 'customer' || x === 'vendor').filter((role) => masters.ledger(partyLedgerId(id, role) as never) !== undefined);
  return mine.map((role) => ({
    label: mine.length > 1 ? `Ledger report (as ${role})` : 'Ledger report',
    commandId: 'report.ledgerOf',
    args: { id: partyLedgerId(id, role) },
  }));
}

const cache = new WeakMap<Masters, readonly EntityDoc[]>();

/**
 * Every master as a searchable document. Built once per snapshot (the snapshot is immutable, so a change simply
 * produces a new one) — this is what makes Go To's ledgers, parties and items appear the instant they are created.
 */
export function entityDocsOf(masters: Masters): readonly EntityDoc[] {
  const hit = cache.get(masters);
  if (hit) return hit;
  const docs: EntityDoc[] = [];
  for (const { kind, scope, label } of SEARCHABLE) {
    for (const record of listMasters(masters, kind)) {
      const r = record as unknown as Record<string, unknown>;
      const id = r.id as string;
      // A party's own ledgers are reached through the party: one hit per party, not one per ledger.
      if (kind === 'ledger' && r.partyRole !== undefined) continue;
      const d = describe(kind, masters, r);
      if (d.title === '') continue;
      docs.push({
        key: `${kind}:${id}`,
        kind: label,
        scope,
        title: d.title,
        subtitle: d.subtitle || undefined,
        identifiers: d.identifiers,
        keywords: d.keywords,
        commandId: 'master.open',
        args: { kind, id, mode: 'display' },
        actions: [
          { label: `Display ${label}`, commandId: 'master.open', args: { kind, id, mode: 'display' } },
          { label: `Alter ${label}`, commandId: 'master.open', args: { kind, id, mode: 'alter' } },
          // A ledger's entries with a running balance: the Ledger report opened on it.
          ...(kind === 'ledger' ? [{ label: 'Ledger report', commandId: 'report.ledgerOf', args: { id } }] : []),
          ...(kind === 'party' ? partyReports(masters, id, r.roles) : []),
          // a group of accounts: its sub-groups and ledgers with their balances, one level down
          ...(kind === 'group' ? [{ label: 'Group summary', commandId: 'report.groupSummary', args: { id } }] : []),
          // an item's movements with a running quantity and value: the Stock ledger opened on it
          ...(kind === 'stockItem' && r.itemType !== 'service' ? [{ label: 'Stock ledger', commandId: 'report.stockLedgerOf', args: { id } }] : []),
          // every sales order that has this item: order no, customer PO, status, delivered / ordered
          ...(kind === 'stockItem' && r.itemType !== 'service' ? [{ label: 'Sales orders', commandId: 'report.salesOrdersOf', args: { id } }] : []),
          // every purchase order that has this item: what we asked suppliers for, received / ordered
          ...(kind === 'stockItem' && r.itemType !== 'service' ? [{ label: 'Purchase orders', commandId: 'report.purchaseOrdersOf', args: { id } }] : []),
        ],
        inactive: !isMasterActive(kind, record),
      });
      // Go To is for going: a ledger, a party or an item is found ONCE as the master and ONCE as its report, so typing the name and pressing
      // Enter on the second row goes straight to the Ledger report / Stock ledger (no need to open the master and look for the report).
      const reports = [
        ...ledgersOfRecord(masters, kind, id).map((l, _, all) => ({ label: 'Ledger report', role: all.length > 1 ? l.role : undefined, commandId: 'report.ledgerOf', args: { id: l.id } })),
        ...(hasStockLedger(masters, kind, id) ? [{ label: 'Stock ledger', role: undefined, commandId: 'report.stockLedgerOf', args: { id } }] : []),
      ];
      for (const rep of reports) {
        docs.push({
          key: `report:${kind}:${id}:${rep.role ?? ''}`,
          kind: rep.label,
          scope,
          // the two ledgers of a party that is both look alike in the list, so the role is part of the title
          title: rep.role ? `${d.title} (as ${rep.role})` : d.title,
          subtitle: d.subtitle || undefined,
          identifiers: d.identifiers,
          keywords: [...d.keywords, 'report', 'ledger', 'statement', 'account'],
          commandId: rep.commandId,
          args: rep.args,
          inactive: !isMasterActive(kind, record),
        });
      }
    }
  }
  cache.set(masters, docs);
  return docs;
}

/** A one-line description of any master, for lists. */
export function summaryOf(kind: MasterKind, masters: Masters, record: unknown): { title: string; subtitle: string; inactive: boolean } {
  const r = record as Record<string, unknown>;
  if (kind === 'numberingSeries') {
    const type = masters.voucherType(r.voucherTypeId as never)?.name ?? '?';
    const year = masters.financialYears.find((y) => y.id === r.financialYearId)?.label ?? '?';
    return { title: `${type} — ${year}`, subtitle: `${String(r.prefix ?? '')}0001${String(r.suffix ?? '')}`, inactive: false };
  }
  if (kind === 'company') return { title: masters.company.name, subtitle: masters.company.gstin ?? '', inactive: false };
  const d = describe(kind, masters, r);
  const extra = kind === 'party' && typeof r.creditLimit === 'bigint' ? ` · limit ${formatMoney(r.creditLimit as never)}` : '';
  return { title: d.title || masterRecordName(record as never), subtitle: (d.subtitle ?? '') + extra, inactive: !isMasterActive(kind, record as never) };
}

export const kindLabel = (kind: MasterKind): string => MASTER_LABELS[kind];
