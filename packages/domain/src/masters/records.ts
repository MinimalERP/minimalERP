import type { LocalDate } from '../dates';
import { deterministicUuid } from '../ids';
import type { CompanyId, GstRateId, PartyId, StockGroupId, StockItemId, UnitId, WarehouseId } from '../ids';
import type { Money } from '../money';

/**
 * A business party (customer, supplier, or both). Only ledgers post to the books; a party is the
 * identity behind one or more ledgers (ADR-0006). Optional text fields are undefined when blank.
 */
export interface Party {
  readonly id: PartyId;
  readonly companyId: CompanyId;
  readonly name: string;
  readonly gstin?: string | undefined;
  readonly pan?: string | undefined;
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
  readonly address?: string | undefined;
  /** Two-digit GST state code. Derived from the GSTIN when that is given. */
  readonly stateCode?: string | undefined;
  readonly pincode?: string | undefined;
  readonly country?: string | undefined;
  /**
   * Where goods are sent, when that is not the billing address (absent = same as billing).
   */
  readonly shipping?: PartyShipping | undefined;
  /**
   * What the party is to us. Each role has its own ledger, created and kept in step automatically; a party that is both has TWO
   * (receivable under Sundry Debtors, payable under Sundry Creditors). Empty only for a profile created before roles existed.
   */
  readonly roles?: readonly PartyRole[] | undefined;
  readonly creditDays?: number | undefined;
  readonly creditLimit?: Money | undefined;
  /** How the party is registered for GST (drives the tax on its documents). */
  readonly gstRegistration?: 'regular' | 'composition' | 'unregistered' | 'sez' | 'overseas' | undefined;
  /** Saved billing/shipping addresses, picked (or added to) in the Party Details window of a voucher. */
  readonly addresses?: readonly PartyAddress[] | undefined;
  readonly isActive: boolean;
}

export type PartyRole = 'customer' | 'vendor';
export const PARTY_ROLES: readonly PartyRole[] = ['customer', 'vendor'];

export interface PartyShipping {
  readonly lines?: string | undefined;
  readonly stateCode?: string | undefined;
  readonly pincode?: string | undefined;
  readonly country?: string | undefined;
}

/**
 * The id of a party's ledger for a role. DERIVED from the party's id, so creating a party is idempotent (a retry finds the same
 * ledgers) and the screens know a party's ledgers without looking them up.
 */
export const partyLedgerId = (partyId: string, role: PartyRole): string => deterministicUuid(`party-ledger|${partyId}|${role}`);

/** One saved address in a party's address book. */
export interface PartyAddress {
  readonly id: string;
  /** "Head office", "Chakan unit"… */
  readonly label: string;
  readonly lines: string;
  /** Two-digit GST state code. */
  readonly stateCode?: string | undefined;
  readonly country?: string | undefined;
  readonly pincode?: string | undefined;
}

/**
 * A unit of measure. A unit may be defined as a multiple of another ("1 KG = 1000 GM": base GM, factor 1000).
 * The factor is a decimal string so no float ever touches a quantity.
 */
export interface Unit {
  readonly id: UnitId;
  readonly companyId: CompanyId;
  readonly symbol: string;
  readonly name: string;
  /** Decimal places quantities in this unit may have (0 for pieces, 3 for kilograms). */
  readonly decimals: number;
  readonly baseUnitId?: UnitId | undefined;
  readonly factor?: string | undefined;
  readonly isActive: boolean;
}

export interface StockGroup {
  readonly id: StockGroupId;
  readonly companyId: CompanyId;
  readonly name: string;
  readonly parentId: StockGroupId | null;
  readonly isActive: boolean;
}

export type ItemType = 'raw' | 'wip' | 'finished' | 'trading' | 'service';
export const ITEM_TYPES: readonly ItemType[] = ['raw', 'wip', 'finished', 'trading', 'service'];

export interface StockItem {
  readonly id: StockItemId;
  readonly companyId: CompanyId;
  readonly name: string;
  readonly code?: string | undefined;
  readonly alias?: string | undefined;
  readonly groupId: StockGroupId | null;
  readonly unitId: UnitId;
  /** HSN (goods) or SAC (services) code. */
  readonly hsn?: string | undefined;
  readonly gstRateId: GstRateId | null;
  readonly itemType: ItemType;
  readonly isActive: boolean;
}

/** A godown / store / location that holds stock. May be nested (Plant → Store 1). */
export interface Warehouse {
  readonly id: WarehouseId;
  readonly companyId: CompanyId;
  readonly name: string;
  readonly parentId: WarehouseId | null;
  readonly isActive: boolean;
}

/**
 * A GST rate slab. Effective-dated so a rate change never rewrites history. CGST and SGST are each half of
 * `ratePercent` (intra-state); IGST is the whole (inter-state). Percentages are decimal strings.
 */
export interface GstRate {
  readonly id: GstRateId;
  readonly companyId: CompanyId;
  readonly name: string;
  readonly ratePercent: string;
  readonly cessPercent: string;
  readonly effectiveFrom: LocalDate;
}
