import { type LocalDate, localDate } from '../dates';
import {
  asCompanyId,
  asFinancialYearId,
  asGroupId,
  asGstRateId,
  asLedgerId,
  asSeriesId,
  asUnitId,
  asVoucherTypeId,
  asWarehouseId,
} from '../ids';
import { GroupTree, seedDefaultGroups } from './groups';
import { type BaseKind, type Ledger, Masters, type NumberingSeries, type VoucherType } from './masters';
import type { GstRate, Unit, Warehouse } from './records';
import { systemLedgersFor } from './systemLedgers';

export interface SeedCompanyInput {
  readonly name: string;
  /** Leave the system ledgers (GST, TDS) out — for a saved company that adds them itself once its own history has been replayed. Default: seeded. */
  readonly systemLedgers?: boolean;
  /** First day of the first financial year, e.g. 2024-04-01. */
  readonly fyStart: LocalDate;
  readonly gstin?: string | undefined;
  readonly stateCode?: string | undefined;
  readonly address?: string | undefined;
  /** Supplies every id, keyed by a stable name so callers can make them deterministic. */
  readonly newId: (name: string) => string;
}

const TYPES: readonly { base: BaseKind; name: string; prefix: string }[] = [
  { base: 'contra', name: 'Contra', prefix: 'CON' },
  { base: 'payment', name: 'Payment', prefix: 'PAY' },
  { base: 'receipt', name: 'Receipt', prefix: 'REC' },
  { base: 'journal', name: 'Journal', prefix: 'JRN' },
  { base: 'opening', name: 'Opening Balance', prefix: 'OB' },
  { base: 'stockJournal', name: 'Stock Journal', prefix: 'STJ' },
  { base: 'stockOpening', name: 'Opening Stock', prefix: 'OS' },
  { base: 'sales', name: 'Sales', prefix: 'SAL' },
  { base: 'salesOrder', name: 'Sales Order', prefix: 'SO' },
  { base: 'purchase', name: 'Purchase', prefix: 'PUR' },
  { base: 'purchaseOrder', name: 'Purchase Order', prefix: 'PO' },
];

const GST_SLABS = ['0', '5', '12', '18', '28'] as const;
const UNITS: readonly { symbol: string; name: string; decimals: number }[] = [
  { symbol: 'Nos', name: 'Numbers', decimals: 0 },
  { symbol: 'Kg', name: 'Kilograms', decimals: 3 },
  { symbol: 'Ltr', name: 'Litres', decimals: 3 },
  { symbol: 'Mtr', name: 'Metres', decimals: 2 },
  { symbol: 'Box', name: 'Boxes', decimals: 0 },
];

/** One year from `start`, minus a day: 2024-04-01 → 2025-03-31. */
function endOfYearStartingOn(start: LocalDate): LocalDate {
  const d = new Date(0);
  d.setUTCFullYear(Number(start.slice(0, 4)) + 1, Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)) - 1);
  return localDate(d.toISOString().slice(0, 10));
}

/**
 * The starting point of every company: the standard chart of groups, "Cash" and the built-in
 * "Opening Balance Difference" ledger, the voucher types with a numbering series for the first year, the
 * standard GST slabs, common units and a main warehouse. Everything is ordinary master data the user can
 * add to; the built-ins are marked so they cannot be altered.
 */
export function seedCompany(input: SeedCompanyInput): Masters {
  const { newId } = input;
  const companyId = asCompanyId(newId('company'));

  const groups = GroupTree.buildOrThrow(seedDefaultGroups(companyId, (key) => asGroupId(newId(`group:${key}`))));
  const groupId = (key: string) => asGroupId(newId(`group:${key}`));

  const ledgers: Ledger[] = [
    { id: asLedgerId(newId('ledger:cash')), companyId, name: 'Cash', groupId: groupId('cash-in-hand'), isActive: true },
    {
      id: asLedgerId(newId('ledger:opening-difference')),
      companyId,
      name: 'Opening Balance Difference',
      groupId: groupId('suspense'),
      isActive: true,
      reservedKey: 'opening-difference',
    },
  ];

  const startYear = Number(input.fyStart.slice(0, 4));
  const end = endOfYearStartingOn(input.fyStart);
  const endYear = Number(end.slice(0, 4));
  // April–March years read "2024-25"; a calendar-year company (Jan–Dec) reads just "2024".
  const two = (year: number) => String(year % 100).padStart(2, '0');
  const label = endYear === startYear ? `${startYear}` : `${startYear}-${two(endYear)}`;
  const fy = { id: asFinancialYearId(newId(`fy:${label}`)), companyId, label, start: input.fyStart, end };
  const short = endYear === startYear ? two(startYear) : `${two(startYear)}-${two(endYear)}`;

  const voucherTypes: VoucherType[] = TYPES.map((t) => ({
    id: asVoucherTypeId(newId(`type:${t.base}`)),
    companyId,
    name: t.name,
    baseKind: t.base,
    isSystem: true,
    isActive: true,
  }));
  const series: NumberingSeries[] = TYPES.map((t) => ({
    id: asSeriesId(newId(`series:${t.base}:${label}`)),
    companyId,
    voucherTypeId: asVoucherTypeId(newId(`type:${t.base}`)),
    financialYearId: fy.id,
    prefix: t.base === 'opening' ? 'OB/' : t.base === 'stockOpening' ? 'OS/' : `${t.prefix}/${short}/`,
    suffix: '',
    width: 4,
    startAt: 1,
  }));

  const gstRates: GstRate[] = GST_SLABS.map((p) => ({
    id: asGstRateId(newId(`gst:${p}`)),
    companyId,
    name: `GST ${p}%`,
    ratePercent: p,
    cessPercent: '0',
    effectiveFrom: localDate('2017-07-01'),
  }));
  const units: Unit[] = UNITS.map((u) => ({
    id: asUnitId(newId(`unit:${u.symbol}`)),
    companyId,
    symbol: u.symbol,
    name: u.name,
    decimals: u.decimals,
    isActive: true,
  }));
  const warehouses: Warehouse[] = [
    { id: asWarehouseId(newId('warehouse:main')), companyId, name: 'Main Location', parentId: null, isActive: true },
  ];

  return new Masters({
    company: { id: companyId, name: input.name, gstin: input.gstin, stateCode: input.stateCode, address: input.address },
    groups,
    ledgers: input.systemLedgers === false ? ledgers : [...ledgers, ...systemLedgersFor({ company: { id: companyId, name: input.name }, groups })],
    voucherTypes,
    series,
    financialYears: [fy],
    parties: [],
    units,
    stockGroups: [],
    stockItems: [],
    warehouses,
    gstRates,
  });
}
