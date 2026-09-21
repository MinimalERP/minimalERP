import {
  type AccountGroup,
  type BaseKind,
  type CompanyId,
  type FinancialYear,
  type GstRate,
  type ItemType,
  type Ledger,
  type MasterKind,
  type MasterRecord,
  type NumberingSeries,
  type Nature,
  type Party,
  type PartyRole,
  type ReservedGroupKey,
  type StockGroup,
  type StockItem,
  type Unit,
  type VoucherType,
  type Warehouse,
  GroupTree,
  Masters,
  asCompanyId,
  asFinancialYearId,
  asGroupId,
  asGstRateId,
  asLedgerId,
  asPartyId,
  asSeriesId,
  asStockGroupId,
  asStockItemId,
  asUnitId,
  asVoucherTypeId,
  asWarehouseId,
  formatMoney,
  localDate,
  parseMoney,
} from '@minimalerp/domain';

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

// ---- master records as table rows (what master_apply and company_seed write) ----

type Row = Record<string, unknown>;
const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** The table each kind lives in. */
export const MASTER_TABLES: Readonly<Record<MasterKind, string>> = {
  group: 'account_groups',
  ledger: 'ledgers',
  party: 'parties',
  unit: 'units',
  stockGroup: 'stock_groups',
  stockItem: 'stock_items',
  warehouse: 'warehouses',
  gstRate: 'gst_rates',
  voucherType: 'voucher_types',
  numberingSeries: 'numbering_series',
  company: 'companies',
};

export function masterRecordToRow(kind: MasterKind, record: MasterRecord): Row {
  switch (kind) {
    case 'group': {
      const g = record as AccountGroup;
      return {
        id: g.id,
        company_id: g.companyId,
        name: g.name,
        parent_id: g.parentId,
        nature: g.nature,
        affects_gross_profit: g.affectsGrossProfit,
        is_system: g.isSystem,
        reserved_key: nul(g.reservedKey),
        is_active: g.isActive !== false,
      };
    }
    case 'ledger': {
      const l = record as Ledger;
      return {
        id: l.id,
        company_id: l.companyId,
        name: l.name,
        group_id: l.groupId,
        is_active: l.isActive,
        code: nul(l.code),
        alias: nul(l.alias),
        party_id: nul(l.partyId),
        party_role: nul(l.partyRole),
        reserved_key: nul(l.reservedKey),
      };
    }
    case 'party': {
      const p = record as Party;
      return {
        id: p.id,
        company_id: p.companyId,
        name: p.name,
        gstin: nul(p.gstin),
        pan: nul(p.pan),
        phone: nul(p.phone),
        email: nul(p.email),
        address: nul(p.address),
        state_code: nul(p.stateCode),
        credit_days: nul(p.creditDays),
        credit_limit: p.creditLimit === undefined ? null : formatMoney(p.creditLimit),
        gst_registration: nul(p.gstRegistration),
        addresses: p.addresses ?? [],
        pincode: nul(p.pincode),
        country: nul(p.country),
        // Left out (not null) when absent: a JSON null would land in a jsonb column as the value 'null', not as SQL NULL.
        shipping: p.shipping,
        roles: p.roles,
        is_active: p.isActive,
      };
    }
    case 'unit': {
      const u = record as Unit;
      return {
        id: u.id,
        company_id: u.companyId,
        symbol: u.symbol,
        name: u.name,
        decimals: u.decimals,
        base_unit_id: nul(u.baseUnitId),
        factor: nul(u.factor),
        is_active: u.isActive,
      };
    }
    case 'stockGroup': {
      const g = record as StockGroup;
      return { id: g.id, company_id: g.companyId, name: g.name, parent_id: g.parentId, is_active: g.isActive };
    }
    case 'stockItem': {
      const i = record as StockItem;
      return {
        id: i.id,
        company_id: i.companyId,
        name: i.name,
        code: nul(i.code),
        alias: nul(i.alias),
        group_id: i.groupId,
        unit_id: i.unitId,
        hsn: nul(i.hsn),
        gst_rate_id: i.gstRateId,
        item_type: i.itemType,
        is_active: i.isActive,
      };
    }
    case 'warehouse': {
      const w = record as Warehouse;
      return { id: w.id, company_id: w.companyId, name: w.name, parent_id: w.parentId, is_active: w.isActive };
    }
    case 'gstRate': {
      const r = record as GstRate;
      return {
        id: r.id,
        company_id: r.companyId,
        name: r.name,
        rate_percent: r.ratePercent,
        cess_percent: r.cessPercent,
        effective_from: r.effectiveFrom,
      };
    }
    case 'voucherType': {
      const t = record as VoucherType;
      return {
        id: t.id,
        company_id: t.companyId,
        name: t.name,
        base_kind: t.baseKind,
        is_system: t.isSystem === true,
        is_active: t.isActive !== false,
      };
    }
    case 'numberingSeries': {
      const s = record as NumberingSeries;
      return {
        id: s.id,
        company_id: s.companyId,
        voucher_type_id: s.voucherTypeId,
        financial_year_id: s.financialYearId,
        prefix: s.prefix,
        suffix: s.suffix,
        width: s.width,
        start_at: s.startAt,
      };
    }
    case 'company': {
      const c = record as Masters['company'];
      return { id: c.id, name: c.name, gstin: nul(c.gstin), state_code: nul(c.stateCode), address: nul(c.address), charge_gst: c.chargeGst === true };
    }
  }
}

/** A whole company as table-shaped rows, for `company_seed`. */
export function mastersToSeed(m: Masters): Row {
  const rows = (kind: MasterKind, records: readonly MasterRecord[]) => records.map((r) => masterRecordToRow(kind, r));
  return {
    company: masterRecordToRow('company', m.company),
    financial_years: m.financialYears.map((f) => ({
      id: f.id,
      company_id: m.company.id,
      label: f.label,
      start_date: f.start,
      end_date: f.end,
    })),
    account_groups: rows('group', m.groups.all),
    ledgers: rows('ledger', m.ledgers),
    voucher_types: rows('voucherType', m.voucherTypes),
    numbering_series: rows('numberingSeries', m.series),
    parties: rows('party', m.parties),
    units: rows('unit', m.units),
    stock_groups: rows('stockGroup', m.stockGroups),
    stock_items: rows('stockItem', m.stockItems),
    warehouses: rows('warehouse', m.warehouses),
    gst_rates: rows('gstRate', m.gstRates),
  };
}
