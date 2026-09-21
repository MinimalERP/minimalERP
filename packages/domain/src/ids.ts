/**
 * Branded string ids: a LedgerId cannot be passed where a GroupId is expected.
 * The domain never generates ids — callers supply them (UUIDv7 in production, counters in tests).
 */
export type Id<B extends string> = string & { readonly __brand: B };

export type CompanyId = Id<'Company'>;
export type FinancialYearId = Id<'FinancialYear'>;
export type GroupId = Id<'Group'>;
export type LedgerId = Id<'Ledger'>;
export type VoucherTypeId = Id<'VoucherType'>;
export type SeriesId = Id<'NumberingSeries'>;
export type VoucherId = Id<'Voucher'>;
export type PartyId = Id<'Party'>;
export type UnitId = Id<'Unit'>;
export type StockGroupId = Id<'StockGroup'>;
export type StockItemId = Id<'StockItem'>;
export type WarehouseId = Id<'Warehouse'>;
export type GstRateId = Id<'GstRate'>;

export const asCompanyId = (s: string): CompanyId => s as CompanyId;
export const asFinancialYearId = (s: string): FinancialYearId => s as FinancialYearId;
export const asGroupId = (s: string): GroupId => s as GroupId;
export const asLedgerId = (s: string): LedgerId => s as LedgerId;
export const asVoucherTypeId = (s: string): VoucherTypeId => s as VoucherTypeId;
export const asSeriesId = (s: string): SeriesId => s as SeriesId;
export const asVoucherId = (s: string): VoucherId => s as VoucherId;
export const asPartyId = (s: string): PartyId => s as PartyId;
export const asUnitId = (s: string): UnitId => s as UnitId;
export const asStockGroupId = (s: string): StockGroupId => s as StockGroupId;
export const asStockItemId = (s: string): StockItemId => s as StockItemId;
export const asWarehouseId = (s: string): WarehouseId => s as WarehouseId;
export const asGstRateId = (s: string): GstRateId => s as GstRateId;

function fnv1a(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * A well-formed UUID derived from a name: the same name always gives the same id. Used where an id must be
 * reproducible — e.g. a ledger's opening-balance voucher, so posting it twice is an idempotent replay,
 * never a duplicate.
 */
export function deterministicUuid(name: string): string {
  const hex = [0x811c9dc5, 0x01000193, 0xdeadbeef, 0x9e3779b9]
    .map((offset) => fnv1a(`${name}|${offset}`, offset).toString(16).padStart(8, '0'))
    .join('');
  const variant = '89ab'[Number.parseInt(hex.charAt(16), 16) & 3];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
