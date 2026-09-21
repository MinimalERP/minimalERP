import { z } from 'zod';
import { parseLocalDate } from '../dates';
import { formatMoney } from '../money';
import { type Issue, type Result, IssueCode, fail, failWith, issue, ok } from '../errors';
import type { GroupId } from '../ids';
import { GST_REGISTRATIONS, moneySchema } from '../vouchers/drafts';
import { draftToJson, jsonEqual } from '../wire';
import { type AccountGroup, GroupTree } from './groups';
import {
  type BaseKind,
  type Company,
  type Ledger,
  type Masters,
  type NumberingSeries,
  USER_BASE_KINDS,
  type VoucherType,
} from './masters';
import {
  ITEM_TYPES,
  type GstRate,
  type Party,
  type PartyRole,
  partyLedgerId,
  type StockGroup,
  type StockItem,
  type Unit,
  type Warehouse,
} from './records';
import {
  GST_STATE_CODES,
  canonicalId,
  emailProblem,
  gstinProblem,
  hsnProblem,
  isDecimalText,
  nameKey,
  normalizeName,
  panOfGstin,
  panProblem,
  phoneProblem,
  stateOfGstin,
} from './rules';

/**
 * MASTER COMMANDS — the master-data twin of the voucher engine. A command (create / alter / activate)
 * is validated against the current `Masters` snapshot and either refused with issues or turned into a
 * change plus the next snapshot. Pure: no I/O. The browser previews with it, the server enforces with it,
 * and the database only stores the result (and re-enforces uniqueness/foreign keys as a backstop).
 */
export type MasterKind =
  | 'group'
  | 'ledger'
  | 'party'
  | 'unit'
  | 'stockGroup'
  | 'stockItem'
  | 'warehouse'
  | 'gstRate'
  | 'voucherType'
  | 'numberingSeries'
  | 'company';

export const MASTER_KINDS: readonly MasterKind[] = [
  'group', 'ledger', 'party', 'unit', 'stockGroup', 'stockItem', 'warehouse', 'gstRate', 'voucherType', 'numberingSeries', 'company',
];

export const MASTER_LABELS: Readonly<Record<MasterKind, string>> = {
  group: 'Group',
  ledger: 'Ledger',
  party: 'Party',
  unit: 'Unit',
  stockGroup: 'Stock Group',
  stockItem: 'Stock Item',
  warehouse: 'Warehouse',
  gstRate: 'GST Rate',
  voucherType: 'Voucher Type',
  numberingSeries: 'Numbering Series',
  company: 'Company',
};

export type MasterRecord =
  | AccountGroup
  | Ledger
  | Party
  | Unit
  | StockGroup
  | StockItem
  | Warehouse
  | GstRate
  | VoucherType
  | NumberingSeries
  | Company;

/** Facts about how existing data USES masters — supplied by the adapter, since only it can see the books. */
export interface MasterUsage {
  readonly ledgersWithEntries: ReadonlySet<string>;
  readonly voucherTypesInUse: ReadonlySet<string>;
  readonly seriesInUse: ReadonlySet<string>;
}

export const NO_USAGE: MasterUsage = {
  ledgersWithEntries: new Set(),
  voucherTypesInUse: new Set(),
  seriesInUse: new Set(),
};

export type MasterOp = 'create' | 'alter' | 'setActive';

export interface MasterChange {
  readonly kind: MasterKind;
  readonly op: MasterOp;
  readonly id: string;
  readonly before?: MasterRecord | undefined;
  readonly after: MasterRecord;
  /** True when a create of an existing identical record was answered without changing anything (a safe retry). */
  readonly replayed: boolean;
}

/** One command's effect on one record, before any follow-on changes (the party → ledgers step adds those). */
interface Prepared {
  readonly change: MasterChange;
  readonly masters: Masters;
}

/**
 * What a master command does. `change` is the record the command named; `changes` is everything that happened, in order — for a party that is
 * the party and then its ledgers, which are created, renamed or (de)activated with it in the same step.
 */
export interface PreparedMaster extends Prepared {
  readonly changes: readonly MasterChange[];
}

interface Ctx {
  readonly masters: Masters;
  readonly usage: MasterUsage;
  readonly op: MasterOp;
  /** The command comes from a party keeping its own ledgers in step (which the ledger rules otherwise reserve to the party). */
  readonly viaParty?: boolean;
}

// ---- field schemas -------------------------------------------------------------------------------

const required = (max = 120) =>
  z
    .string()
    .transform(normalizeName)
    .refine((s) => s.length > 0, 'Required')
    .refine((s) => s.length <= max, `At most ${max} characters`);

const optionalText = (max = 200) =>
  z
    .string()
    .optional()
    .transform((s) => {
      const t = normalizeName(s ?? '');
      return t === '' ? undefined : t;
    })
    .refine((s) => s === undefined || s.length <= max, `At most ${max} characters`);

const optionalCode = () =>
  z
    .string()
    .optional()
    .transform((s) => {
      const t = canonicalId(s ?? '');
      return t === '' ? undefined : t;
    });

const id = () => z.string().min(1, 'Required').max(128);
const optionalId = () =>
  z
    .string()
    .nullish()
    .transform((s) => (s === undefined || s === null || s === '' ? undefined : s));
const nullableId = () =>
  z
    .string()
    .nullish()
    .transform((s) => (s === undefined || s === null || s === '' ? null : s));

/** A whole number typed in a form (string) or supplied by code (number); blank → undefined; junk → NaN (reported by validate). */
const optionalInt = () =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v): number | undefined => {
      if (v === undefined || (typeof v === 'string' && v.trim() === '')) return undefined;
      const n = typeof v === 'number' ? v : Number(v.trim());
      return Number.isInteger(n) ? n : Number.NaN;
    });

const optionalMoney = () =>
  z
    .union([z.literal(''), moneySchema])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : v));

const decimalText = () => z.union([z.string(), z.number()]).transform((v) => String(v).trim());

// ---- definition plumbing -------------------------------------------------------------------------

interface MasterSpec<F, R extends MasterRecord> {
  readonly kind: MasterKind;
  readonly schema: z.ZodType<F>;
  find(m: Masters, id: string): R | undefined;
  /** Rules that need the current data. `existing` is set for alter. */
  validate(f: F, c: Ctx, existing: R | undefined): Issue[];
  build(id: string, f: F, c: Ctx, existing: R | undefined): R;
  put(m: Masters, r: R): Masters;
  isActive(r: R): boolean;
  withActive(r: R, active: boolean): R;
  /** Extra rules for setActive(false). */
  canDeactivate?(r: R, c: Ctx): Issue[];
  /** Records that may never be changed by a user (built-ins). */
  isLocked?(r: R): boolean;
}

interface MasterDef {
  readonly kind: MasterKind;
  parse(data: unknown): Result<unknown>;
  find(m: Masters, id: string): MasterRecord | undefined;
  validate(fields: unknown, c: Ctx, existing: MasterRecord | undefined): Issue[];
  build(id: string, fields: unknown, c: Ctx, existing: MasterRecord | undefined): MasterRecord;
  put(m: Masters, r: MasterRecord): Masters;
  isActive(r: MasterRecord): boolean;
  withActive(r: MasterRecord, active: boolean): MasterRecord;
  canDeactivate(r: MasterRecord, c: Ctx): Issue[];
  isLocked(r: MasterRecord): boolean;
}

function define<F, R extends MasterRecord>(spec: MasterSpec<F, R>): MasterDef {
  return {
    kind: spec.kind,
    parse(data) {
      const parsed = spec.schema.safeParse(data ?? {});
      if (parsed.success) return ok(parsed.data);
      return failWith(
        parsed.error.issues.map((i) => issue(IssueCode.SchemaInvalid, i.message, i.path.map(String).join('.') || undefined)),
      );
    },
    find: (m, recordId) => spec.find(m, recordId),
    validate: (f, c, existing) => spec.validate(f as F, c, existing as R | undefined),
    build: (recordId, f, c, existing) => spec.build(recordId, f as F, c, existing as R | undefined),
    put: (m, r) => spec.put(m, r as R),
    isActive: (r) => spec.isActive(r as R),
    withActive: (r, active) => spec.withActive(r as R, active),
    canDeactivate: (r, c) => spec.canDeactivate?.(r as R, c) ?? [],
    isLocked: (r) => spec.isLocked?.(r as R) ?? false,
  };
}

const replaceOrAppend = <T extends { id: string }>(list: readonly T[], item: T): T[] =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];

/** A name may not be used twice within its pool (case- and spacing-insensitive). */
function nameClash(
  pool: readonly { id: string; name: string }[],
  name: string,
  selfId: string | undefined,
  what: string,
  path = 'name',
): Issue[] {
  const key = nameKey(name);
  const other = pool.find((x) => x.id !== selfId && nameKey(x.name) === key);
  return other ? [issue(IssueCode.NameTaken, `${what} name "${other.name}" is already in use`, path)] : [];
}

function codeClash(
  pool: readonly { id: string; code?: string | undefined }[],
  code: string | undefined,
  selfId: string | undefined,
  what: string,
): Issue[] {
  if (code === undefined) return [];
  const other = pool.find((x) => x.id !== selfId && x.code?.toLowerCase() === code.toLowerCase());
  return other ? [issue(IssueCode.CodeTaken, `${what} code "${code}" is already in use`, 'code')] : [];
}

/** Would making `newParent` the parent of `self` create a loop? */
function createsCycle(self: string, newParent: string | null | undefined, parentOf: (id: string) => string | null | undefined): boolean {
  const seen = new Set<string>();
  let cursor = newParent;
  while (cursor) {
    if (cursor === self || seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = parentOf(cursor);
  }
  return false;
}

const unknownRef = (what: string, path: string): Issue => issue(IssueCode.ReferenceUnknown, `That ${what} does not exist`, path);
const inactiveRef = (what: string, path: string): Issue => issue(IssueCode.ReferenceInactive, `That ${what} is inactive`, path);

// ---- the definitions -----------------------------------------------------------------------------

const groupDef = define({
  kind: 'group',
  schema: z.object({ name: required(), parentId: id() }),
  find: (m, gid) => m.groups.get(gid as GroupId),
  isLocked: (g: AccountGroup) => g.isSystem,
  isActive: (g) => g.isActive !== false,
  withActive: (g, active) => ({ ...g, isActive: active }),
  validate(f, c, existing) {
    const { masters } = c;
    const problems = nameClash(
      [...masters.groups.all, ...masters.ledgers],
      f.name,
      existing?.id,
      'A group or ledger',
    );
    const parent = masters.groups.get(f.parentId as GroupId);
    if (!parent) return [...problems, unknownRef('parent group', 'parentId')];
    if (parent.isActive === false) problems.push(inactiveRef('parent group', 'parentId'));
    if (existing) {
      if (parent.id === existing.id || masters.groups.isWithin(parent.id, existing.id)) {
        problems.push(issue(IssueCode.HierarchyCycle, 'A group cannot be moved inside itself', 'parentId'));
      }
      if (parent.nature !== existing.nature) {
        problems.push(
          issue(IssueCode.NatureLocked, `${existing.name} is ${existing.nature}-type; it can only sit under a ${existing.nature} group`, 'parentId'),
        );
      }
    }
    return problems;
  },
  build: (gid, f, c, existing) => {
    const parent = c.masters.groups.get(f.parentId as GroupId) as AccountGroup;
    return {
      id: gid as GroupId,
      companyId: c.masters.company.id,
      name: f.name,
      parentId: parent.id,
      nature: parent.nature,
      affectsGrossProfit: parent.affectsGrossProfit,
      isSystem: false,
      isActive: existing?.isActive ?? true,
    };
  },
  put(m, g) {
    const groups = GroupTree.buildOrThrow(replaceOrAppend(m.groups.all, g));
    return m.with({ groups });
  },
  canDeactivate(g, c) {
    const kids = c.masters.groups.all.filter((x) => x.parentId === g.id && x.isActive !== false);
    const ledgers = c.masters.ledgers.filter((l) => l.groupId === g.id && l.isActive);
    return kids.length + ledgers.length > 0
      ? [issue(IssueCode.HasDependents, `${g.name} still has ${kids.length} sub-group(s) and ${ledgers.length} ledger(s) in use`)]
      : [];
  },
});

const ledgerDef = define({
  kind: 'ledger',
  schema: z.object({
    name: required(),
    groupId: id(),
    code: optionalCode(),
    alias: optionalText(60),
    partyId: optionalId(),
    partyRole: z.enum(['customer', 'vendor']).optional(),
  }),
  find: (m, lid) => m.ledgers.find((l) => l.id === lid),
  isLocked: (l: Ledger) => l.reservedKey !== undefined,
  isActive: (l) => l.isActive,
  withActive: (l, active) => ({ ...l, isActive: active }),
  canDeactivate: (l, c) =>
    l.partyRole !== undefined && !c.viaParty
      ? [issue(IssueCode.UnsupportedOperation, 'This ledger belongs to a party: deactivate the party instead')]
      : [],
  validate(f, c, existing) {
    const { masters, usage } = c;
    const problems = nameClash([...masters.groups.all, ...masters.ledgers], f.name, existing?.id, 'A group or ledger');
    problems.push(...codeClash(masters.ledgers, f.code, existing?.id, 'Ledger'));
    if (existing?.partyRole !== undefined && !c.viaParty) {
      problems.push(issue(IssueCode.UnsupportedOperation, 'This ledger belongs to a party: alter the party (its name, type and addresses) instead', 'name'));
    }
    if (f.partyRole !== undefined && !c.viaParty) {
      problems.push(issue(IssueCode.UnsupportedOperation, 'A party keeps its own ledgers: create or alter the party', 'partyRole'));
    }
    const group = masters.groups.get(f.groupId as GroupId);
    if (!group) problems.push(unknownRef('group', 'groupId'));
    else {
      if (group.isActive === false) problems.push(inactiveRef('group', 'groupId'));
      if (existing && existing.groupId !== group.id && usage.ledgersWithEntries.has(existing.id)) {
        const was = masters.groups.natureOf(existing.groupId);
        if (was !== group.nature) {
          problems.push(
            issue(IssueCode.NatureLocked, `This ledger already has entries, so it cannot move from a ${was} group to a ${group.nature} group`, 'groupId'),
          );
        }
      }
    }
    if (f.partyId !== undefined) {
      const party = masters.parties.find((p) => p.id === f.partyId);
      if (!party) problems.push(unknownRef('party', 'partyId'));
      else if (!party.isActive) problems.push(inactiveRef('party', 'partyId'));
    }
    return problems;
  },
  build: (lid, f, c, existing) => ({
    id: lid as Ledger['id'],
    companyId: c.masters.company.id,
    name: f.name,
    groupId: f.groupId as GroupId,
    isActive: existing?.isActive ?? true,
    code: f.code,
    alias: f.alias,
    partyId: f.partyId as Ledger['partyId'],
    partyRole: f.partyRole,
    reservedKey: existing?.reservedKey,
  }),
  put: (m, l) => m.with({ ledgers: replaceOrAppend(m.ledgers, l) }),
});

const partyDef = define({
  kind: 'party',
  schema: z.object({
    name: required(),
    gstin: optionalCode(),
    pan: optionalCode(),
    phone: optionalText(20),
    email: optionalText(120),
    address: optionalText(300),
    stateCode: optionalText(2),
    creditDays: optionalInt(),
    creditLimit: optionalMoney(),
    gstRegistration: z.enum(GST_REGISTRATIONS).optional(),
    pincode: optionalText(10),
    country: optionalText(60),
    shipping: z
      .object({ lines: optionalText(300), stateCode: optionalText(2), pincode: optionalText(10), country: optionalText(60) })
      .optional(),
    roles: z.array(z.enum(['customer', 'vendor'])).optional(),
    addresses: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          label: required(60),
          lines: required(400),
          stateCode: optionalText(2),
          country: optionalText(60),
          pincode: optionalText(10),
        }),
      )
      .max(20)
      .optional(),
  }),
  find: (m, pid) => m.parties.find((p) => p.id === pid),
  isActive: (p) => p.isActive,
  withActive: (p, active) => ({ ...p, isActive: active }),
  validate(f, c, existing) {
    const problems = nameClash(c.masters.parties, f.name, existing?.id, 'A party');
    if (f.gstin !== undefined) {
      const p = gstinProblem(f.gstin);
      if (p) problems.push(issue(IssueCode.InvalidGstin, p, 'gstin'));
      else {
        if (f.pan !== undefined && f.pan !== panOfGstin(f.gstin)) {
          problems.push(issue(IssueCode.InvalidPan, `The PAN does not match the one inside the GSTIN (${panOfGstin(f.gstin)})`, 'pan'));
        }
        if (f.stateCode !== undefined && f.stateCode !== stateOfGstin(f.gstin)) {
          problems.push(issue(IssueCode.InvalidGstin, `State code ${f.stateCode} does not match the GSTIN (${stateOfGstin(f.gstin)})`, 'stateCode'));
        }
      }
    }
    if (f.pan !== undefined) {
      const p = panProblem(f.pan);
      if (p) problems.push(issue(IssueCode.InvalidPan, p, 'pan'));
    }
    if (f.phone !== undefined) {
      const p = phoneProblem(f.phone);
      if (p) problems.push(issue(IssueCode.InvalidPhone, p, 'phone'));
    }
    if (f.email !== undefined) {
      const p = emailProblem(f.email);
      if (p) problems.push(issue(IssueCode.InvalidEmail, p, 'email'));
    }
    if (f.creditDays !== undefined && !(f.creditDays >= 0 && f.creditDays <= 3650)) {
      problems.push(issue(IssueCode.OutOfRange, 'Credit days must be a whole number from 0 to 3650', 'creditDays'));
    }
    if (f.creditLimit !== undefined && f.creditLimit < 0n) {
      problems.push(issue(IssueCode.OutOfRange, 'Credit limit cannot be negative', 'creditLimit'));
    }
    if (f.stateCode !== undefined && !GST_STATE_CODES.has(f.stateCode)) problems.push(issue(IssueCode.OutOfRange, 'That is not a GST state code', 'stateCode'));
    for (const [pin, path] of [[f.pincode, 'pincode'], [f.shipping?.pincode, 'shipPincode']] as const) {
      if (pin !== undefined && !/^[1-9][0-9]{5}$/.test(pin)) problems.push(issue(IssueCode.OutOfRange, 'A pincode is six digits', path));
    }
    if (f.shipping?.stateCode !== undefined && !GST_STATE_CODES.has(f.shipping.stateCode)) {
      problems.push(issue(IssueCode.OutOfRange, 'That is not a GST state code', 'shipStateCode'));
    }
    if (f.roles !== undefined) {
      if (f.roles.length === 0) problems.push(issue(IssueCode.SchemaInvalid, 'Choose customer, vendor or both', 'roles'));
      // A role can be added (a customer who becomes a supplier too) but not taken away: the ledger it made may hold entries.
      const lost = (existing?.roles ?? []).filter((r) => !f.roles?.includes(r));
      if (lost.length > 0) problems.push(issue(IssueCode.UnsupportedOperation, `A party cannot stop being a ${lost[0]} once it has been one`, 'roles'));
    }
    const labels = new Set<string>();
    (f.addresses ?? []).forEach((a, i) => {
      if (labels.has(nameKey(a.label))) problems.push(issue(IssueCode.NameTaken, `Two saved addresses are called "${a.label}"`, `addresses.${i}.label`));
      labels.add(nameKey(a.label));
      if (a.stateCode !== undefined && !GST_STATE_CODES.has(a.stateCode)) {
        problems.push(issue(IssueCode.OutOfRange, 'That is not a GST state code', `addresses.${i}.stateCode`));
      }
    });
    return problems;
  },
  build: (pid, f, c, existing) => ({
    id: pid as Party['id'],
    companyId: c.masters.company.id,
    name: f.name,
    gstin: f.gstin,
    pan: f.pan ?? (f.gstin && !gstinProblem(f.gstin) ? panOfGstin(f.gstin) : undefined),
    phone: f.phone,
    email: f.email,
    address: f.address,
    stateCode: f.stateCode ?? (f.gstin && !gstinProblem(f.gstin) ? stateOfGstin(f.gstin) : undefined),
    creditDays: f.creditDays,
    creditLimit: f.creditLimit,
    gstRegistration: f.gstRegistration,
    pincode: f.pincode,
    country: f.country,
    shipping: shippingOf(f.shipping),
    roles: f.roles === undefined ? existing?.roles : [...new Set(f.roles)],
    // Altering the profile from the form never sends the address book; keep what is saved.
    addresses: f.addresses ?? existing?.addresses,
    isActive: existing?.isActive ?? true,
  }),
  put: (m, p) => m.with({ parties: replaceOrAppend(m.parties, p) }),
  // The party's own ledgers are deactivated with it; only a ledger linked by hand (older data) blocks it.
  canDeactivate(p, c) {
    const ledgers = c.masters.ledgers.filter((l) => l.partyId === p.id && l.isActive && l.partyRole === undefined);
    return ledgers.length > 0 ? [issue(IssueCode.HasDependents, `${p.name} still has ${ledgers.length} active ledger(s)`)] : [];
  },
});

const unitDef = define({
  kind: 'unit',
  schema: z.object({ symbol: required(12), name: required(60), decimals: optionalInt(), baseUnitId: optionalId(), factor: decimalText().optional() }),
  find: (m, uid) => m.units.find((u) => u.id === uid),
  isActive: (u) => u.isActive,
  withActive: (u, active) => ({ ...u, isActive: active }),
  validate(f, c, existing) {
    const { masters } = c;
    const problems = nameClash(
      masters.units.map((u) => ({ id: u.id, name: u.symbol })),
      f.symbol,
      existing?.id,
      'A unit symbol',
      'symbol',
    );
    if (f.decimals !== undefined && !(f.decimals >= 0 && f.decimals <= 4)) {
      problems.push(issue(IssueCode.OutOfRange, 'Decimal places must be a whole number from 0 to 4', 'decimals'));
    }
    if (f.baseUnitId !== undefined) {
      const base = masters.units.find((u) => u.id === f.baseUnitId);
      if (!base) problems.push(unknownRef('base unit', 'baseUnitId'));
      else if (existing && createsCycle(existing.id, base.id, (x) => masters.units.find((u) => u.id === x)?.baseUnitId)) {
        problems.push(issue(IssueCode.HierarchyCycle, 'Units cannot be defined in terms of each other in a loop', 'baseUnitId'));
      }
      if (f.factor === undefined || !isDecimalText(f.factor) || Number(f.factor) <= 0) {
        problems.push(issue(IssueCode.OutOfRange, 'Enter how many of the base unit make one of this unit (a number above 0)', 'factor'));
      }
    } else if (f.factor !== undefined && f.factor !== '') {
      problems.push(issue(IssueCode.SchemaInvalid, 'A conversion factor needs a base unit', 'baseUnitId'));
    }
    return problems;
  },
  build: (uid, f, c, existing) => ({
    id: uid as Unit['id'],
    companyId: c.masters.company.id,
    symbol: f.symbol,
    name: f.name,
    decimals: f.decimals ?? 0,
    baseUnitId: f.baseUnitId as Unit['baseUnitId'],
    factor: f.baseUnitId ? f.factor : undefined,
    isActive: existing?.isActive ?? true,
  }),
  put: (m, u) => m.with({ units: replaceOrAppend(m.units, u) }),
  canDeactivate(u, c) {
    const dependents = [
      ...c.masters.stockItems.filter((i) => i.unitId === u.id && i.isActive),
      ...c.masters.units.filter((x) => x.baseUnitId === u.id && x.isActive),
    ];
    return dependents.length > 0 ? [issue(IssueCode.HasDependents, `${u.symbol} is still used by ${dependents.length} active item(s) or unit(s)`)] : [];
  },
});

const stockGroupDef = define({
  kind: 'stockGroup',
  schema: z.object({ name: required(), parentId: nullableId() }),
  find: (m, sid) => m.stockGroups.find((g) => g.id === sid),
  isActive: (g) => g.isActive,
  withActive: (g, active) => ({ ...g, isActive: active }),
  validate(f, c, existing) {
    const { masters } = c;
    const problems = nameClash(masters.stockGroups, f.name, existing?.id, 'A stock group');
    if (f.parentId !== null) {
      const parent = masters.stockGroups.find((g) => g.id === f.parentId);
      if (!parent) problems.push(unknownRef('parent group', 'parentId'));
      else if (existing && createsCycle(existing.id, parent.id, (x) => masters.stockGroups.find((g) => g.id === x)?.parentId)) {
        problems.push(issue(IssueCode.HierarchyCycle, 'A group cannot be moved inside itself', 'parentId'));
      }
    }
    return problems;
  },
  build: (sid, f, c, existing) => ({
    id: sid as StockGroup['id'],
    companyId: c.masters.company.id,
    name: f.name,
    parentId: f.parentId as StockGroup['parentId'],
    isActive: existing?.isActive ?? true,
  }),
  put: (m, g) => m.with({ stockGroups: replaceOrAppend(m.stockGroups, g) }),
  canDeactivate(g, c) {
    const dependents = [
      ...c.masters.stockGroups.filter((x) => x.parentId === g.id && x.isActive),
      ...c.masters.stockItems.filter((i) => i.groupId === g.id && i.isActive),
    ];
    return dependents.length > 0 ? [issue(IssueCode.HasDependents, `${g.name} still contains ${dependents.length} active group(s) or item(s)`)] : [];
  },
});

const stockItemDef = define({
  kind: 'stockItem',
  schema: z.object({
    name: required(),
    code: optionalCode(),
    alias: optionalText(60),
    groupId: nullableId(),
    unitId: id(),
    hsn: optionalCode(),
    gstRateId: nullableId(),
    itemType: z.enum(ITEM_TYPES as [string, ...string[]]),
  }),
  find: (m, iid) => m.stockItems.find((i) => i.id === iid),
  isActive: (i) => i.isActive,
  withActive: (i, active) => ({ ...i, isActive: active }),
  validate(f, c, existing) {
    const { masters } = c;
    const problems = nameClash(masters.stockItems, f.name, existing?.id, 'A stock item');
    problems.push(...codeClash(masters.stockItems, f.code, existing?.id, 'Item'));
    const unit = masters.units.find((u) => u.id === f.unitId);
    if (!unit) problems.push(unknownRef('unit', 'unitId'));
    else if (!unit.isActive) problems.push(inactiveRef('unit', 'unitId'));
    if (f.groupId !== null && !masters.stockGroups.some((g) => g.id === f.groupId)) problems.push(unknownRef('stock group', 'groupId'));
    if (f.gstRateId !== null && !masters.gstRates.some((r) => r.id === f.gstRateId)) problems.push(unknownRef('GST rate', 'gstRateId'));
    if (f.hsn !== undefined) {
      const p = hsnProblem(f.hsn);
      if (p) problems.push(issue(IssueCode.InvalidHsn, p, 'hsn'));
    }
    return problems;
  },
  build: (iid, f, c, existing) => ({
    id: iid as StockItem['id'],
    companyId: c.masters.company.id,
    name: f.name,
    code: f.code,
    alias: f.alias,
    groupId: f.groupId as StockItem['groupId'],
    unitId: f.unitId as StockItem['unitId'],
    hsn: f.hsn,
    gstRateId: f.gstRateId as StockItem['gstRateId'],
    itemType: f.itemType as StockItem['itemType'],
    isActive: existing?.isActive ?? true,
  }),
  put: (m, i) => m.with({ stockItems: replaceOrAppend(m.stockItems, i) }),
});

const warehouseDef = define({
  kind: 'warehouse',
  schema: z.object({ name: required(), parentId: nullableId() }),
  find: (m, wid) => m.warehouses.find((w) => w.id === wid),
  isActive: (w) => w.isActive,
  withActive: (w, active) => ({ ...w, isActive: active }),
  validate(f, c, existing) {
    const { masters } = c;
    const problems = nameClash(masters.warehouses, f.name, existing?.id, 'A warehouse');
    if (f.parentId !== null) {
      const parent = masters.warehouses.find((w) => w.id === f.parentId);
      if (!parent) problems.push(unknownRef('parent warehouse', 'parentId'));
      else if (existing && createsCycle(existing.id, parent.id, (x) => masters.warehouses.find((w) => w.id === x)?.parentId)) {
        problems.push(issue(IssueCode.HierarchyCycle, 'A warehouse cannot be placed inside itself', 'parentId'));
      }
    }
    return problems;
  },
  build: (wid, f, c, existing) => ({
    id: wid as Warehouse['id'],
    companyId: c.masters.company.id,
    name: f.name,
    parentId: f.parentId as Warehouse['parentId'],
    isActive: existing?.isActive ?? true,
  }),
  put: (m, w) => m.with({ warehouses: replaceOrAppend(m.warehouses, w) }),
  canDeactivate(w, c) {
    const kids = c.masters.warehouses.filter((x) => x.parentId === w.id && x.isActive);
    return kids.length > 0 ? [issue(IssueCode.HasDependents, `${w.name} still contains ${kids.length} active warehouse(s)`)] : [];
  },
});

const percentProblem = (text: string, path: string): Issue[] =>
  isDecimalText(text) && Number(text) <= 100 ? [] : [issue(IssueCode.OutOfRange, 'Enter a percentage from 0 to 100', path)];

const gstRateDef = define({
  kind: 'gstRate',
  schema: z.object({ name: required(60), ratePercent: decimalText(), cessPercent: decimalText().optional(), effectiveFrom: z.string() }),
  find: (m, rid) => m.gstRates.find((r) => r.id === rid),
  isActive: () => true,
  withActive: (r) => r,
  validate(f, c, existing) {
    const problems = nameClash(c.masters.gstRates, f.name, existing?.id, 'A GST rate');
    problems.push(...percentProblem(f.ratePercent, 'ratePercent'));
    problems.push(...percentProblem(f.cessPercent ?? '0', 'cessPercent'));
    if (parseLocalDate(f.effectiveFrom) === undefined) problems.push(issue(IssueCode.SchemaInvalid, 'Enter a valid date (YYYY-MM-DD)', 'effectiveFrom'));
    return problems;
  },
  build: (rid, f, c) => ({
    id: rid as GstRate['id'],
    companyId: c.masters.company.id,
    name: f.name,
    ratePercent: f.ratePercent,
    cessPercent: f.cessPercent ?? '0',
    effectiveFrom: f.effectiveFrom as GstRate['effectiveFrom'],
  }),
  put: (m, r) => m.with({ gstRates: replaceOrAppend(m.gstRates, r) }),
  canDeactivate: () => [issue(IssueCode.UnsupportedOperation, 'A GST rate cannot be deactivated; add a new dated rate instead')],
});

const voucherTypeDef = define({
  kind: 'voucherType',
  schema: z.object({ name: required(60), baseKind: z.string() }),
  find: (m, vid) => m.voucherTypes.find((t) => t.id === vid),
  isLocked: (t: VoucherType) => t.isSystem === true,
  isActive: (t) => t.isActive !== false,
  withActive: (t, active) => ({ ...t, isActive: active }),
  validate(f, c, existing) {
    const problems = nameClash(c.masters.voucherTypes, f.name, existing?.id, 'A voucher type');
    if (!(USER_BASE_KINDS as readonly string[]).includes(f.baseKind)) {
      problems.push(issue(IssueCode.OutOfRange, `Choose one of: ${USER_BASE_KINDS.join(', ')}`, 'baseKind'));
    }
    if (existing && existing.baseKind !== f.baseKind && c.usage.voucherTypesInUse.has(existing.id)) {
      problems.push(issue(IssueCode.InUse, 'Vouchers already use this type, so its base kind cannot change', 'baseKind'));
    }
    return problems;
  },
  build: (vid, f, c, existing) => ({
    id: vid as VoucherType['id'],
    companyId: c.masters.company.id,
    name: f.name,
    baseKind: f.baseKind as BaseKind,
    isSystem: false,
    isActive: existing?.isActive ?? true,
  }),
  put: (m, t) => m.with({ voucherTypes: replaceOrAppend(m.voucherTypes, t) }),
});

const seriesDef = define({
  kind: 'numberingSeries',
  schema: z.object({
    voucherTypeId: id(),
    financialYearId: id(),
    prefix: optionalText(20),
    suffix: optionalText(20),
    width: optionalInt(),
    startAt: optionalInt(),
  }),
  find: (m, sid) => m.series.find((s) => s.id === sid),
  isActive: () => true,
  withActive: (s) => s,
  validate(f, c, existing) {
    const { masters, usage } = c;
    const problems: Issue[] = [];
    if (!masters.voucherTypes.some((t) => t.id === f.voucherTypeId)) problems.push(unknownRef('voucher type', 'voucherTypeId'));
    if (!masters.financialYears.some((y) => y.id === f.financialYearId)) problems.push(unknownRef('financial year', 'financialYearId'));
    const dup = masters.series.find(
      (s) => s.id !== existing?.id && s.voucherTypeId === f.voucherTypeId && s.financialYearId === f.financialYearId,
    );
    if (dup) problems.push(issue(IssueCode.NameTaken, 'That voucher type already has a numbering series for that financial year', 'voucherTypeId'));
    const width = f.width ?? 4;
    if (!(width >= 1 && width <= 12)) problems.push(issue(IssueCode.OutOfRange, 'Width must be a whole number from 1 to 12', 'width'));
    const startAt = f.startAt ?? 1;
    if (!(startAt >= 1)) problems.push(issue(IssueCode.OutOfRange, 'Start number must be 1 or more', 'startAt'));
    if (existing && usage.seriesInUse.has(existing.id) && (existing.startAt !== startAt || existing.voucherTypeId !== f.voucherTypeId || existing.financialYearId !== f.financialYearId)) {
      problems.push(issue(IssueCode.InUse, 'Vouchers already use this series: only the prefix, suffix and width can change', 'startAt'));
    }
    return problems;
  },
  build: (sid, f, c) => ({
    id: sid as NumberingSeries['id'],
    companyId: c.masters.company.id,
    voucherTypeId: f.voucherTypeId as NumberingSeries['voucherTypeId'],
    financialYearId: f.financialYearId as NumberingSeries['financialYearId'],
    prefix: f.prefix ?? '',
    suffix: f.suffix ?? '',
    width: f.width ?? 4,
    startAt: f.startAt ?? 1,
  }),
  put: (m, s) => m.with({ series: replaceOrAppend(m.series, s) }),
});

const companyDef = define({
  kind: 'company',
  schema: z.object({ name: required(), gstin: optionalCode(), stateCode: optionalText(2), address: optionalText(300), chargeGst: z.union([z.boolean(), z.enum(['yes', 'no'])]).optional().transform((v) => (v === undefined ? undefined : v === true || v === 'yes')) }),
  find: (m, cid) => (m.company.id === cid ? m.company : undefined),
  isActive: () => true,
  withActive: (r) => r,
  validate(f) {
    const problems: Issue[] = [];
    if (f.gstin !== undefined) {
      const p = gstinProblem(f.gstin);
      if (p) problems.push(issue(IssueCode.InvalidGstin, p, 'gstin'));
      else if (f.stateCode !== undefined && f.stateCode !== stateOfGstin(f.gstin)) {
        problems.push(issue(IssueCode.InvalidGstin, `State code ${f.stateCode} does not match the GSTIN (${stateOfGstin(f.gstin)})`, 'stateCode'));
      }
    }
    if (f.chargeGst === true && !f.gstin) problems.push(issue(IssueCode.InvalidGstin, 'Enter the company’s GSTIN before switching GST on', 'chargeGst'));
    return problems;
  },
  build: (cid, f) => ({
    id: cid as Company['id'],
    name: f.name,
    gstin: f.gstin,
    stateCode: f.stateCode ?? (f.gstin && !gstinProblem(f.gstin) ? stateOfGstin(f.gstin) : undefined),
    address: f.address,
    chargeGst: f.chargeGst === true ? true : undefined,
  }),
  put: (m, company) => m.with({ company }),
});

const DEFS: Readonly<Record<MasterKind, MasterDef>> = {
  group: groupDef,
  ledger: ledgerDef,
  party: partyDef,
  unit: unitDef,
  stockGroup: stockGroupDef,
  stockItem: stockItemDef,
  warehouse: warehouseDef,
  gstRate: gstRateDef,
  voucherType: voucherTypeDef,
  numberingSeries: seriesDef,
  company: companyDef,
};

// ---- the engine ----------------------------------------------------------------------------------

const envelope = z.object({
  op: z.enum(['create', 'alter', 'setActive']),
  kind: z.enum(MASTER_KINDS as [MasterKind, ...MasterKind[]]),
  id: z.string().min(1).max(128),
  data: z.unknown().optional(),
  active: z.boolean().optional(),
});

/** The plain-JSON form of a record (money as decimal strings, undefined dropped) — for the wire and for equality. */
export const masterRecordToJson = (record: MasterRecord): Record<string, unknown> => draftToJson(record) as Record<string, unknown>;

export function masterRecordName(r: MasterRecord): string {
  if ('symbol' in r) return r.symbol; // a unit is identified by its symbol
  if ('name' in r) return r.name;
  return `${r.prefix}…`; // a numbering series
}

/**
 * Validate a master command against the current data.
 *   envelope → definition → (create | alter | setActive) → field parse → rules → record → next snapshot
 * A `create` of an id that already exists with identical content is a safe replay (no change); with different
 * content it is refused.
 */
function prepareOne(input: unknown, masters: Masters, usage: MasterUsage, viaParty: boolean): Result<Prepared> {
  const parsedEnvelope = envelope.safeParse(input);
  if (!parsedEnvelope.success) {
    return failWith(
      parsedEnvelope.error.issues.map((i) => issue(IssueCode.SchemaInvalid, i.message, i.path.map(String).join('.') || undefined)),
    );
  }
  const { op, kind, id: recordId, data, active } = parsedEnvelope.data;
  const def = DEFS[kind];
  const ctx: Ctx = { masters, usage, op, viaParty };
  const existing = def.find(masters, recordId);

  if (kind === 'company' && op === 'create') {
    return fail(issue(IssueCode.UnsupportedOperation, 'A company is created by onboarding, not as a master'));
  }

  if (op === 'setActive') {
    if (existing === undefined) return fail(issue(IssueCode.MasterNotFound, `No ${MASTER_LABELS[kind]} with that id`));
    if (def.isLocked(existing)) return fail(issue(IssueCode.SystemMasterLocked, `${masterRecordName(existing)} is built in and cannot be changed`));
    const want = active ?? false;
    if (def.isActive(existing) === want) {
      return ok({ change: { kind, op, id: recordId, before: existing, after: existing, replayed: true }, masters });
    }
    if (!want) {
      const problems = def.canDeactivate(existing, ctx);
      if (problems.length > 0) return failWith(problems);
    }
    const after = def.withActive(existing, want);
    return ok({ change: { kind, op, id: recordId, before: existing, after, replayed: false }, masters: def.put(masters, after) });
  }

  if (op === 'alter' && existing === undefined) {
    return fail(issue(IssueCode.MasterNotFound, `No ${MASTER_LABELS[kind]} with that id`));
  }
  if (op === 'alter' && existing !== undefined && def.isLocked(existing)) {
    return fail(issue(IssueCode.SystemMasterLocked, `${masterRecordName(existing)} is built in and cannot be changed`));
  }

  const fields = def.parse(data);
  if (!fields.ok) return fields;

  // create of an existing id: replay if identical, otherwise refuse
  if (op === 'create' && existing !== undefined) {
    const rebuilt = def.build(recordId, fields.value, ctx, existing);
    if (jsonEqual(masterRecordToJson(rebuilt), masterRecordToJson(existing))) {
      return ok({ change: { kind, op, id: recordId, after: existing, replayed: true }, masters });
    }
    return fail(issue(IssueCode.MasterIdExists, `That id is already used by "${masterRecordName(existing)}"`, 'id'));
  }

  const problems = def.validate(fields.value, ctx, existing);
  if (problems.length > 0) return failWith(problems);

  const after = def.build(recordId, fields.value, ctx, existing);
  if (op === 'alter' && existing !== undefined && jsonEqual(masterRecordToJson(after), masterRecordToJson(existing))) {
    return ok({ change: { kind, op, id: recordId, before: existing, after: existing, replayed: true }, masters });
  }
  return ok({
    change: { kind, op, id: recordId, before: existing, after, replayed: false },
    masters: def.put(masters, after),
  });
}

/** The name a party's ledger carries: the party's own name, except the vendor side of a party that is both. */
const partyLedgerName = (party: Party, role: PartyRole): string =>
  role === 'vendor' && (party.roles ?? []).includes('customer') ? `${party.name} (Vendor)` : party.name;

const partyLedgerGroup = (masters: Masters, role: PartyRole): AccountGroup | undefined =>
  masters.groups.all.find((g) => g.reservedKey === (role === 'customer' ? 'sundry-debtors' : 'sundry-creditors'));

/**
 * A party keeps its ledgers in step: one under Sundry Debtors for a customer, one under Sundry Creditors for a vendor, both for both.
 * They are created, renamed and (de)activated with the party in the same step, so the party and its ledgers can never disagree. A party
 * with no `roles` (older data, linked by hand) has no automatic ledgers.
 */
function withPartyLedgers(first: Prepared, usage: MasterUsage): Result<PreparedMaster> {
  const changes: MasterChange[] = [first.change];
  let masters = first.masters;
  const done = (): Result<PreparedMaster> => ok({ change: first.change, changes, masters });
  const party = first.change.after as Party;
  if (first.change.replayed) return done();

  const step = (command: Record<string, unknown>): Result<Prepared> => {
    const r = prepareOne(command, masters, usage, true);
    if (!r.ok) return failWith(r.issues.map((i) => issue(i.code, i.message, i.path === undefined || i.path === 'name' ? 'name' : undefined)));
    if (!r.value.change.replayed) {
      changes.push(r.value.change);
      masters = r.value.masters;
    }
    return r;
  };

  if (first.change.op === 'setActive') {
    for (const l of masters.ledgers.filter((x) => x.partyId === party.id && x.partyRole !== undefined && x.isActive !== party.isActive)) {
      const r = step({ op: 'setActive', kind: 'ledger', id: l.id, active: party.isActive });
      if (!r.ok) return r;
    }
    return done();
  }

  const roles = party.roles ?? [];
  const wanted = roles.map((role) => ({ role, id: partyLedgerId(party.id, role), name: partyLedgerName(party, role) }));
  // Renames first: a vendor who becomes a customer too hands its plain name to the new customer ledger.
  for (const w of wanted) {
    const have = masters.ledgers.find((l) => l.id === w.id);
    if (!have) continue;
    const r = step({ op: 'alter', kind: 'ledger', id: w.id, data: { name: w.name, groupId: have.groupId, code: have.code, alias: have.alias, partyId: party.id, partyRole: w.role } });
    if (!r.ok) return r;
  }
  for (const w of wanted) {
    if (masters.ledgers.some((l) => l.id === w.id)) continue;
    const group = partyLedgerGroup(masters, w.role);
    if (!group) return fail(issue(IssueCode.ReferenceUnknown, `The ${w.role === 'customer' ? 'Sundry Debtors' : 'Sundry Creditors'} group is missing`, 'roles'));
    const r = step({ op: 'create', kind: 'ledger', id: w.id, data: { name: w.name, groupId: group.id, partyId: party.id, partyRole: w.role } });
    if (!r.ok) return r;
  }
  return done();
}

/**
 * Validate a master command against the current data.
 *   envelope → definition → (create | alter | setActive) → field parse → rules → record → next snapshot
 * A `create` of an id that already exists with identical content is a safe replay (no change); with different
 * content it is refused. A party also brings its ledgers (see `withPartyLedgers`): `changes` lists everything, in order.
 */
export function prepareMasterCommand(input: unknown, masters: Masters, usage: MasterUsage = NO_USAGE): Result<PreparedMaster> {
  const first = prepareOne(input, masters, usage, false);
  if (!first.ok) return first;
  if (first.value.change.kind !== 'party') return ok({ ...first.value, changes: [first.value.change] });
  return withPartyLedgers(first.value, usage);
}

/** Looks up any master by kind and id. */
export function findMaster(masters: Masters, kind: MasterKind, recordId: string): MasterRecord | undefined {
  return DEFS[kind].find(masters, recordId);
}

export function isMasterActive(kind: MasterKind, record: MasterRecord): boolean {
  return DEFS[kind].isActive(record);
}

/** Every record of one kind, for list screens. */
export function listMasters(masters: Masters, kind: MasterKind): readonly MasterRecord[] {
  switch (kind) {
    case 'group':
      return masters.groups.all;
    case 'ledger':
      return masters.ledgers;
    case 'party':
      return masters.parties;
    case 'unit':
      return masters.units;
    case 'stockGroup':
      return masters.stockGroups;
    case 'stockItem':
      return masters.stockItems;
    case 'warehouse':
      return masters.warehouses;
    case 'gstRate':
      return masters.gstRates;
    case 'voucherType':
      return masters.voucherTypes;
    case 'numberingSeries':
      return masters.series;
    case 'company':
      return [masters.company];
  }
}

/** A party as the data of an `alter` command (used to change one part of a party — say, add a saved address — without restating the rest). */
export function partyToData(p: Party): Record<string, unknown> {
  return {
    name: p.name,
    gstin: p.gstin,
    pan: p.pan,
    phone: p.phone,
    email: p.email,
    address: p.address,
    stateCode: p.stateCode,
    creditDays: p.creditDays,
    creditLimit: p.creditLimit === undefined ? undefined : formatMoney(p.creditLimit),
    gstRegistration: p.gstRegistration,
    pincode: p.pincode,
    country: p.country,
    shipping: p.shipping,
    roles: p.roles,
    addresses: p.addresses,
  };
}

const shippingOf = (s: { lines?: string | undefined; stateCode?: string | undefined; pincode?: string | undefined; country?: string | undefined } | undefined) =>
  s === undefined || (s.lines === undefined && s.stateCode === undefined && s.pincode === undefined && s.country === undefined)
    ? undefined
    : { lines: s.lines, stateCode: s.stateCode, pincode: s.pincode, country: s.country };

/** The records a command made besides the one it named (a party's ledgers), for the caller to act on. */
export function createdRecords(changes: readonly MasterChange[]): { kind: MasterKind; id: string; name: string }[] {
  return changes
    .slice(1)
    .filter((c) => c.op === 'create' && !c.replayed)
    .map((c) => ({ kind: c.kind, id: c.id, name: masterRecordName(c.after) }));
}
