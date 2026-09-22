import {
  type AccountGroup,
  type GstRate,
  type Ledger,
  type NumberingSeries,
  type Party,
  type StockGroup,
  type StockItem,
  type Unit,
  type VoucherType,
  type Warehouse,
  type Masters,
  type MasterKind,
  type MasterRecord,
  buildMasters,
  ledgersFromJson,
  mastersVersion,
  formatMoney,
} from '@minimalerp/domain';

export { buildMasters, ledgersFromJson, mastersVersion };

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
      return {
        id: c.id, name: c.name, gstin: nul(c.gstin), state_code: nul(c.stateCode), address: nul(c.address), charge_gst: c.chargeGst === true,
        phone: nul(c.phone), email: nul(c.email), bank_name: nul(c.bankName), bank_account_no: nul(c.bankAccountNo),
        bank_ifsc: nul(c.bankIfsc), bank_branch: nul(c.bankBranch), invoice_note: nul(c.invoiceNote), invoice_terms: nul(c.invoiceTerms),
      };
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
