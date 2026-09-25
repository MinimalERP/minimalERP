import { type MailKind, type MailTemplate, type MailTemplates, isMailKind } from './mailTemplates';
import { type CompanyId, asCompanyId, asFinancialYearId, asGroupId, asGstRateId, asLedgerId, asPartyId, asSeriesId, asStockGroupId, asStockItemId, asUnitId, asVoucherTypeId, asWarehouseId } from '../ids';
import { type FinancialYear, localDate } from '../dates';
import { parseMoney } from '../money';
import { type AccountGroup, type Nature, type ReservedGroupKey, GroupTree } from './groups';
import { type BaseKind, type Ledger, type NumberingSeries, type VoucherType, Masters } from './masters';
import type { GstRate, ItemType, Party, PartyRole, StockGroup, StockItem, Unit, Warehouse } from './records';

/**
 * The masters of a company as the database (or the Edge Function that reads it) hands them over: the JSON `load_masters_json` and
 * `load_ledgers_json` return, turned back into the immutable Masters snapshot. It lives in the domain because both sides need it — the server
 * to post against the masters, the browser to show them — and it knows nothing about either.
 */

type Json = Record<string, unknown>;

const obj = (v: unknown, what: string): Json => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`Expected ${what} to be an object`);
  return v as Json;
};
const arr = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`Expected ${what} to be an array`);
  return v;
};
const str = (o: Json, k: string): string => {
  const v = o[k];
  if (typeof v !== 'string') throw new Error(`Expected "${k}" to be a string, got ${JSON.stringify(v)}`);
  return v;
};
/** The stored templates, keeping only kinds and texts that make sense (a stored value is never trusted to be well formed). */
const mailTemplatesOf = (v: unknown): MailTemplates | undefined => {
  if (v === null || typeof v !== 'object') return undefined;
  const out: Partial<Record<MailKind, MailTemplate>> = {};
  for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
    if (!isMailKind(k) || t === null || typeof t !== 'object') continue;
    const { subject, body } = t as { subject?: unknown; body?: unknown };
    out[k] = { subject: typeof subject === 'string' ? subject : '', body: typeof body === 'string' ? body : '' };
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const optStr = (o: Json, k: string): string | undefined => {
  const v = o[k];
  return typeof v === 'string' ? v : undefined;
};
const num = (o: Json, k: string): number => {
  const v = o[k];
  if (typeof v !== 'number') throw new Error(`Expected "${k}" to be a number, got ${JSON.stringify(v)}`);
  return v;
};
const bool = (o: Json, k: string): boolean => o[k] === true;

/** The optional lists: a database that predates a table simply has none of them. */
function list(core: Json, key: string): unknown[] {
  const v = core[key];
  return v === undefined ? [] : arr(v, key);
}

export function ledgersFromJson(rows: unknown, companyId: CompanyId): Ledger[] {
  return arr(rows, 'ledgers').map((l) => {
    const o = obj(l, 'ledger');
    const party = optStr(o, 'party_id');
    return {
      id: asLedgerId(str(o, 'id')),
      companyId,
      name: str(o, 'name'),
      groupId: asGroupId(str(o, 'group_id')),
      isActive: bool(o, 'is_active'),
      code: optStr(o, 'code'),
      alias: optStr(o, 'alias'),
      partyId: party === undefined ? undefined : asPartyId(party),
      partyRole: optStr(o, 'party_role') as Ledger['partyRole'],
      reservedKey: optStr(o, 'reserved_key') as Ledger['reservedKey'],
    };
  });
}

/** Builds the domain's immutable Masters snapshot from the JSON that `load_masters_json` / `load_ledgers_json` return. */
export function buildMasters(core: unknown, ledgerRows: unknown): Masters {
  const c = obj(core, 'masters');
  const company = obj(c['company'], 'company');
  const companyId = asCompanyId(str(company, 'id'));

  const groups: AccountGroup[] = arr(c['groups'], 'groups').map((g) => {
    const o = obj(g, 'group');
    const parent = optStr(o, 'parent_id');
    const key = optStr(o, 'reserved_key');
    return {
      id: asGroupId(str(o, 'id')),
      companyId,
      name: str(o, 'name'),
      parentId: parent === undefined ? null : asGroupId(parent),
      nature: str(o, 'nature') as Nature,
      affectsGrossProfit: bool(o, 'affects_gross_profit'),
      isSystem: bool(o, 'is_system'),
      reservedKey: key as ReservedGroupKey | undefined,
      isActive: o['is_active'] !== false,
    };
  });
  const tree = GroupTree.build(groups);
  if (!tree.ok) throw new Error(`Corrupt chart of accounts: ${tree.issues.map((i) => i.message).join('; ')}`);

  const voucherTypes: VoucherType[] = arr(c['voucher_types'], 'voucher_types').map((t) => {
    const o = obj(t, 'voucher type');
    return {
      id: asVoucherTypeId(str(o, 'id')),
      companyId,
      name: str(o, 'name'),
      baseKind: str(o, 'base_kind') as BaseKind,
      isSystem: o['is_system'] === true,
      isActive: o['is_active'] !== false,
    };
  });

  const series: NumberingSeries[] = arr(c['series'], 'series').map((s) => {
    const o = obj(s, 'series');
    return {
      id: asSeriesId(str(o, 'id')),
      companyId,
      voucherTypeId: asVoucherTypeId(str(o, 'voucher_type_id')),
      financialYearId: asFinancialYearId(str(o, 'financial_year_id')),
      prefix: str(o, 'prefix'),
      suffix: str(o, 'suffix'),
      width: num(o, 'width'),
      startAt: num(o, 'start_at'),
    };
  });

  const financialYears: FinancialYear[] = arr(c['financial_years'], 'financial_years').map((f) => {
    const o = obj(f, 'financial year');
    const locked = optStr(o, 'locked_through');
    return {
      id: asFinancialYearId(str(o, 'id')),
      companyId,
      label: str(o, 'label'),
      start: localDate(str(o, 'start_date')),
      end: localDate(str(o, 'end_date')),
      lockedThrough: locked === undefined ? undefined : localDate(locked),
    };
  });

  const ledgers = ledgersFromJson(ledgerRows, companyId);

  const parties: Party[] = list(c, 'parties').map((p) => {
    const o = obj(p, 'party');
    const limit = optStr(o, 'credit_limit');
    return {
      id: asPartyId(str(o, 'id')),
      companyId,
      name: str(o, 'name'),
      gstin: optStr(o, 'gstin'),
      pan: optStr(o, 'pan'),
      phone: optStr(o, 'phone'),
      email: optStr(o, 'email'),
      address: optStr(o, 'address'),
      stateCode: optStr(o, 'state_code'),
      creditDays: typeof o['credit_days'] === 'number' ? o['credit_days'] : undefined,
      creditLimit: limit === undefined ? undefined : parseMoney(limit),
      gstRegistration: optStr(o, 'gst_registration') as Party['gstRegistration'],
      addresses: partyAddressesFromJson(o['addresses']),
      pincode: optStr(o, 'pincode'),
      country: optStr(o, 'country'),
      shipping: partyShippingFromJson(o['shipping']),
      roles: partyRolesFromJson(o['roles']),
      isActive: bool(o, 'is_active'),
    };
  });

  const units: Unit[] = list(c, 'units').map((u) => {
    const o = obj(u, 'unit');
    const base = optStr(o, 'base_unit_id');
    return {
      id: asUnitId(str(o, 'id')),
      companyId,
      symbol: str(o, 'symbol'),
      name: str(o, 'name'),
      decimals: num(o, 'decimals'),
      baseUnitId: base === undefined ? undefined : asUnitId(base),
      factor: optStr(o, 'factor'),
      isActive: bool(o, 'is_active'),
    };
  });

  const stockGroups: StockGroup[] = list(c, 'stock_groups').map((g) => {
    const o = obj(g, 'stock group');
    const parent = optStr(o, 'parent_id');
    return {
      id: asStockGroupId(str(o, 'id')),
      companyId,
      name: str(o, 'name'),
      parentId: parent === undefined ? null : asStockGroupId(parent),
      isActive: bool(o, 'is_active'),
    };
  });

  const stockItems: StockItem[] = list(c, 'stock_items').map((i) => {
    const o = obj(i, 'stock item');
    const group = optStr(o, 'group_id');
    const rate = optStr(o, 'gst_rate_id');
    return {
      id: asStockItemId(str(o, 'id')),
      companyId,
      name: str(o, 'name'),
      code: optStr(o, 'code'),
      alias: optStr(o, 'alias'),
      groupId: group === undefined ? null : asStockGroupId(group),
      unitId: asUnitId(str(o, 'unit_id')),
      hsn: optStr(o, 'hsn'),
      gstRateId: rate === undefined ? null : asGstRateId(rate),
      itemType: str(o, 'item_type') as ItemType,
      isActive: bool(o, 'is_active'),
    };
  });

  const warehouses: Warehouse[] = list(c, 'warehouses').map((w) => {
    const o = obj(w, 'warehouse');
    const parent = optStr(o, 'parent_id');
    return {
      id: asWarehouseId(str(o, 'id')),
      companyId,
      name: str(o, 'name'),
      parentId: parent === undefined ? null : asWarehouseId(parent),
      isActive: bool(o, 'is_active'),
    };
  });

  const gstRates: GstRate[] = list(c, 'gst_rates').map((r) => {
    const o = obj(r, 'gst rate');
    return {
      id: asGstRateId(str(o, 'id')),
      companyId,
      name: str(o, 'name'),
      ratePercent: str(o, 'rate_percent'),
      cessPercent: str(o, 'cess_percent'),
      effectiveFrom: localDate(str(o, 'effective_from')),
    };
  });

  return new Masters({
    company: {
      id: companyId,
      name: str(company, 'name'),
      gstin: optStr(company, 'gstin'),
      stateCode: optStr(company, 'state_code'),
      address: optStr(company, 'address'),
      chargeGst: company['charge_gst'] === true ? true : undefined,
      phone: optStr(company, 'phone'),
      email: optStr(company, 'email'),
      bankName: optStr(company, 'bank_name'),
      bankAccountNo: optStr(company, 'bank_account_no'),
      bankIfsc: optStr(company, 'bank_ifsc'),
      bankBranch: optStr(company, 'bank_branch'),
      invoiceNote: optStr(company, 'invoice_note'),
      invoiceTerms: optStr(company, 'invoice_terms'),
      emailTemplates: mailTemplatesOf(company['email_templates']),
    },
    groups: tree.value,
    ledgers,
    voucherTypes,
    series,
    financialYears,
    parties,
    units,
    stockGroups,
    stockItems,
    warehouses,
    gstRates,
  });
}

/** A party's saved addresses, as stored (an empty book reads back as none, the way the in-memory backend holds it). */
function partyAddressesFromJson(value: unknown): Party['addresses'] {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((raw) => {
    const a = obj(raw, 'party address');
    return { id: str(a, 'id'), label: str(a, 'label'), lines: str(a, 'lines'), stateCode: optStr(a, 'stateCode'), country: optStr(a, 'country'), pincode: optStr(a, 'pincode') };
  });
}

/** A party's ship-to address; absent means "same as billing". */
function partyShippingFromJson(value: unknown): Party['shipping'] {
  if (value === null || value === undefined || typeof value !== 'object') return undefined;
  const s = obj(value, 'party shipping');
  return { lines: optStr(s, 'lines'), stateCode: optStr(s, 'stateCode'), pincode: optStr(s, 'pincode'), country: optStr(s, 'country') };
}

/** Customer / vendor; a party made before roles existed has none. */
function partyRolesFromJson(value: unknown): Party['roles'] {
  if (!Array.isArray(value)) return undefined;
  const roles = value.filter((r): r is PartyRole => r === 'customer' || r === 'vendor');
  return roles.length === 0 ? undefined : roles;
}

/** The version of the masters a snapshot was loaded at; master changes are validated against it (see master_apply). */
export function mastersVersion(core: unknown): number {
  const v = obj(core, 'masters')['version'];
  return typeof v === 'number' ? v : Number(v ?? 0);
}
