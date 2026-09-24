import type { FinancialYear, LocalDate } from '../dates';
import { findFinancialYear } from '../dates';
import type { CompanyId, FinancialYearId, GroupId, LedgerId, PartyId, SeriesId, StockGroupId, StockItemId, UnitId, VoucherTypeId, WarehouseId, GstRateId } from '../ids';
import type { GroupTree, Nature } from './groups';
import type { GstRate, Party, StockGroup, StockItem, Unit, Warehouse } from './records';

export interface Company {
  readonly id: CompanyId;
  readonly name: string;
  readonly gstin?: string | undefined;
  /** Two-digit GST state code the company is registered in (drives CGST/SGST vs IGST later). */
  readonly stateCode?: string | undefined;
  readonly address?: string | undefined;
  /**
   * "Charge GST": whether this company's Sales and Purchase invoices carry GST. Off (the default) means an invoice is exactly what it always was —
   * the items and nothing else. It can be switched on in Company settings once the company's GSTIN and state are set.
   */
  readonly chargeGst?: boolean | undefined;

  // ---- Invoice / PDF Settings (ADR-0022): fixed content a print carries, edited from its own screen, not Company Settings ----
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
  readonly bankName?: string | undefined;
  readonly bankAccountNo?: string | undefined;
  readonly bankIfsc?: string | undefined;
  readonly bankBranch?: string | undefined;
  /** A short line under the totals, e.g. "Thank you for your business." */
  readonly invoiceNote?: string | undefined;
  /** Terms and conditions, printed as the person typed it (line breaks kept). */
  readonly invoiceTerms?: string | undefined;
}

/** The ledgers the GST and TDS postings find by reserved key (ADR-0019); their specs are in systemLedgers.ts. */
export type SystemLedgerKey =
  | 'gst-output-cgst'
  | 'gst-output-sgst'
  | 'gst-output-igst'
  | 'gst-input-cgst'
  | 'gst-input-sgst'
  | 'gst-input-igst'
  | 'tds-receivable'
  | 'round-off';

export interface Ledger {
  readonly id: LedgerId;
  readonly companyId: CompanyId;
  readonly name: string;
  readonly groupId: GroupId;
  readonly isActive: boolean;
  readonly code?: string | undefined;
  readonly alias?: string | undefined;
  /** The party this ledger belongs to, if any. */
  readonly partyId?: PartyId | undefined;
  /** Set on a ledger a party owns (customer = receivable, vendor = payable): it is kept in step with the party, not edited by hand. */
  readonly partyRole?: 'customer' | 'vendor' | undefined;
  /** Built-in ledgers cannot be renamed, moved or deactivated. */
  readonly reservedKey?: 'opening-difference' | SystemLedgerKey | undefined;
}

/**
 * The built-in voucher behaviours. A VoucherType (below) is a named, configurable instance of
 * one of these — "Sales-Export" is a VoucherType row with baseKind 'sales', not new code.
 * Later phases add 'sales', 'purchase', 'credit-note', … here and register a VoucherKind for each.
 */
export type BaseKind = 'contra' | 'payment' | 'receipt' | 'journal' | 'opening' | 'stockJournal' | 'stockOpening' | 'sales' | 'salesOrder' | 'purchase' | 'purchaseOrder';

/** The kinds a person can create a voucher type for. 'opening' and 'stockOpening' are system kinds (opening balances, opening stock). */
export type UserBaseKind = Exclude<BaseKind, 'opening' | 'stockOpening'>;
export const USER_BASE_KINDS: readonly UserBaseKind[] = ['contra', 'payment', 'receipt', 'journal', 'stockJournal', 'sales', 'salesOrder', 'purchase', 'purchaseOrder'];

/** Kinds that move stock and post NOTHING to the accounts. */
export const STOCK_ONLY_KINDS: readonly BaseKind[] = ['stockJournal', 'stockOpening'];

/** Kinds that are documents only: they post NOTHING to the accounts or the stock (a Sales or Purchase Order records what was agreed, not what happened). */
export const DOCUMENT_KINDS: readonly BaseKind[] = ['salesOrder', 'purchaseOrder'];

export interface VoucherType {
  readonly id: VoucherTypeId;
  readonly companyId: CompanyId;
  readonly name: string;
  readonly baseKind: BaseKind;
  readonly isSystem?: boolean | undefined;
  readonly isActive?: boolean | undefined;
}

/** One numbering sequence per (voucher type, financial year): e.g. "PAY/24-25/" + 0001. */
export interface NumberingSeries {
  readonly id: SeriesId;
  readonly companyId: CompanyId;
  readonly voucherTypeId: VoucherTypeId;
  readonly financialYearId: FinancialYearId;
  readonly prefix: string;
  readonly suffix: string;
  readonly width: number;
  readonly startAt: number;
}

export function formatVoucherNumber(series: NumberingSeries, sequence: number): string {
  return `${series.prefix}${String(sequence).padStart(series.width, '0')}${series.suffix}`;
}

export interface MastersData {
  readonly company: Company;
  readonly groups: GroupTree;
  readonly ledgers: readonly Ledger[];
  readonly voucherTypes: readonly VoucherType[];
  readonly series: readonly NumberingSeries[];
  readonly financialYears: readonly FinancialYear[];
  // Phase 4 masters. Optional so a snapshot that predates them (or does not need them) stays valid.
  readonly parties?: readonly Party[] | undefined;
  readonly units?: readonly Unit[] | undefined;
  readonly stockGroups?: readonly StockGroup[] | undefined;
  readonly stockItems?: readonly StockItem[] | undefined;
  readonly warehouses?: readonly Warehouse[] | undefined;
  readonly gstRates?: readonly GstRate[] | undefined;
}

/**
 * An immutable snapshot of everything the engine needs to validate and post a voucher.
 * Repositories load it; the engine never performs I/O. `with()` returns a modified copy.
 */
export class Masters {
  private readonly ledgersById: ReadonlyMap<LedgerId, Ledger>;
  private readonly typesById: ReadonlyMap<VoucherTypeId, VoucherType>;

  constructor(readonly data: MastersData) {
    this.ledgersById = new Map(data.ledgers.map((l) => [l.id, l]));
    this.typesById = new Map(data.voucherTypes.map((t) => [t.id, t]));
  }

  get company(): Company {
    return this.data.company;
  }

  get groups(): GroupTree {
    return this.data.groups;
  }

  get financialYears(): readonly FinancialYear[] {
    return this.data.financialYears;
  }

  ledger(id: LedgerId): Ledger | undefined {
    return this.ledgersById.get(id);
  }

  voucherType(id: VoucherTypeId): VoucherType | undefined {
    return this.typesById.get(id);
  }

  financialYearOn(date: LocalDate): FinancialYear | undefined {
    return findFinancialYear(this.data.financialYears, date);
  }

  financialYear(id: FinancialYearId): FinancialYear | undefined {
    return this.data.financialYears.find((fy) => fy.id === id);
  }

  seriesFor(typeId: VoucherTypeId, fyId: FinancialYearId): NumberingSeries | undefined {
    return this.data.series.find((s) => s.voucherTypeId === typeId && s.financialYearId === fyId);
  }

  get ledgers(): readonly Ledger[] {
    return this.data.ledgers;
  }

  get voucherTypes(): readonly VoucherType[] {
    return this.data.voucherTypes;
  }

  get series(): readonly NumberingSeries[] {
    return this.data.series;
  }

  get parties(): readonly Party[] {
    return this.data.parties ?? [];
  }

  get units(): readonly Unit[] {
    return this.data.units ?? [];
  }

  get stockGroups(): readonly StockGroup[] {
    return this.data.stockGroups ?? [];
  }

  get stockItems(): readonly StockItem[] {
    return this.data.stockItems ?? [];
  }

  get warehouses(): readonly Warehouse[] {
    return this.data.warehouses ?? [];
  }

  get gstRates(): readonly GstRate[] {
    return this.data.gstRates ?? [];
  }

  party(id: PartyId): Party | undefined {
    return this.parties.find((p) => p.id === id);
  }

  unit(id: UnitId): Unit | undefined {
    return this.units.find((u) => u.id === id);
  }

  stockGroup(id: StockGroupId): StockGroup | undefined {
    return this.stockGroups.find((g) => g.id === id);
  }

  stockItem(id: StockItemId): StockItem | undefined {
    return this.stockItems.find((i) => i.id === id);
  }

  warehouse(id: WarehouseId): Warehouse | undefined {
    return this.warehouses.find((w) => w.id === id);
  }

  gstRate(id: GstRateId): GstRate | undefined {
    return this.gstRates.find((r) => r.id === id);
  }

  /** A system ledger by its reserved key (a GST head, or TDS Receivable), if the company has it. */
  systemLedger(key: SystemLedgerKey): Ledger | undefined {
    return this.data.ledgers.find((l) => l.reservedKey === key);
  }

  /** Where opening balances are balanced against until the books are reconciled ("Opening Balance Difference"). */
  openingDifferenceLedger(): Ledger | undefined {
    return this.data.ledgers.find((l) => l.reservedKey === 'opening-difference');
  }

  natureOfLedger(id: LedgerId): Nature | undefined {
    const ledger = this.ledgersById.get(id);
    return ledger ? this.data.groups.natureOf(ledger.groupId) : undefined;
  }

  /** Cash-in-Hand, Bank Accounts and Bank OD ledgers — the only ones Payment/Receipt/Contra accounts may use. */
  isCashOrBank(id: LedgerId): boolean {
    const ledger = this.ledgersById.get(id);
    return (
      ledger !== undefined &&
      this.data.groups.isWithinReserved(ledger.groupId, 'cash-in-hand', 'bank-accounts', 'bank-od')
    );
  }

  with(patch: Partial<MastersData>): Masters {
    return new Masters({ ...this.data, ...patch });
  }

  withLockedThrough(id: FinancialYearId, date: LocalDate | undefined): Masters {
    return this.with({
      financialYears: this.data.financialYears.map((fy) =>
        fy.id === id ? { ...fy, lockedThrough: date } : fy,
      ),
    });
  }
}
