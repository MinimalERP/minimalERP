import { MemoryBackend } from '@minimalerp/adapter-memory';
import {
  type CompanyId,
  type FinancialYear,
  type FinancialYearId,
  type GroupId,
  type JournalLine,
  type Ledger,
  type LedgerId,
  type LocalDate,
  type NumberingSeries,
  type ReservedGroupKey,
  type Voucher,
  type VoucherId,
  type VoucherKindRegistry,
  type VoucherType,
  type VoucherTypeId,
  GroupTree,
  Masters,
  asCompanyId,
  asFinancialYearId,
  asGroupId,
  asLedgerId,
  asSeriesId,
  asVoucherId,
  asVoucherTypeId,
  defaultVoucherKinds,
  localDate,
  seedDefaultGroups,
} from '@minimalerp/domain';
import type { JournalRepository, MastersRepository, PostingGateway, VoucherRepository } from '@minimalerp/ports';
import type { AccountingKind } from './kinds';

export type LedgerName =
  | 'cash'
  | 'bank'
  | 'bank2'
  | 'bankOd'
  | 'debtor'
  | 'creditor'
  | 'sales'
  | 'purchase'
  | 'rent'
  | 'salary'
  | 'capital'
  | 'outputTax'
  | 'oldDebtor';

/** Active cash / bank / bank-OD ledgers: the only valid accounts for Payment, Receipt, Contra. */
export const CASH_BANK_LEDGERS = ['cash', 'bank', 'bank2', 'bankOd'] as const satisfies readonly LedgerName[];
/** Active ledgers that are neither cash nor bank: valid in a Journal. */
export const OTHER_LEDGERS = [
  'debtor', 'creditor', 'sales', 'purchase', 'rent', 'salary', 'capital', 'outputTax',
] as const satisfies readonly LedgerName[];
export const ALL_ACTIVE_LEDGERS: readonly LedgerName[] = [...CASH_BANK_LEDGERS, ...OTHER_LEDGERS];

const LEDGERS: readonly { name: LedgerName; title: string; group: ReservedGroupKey; active?: boolean }[] = [
  { name: 'cash', title: 'Cash', group: 'cash-in-hand' },
  { name: 'bank', title: 'HDFC Bank', group: 'bank-accounts' },
  { name: 'bank2', title: 'ICICI Bank', group: 'bank-accounts' },
  { name: 'bankOd', title: 'SBI Overdraft', group: 'bank-od' },
  { name: 'debtor', title: 'ABC Industries', group: 'sundry-debtors' },
  { name: 'creditor', title: 'XYZ Supplies', group: 'sundry-creditors' },
  { name: 'sales', title: 'Sales', group: 'sales-accounts' },
  { name: 'purchase', title: 'Purchases', group: 'purchase-accounts' },
  { name: 'rent', title: 'Rent', group: 'indirect-expenses' },
  { name: 'salary', title: 'Salaries', group: 'indirect-expenses' },
  { name: 'capital', title: 'Capital', group: 'capital-account' },
  { name: 'outputTax', title: 'Output GST', group: 'duties-and-taxes' },
  { name: 'oldDebtor', title: 'Old Debtor (closed)', group: 'sundry-debtors', active: false },
];

const KINDS: readonly { kind: AccountingKind; title: string; prefix: string }[] = [
  { kind: 'contra', title: 'Contra', prefix: 'CON' },
  { kind: 'payment', title: 'Payment', prefix: 'PAY' },
  { kind: 'receipt', title: 'Receipt', prefix: 'REC' },
  { kind: 'journal', title: 'Journal', prefix: 'JRN' },
];

// ---- deterministic ids -------------------------------------------------------------------------

function fnv1a(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * A well-formed UUID derived from (seed, name). Deterministic within a world, distinct across worlds
 * (each world has its own seed), so many test companies can share one database.
 * Both backends see real UUIDs, so the same tests run against memory and PostgreSQL.
 */
export function makeUuidFactory(seed: string): (name: string) => string {
  return (name) => {
    const input = `${seed}|${name}`;
    const hex = [0x811c9dc5, 0x01000193, 0xdeadbeef, 0x9e3779b9]
      .map((offset) => fnv1a(`${input}|${offset}`, offset).toString(16).padStart(8, '0'))
      .join('');
    const variant = '89ab'[Number.parseInt(hex.charAt(16), 16) & 3];
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
}

export const randomSeed = (): string => Math.random().toString(36).slice(2) + Date.now().toString(36);

// ---- contract types ----------------------------------------------------------------------------

/** A prior state of an altered/cancelled voucher, as any backend reports it. */
export interface RevisionView {
  readonly voucher: Voucher;
  readonly journal: readonly JournalLine[];
}

/**
 * Everything the behavioural contract needs from a backend: the four ports plus two hooks that
 * stand in for admin actions (locking a period) and audit reads (a voucher's history).
 */
export interface ContractBackend extends PostingGateway, MastersRepository, VoucherRepository, JournalRepository {
  lockThrough(financialYearId: FinancialYearId, date: LocalDate | undefined): void | Promise<void>;
  history(voucherId: VoucherId): readonly RevisionView[] | Promise<readonly RevisionView[]>;
}

export interface WorldOptions {
  /** Swap the voucher-kind registry (used to test that buggy posting rules are refused). */
  readonly registry?: VoucherKindRegistry;
  /** false = a company with no numbering series at all. */
  readonly withSeries?: boolean;
}

export interface DemoWorld {
  readonly backend: ContractBackend;
  readonly masters: Masters;
  readonly companyId: CompanyId;
  readonly fy2425: FinancialYear;
  readonly fy2526: FinancialYear;
  readonly ledgers: Readonly<Record<LedgerName, LedgerId>>;
  readonly types: Readonly<Record<AccountingKind, VoucherTypeId>>;
  /** Any deterministic uuid for `name` in this world (e.g. a ledger id that does not exist). */
  uuid(name: string): string;
  /** The uuid a friendly voucher id like 'p1' maps to in this world. */
  vid(name: string): VoucherId;
  group(key: ReservedGroupKey): GroupId;
}

export type MakeWorld = (options?: WorldOptions) => DemoWorld | Promise<DemoWorld>;

export interface DemoData {
  readonly masters: Masters;
  readonly companyId: CompanyId;
  readonly fy2425: FinancialYear;
  readonly fy2526: FinancialYear;
  readonly ledgers: Readonly<Record<LedgerName, LedgerId>>;
  readonly types: Readonly<Record<AccountingKind, VoucherTypeId>>;
  readonly uuid: (name: string) => string;
}

/**
 * A small but realistic company: the default chart of groups, 13 ledgers (one inactive), two
 * financial years, the four voucher types with a numbering series per type per year.
 * Pure data — backends seed themselves from it.
 */
export function buildDemoData(seed: string = randomSeed(), withSeries = true): DemoData {
  const uuid = makeUuidFactory(seed);
  const companyId = asCompanyId(uuid('company'));
  const tree = GroupTree.buildOrThrow(seedDefaultGroups(companyId, (key) => asGroupId(uuid(`group:${key}`))));

  const ledgerList: Ledger[] = LEDGERS.map((l) => ({
    id: asLedgerId(uuid(`ledger:${l.name}`)),
    companyId,
    name: l.title,
    groupId: asGroupId(uuid(`group:${l.group}`)),
    isActive: l.active ?? true,
  }));

  const mkFy = (label: string, start: string, end: string): FinancialYear => ({
    id: asFinancialYearId(uuid(`fy:${label}`)),
    companyId,
    label,
    start: localDate(start),
    end: localDate(end),
  });
  const fy2425 = mkFy('2024-25', '2024-04-01', '2025-03-31');
  const fy2526 = mkFy('2025-26', '2025-04-01', '2026-03-31');

  const voucherTypes: VoucherType[] = KINDS.map((k) => ({
    id: asVoucherTypeId(uuid(`type:${k.kind}`)),
    companyId,
    name: k.title,
    baseKind: k.kind,
  }));

  const series: NumberingSeries[] = withSeries
    ? KINDS.flatMap((k) =>
        [fy2425, fy2526].map((fy) => ({
          id: asSeriesId(uuid(`series:${k.kind}:${fy.label}`)),
          companyId,
          voucherTypeId: asVoucherTypeId(uuid(`type:${k.kind}`)),
          financialYearId: fy.id,
          prefix: `${k.prefix}/${fy.label.slice(2)}/`,
          suffix: '',
          width: 4,
          startAt: 1,
        })),
      )
    : [];

  const masters = new Masters({
    company: { id: companyId, name: 'Demo Manufacturing Pvt Ltd' },
    groups: tree,
    ledgers: ledgerList,
    voucherTypes,
    series,
    financialYears: [fy2425, fy2526],
  });

  return {
    masters,
    companyId,
    fy2425,
    fy2526,
    uuid,
    ledgers: Object.fromEntries(LEDGERS.map((l, i) => [l.name, ledgerList[i]?.id])) as Record<LedgerName, LedgerId>,
    types: Object.fromEntries(voucherTypes.map((t) => [t.baseKind, t.id])) as Record<AccountingKind, VoucherTypeId>,
  };
}

/** Wraps seeded data as a DemoWorld around any backend. */
export function worldAround(data: DemoData, backend: ContractBackend): DemoWorld {
  return {
    ...data,
    backend,
    vid: (name) => asVoucherId(data.uuid(`voucher:${name}`)),
    group: (key) => asGroupId(data.uuid(`group:${key}`)),
  };
}

/** The in-memory world. Synchronous, and the reference the other backends must match. */
export function buildDemoWorld(options: WorldOptions = {}): DemoWorld {
  const data = buildDemoData(randomSeed(), options.withSeries ?? true);
  return worldAround(data, new MemoryBackend(data.masters, options.registry ?? defaultVoucherKinds()));
}
