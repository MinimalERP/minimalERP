import type { CompanyId, GroupId } from '../ids';
import { type Issue, type Result, IssueCode, failWith, issue, ok } from '../errors';

export type Nature = 'asset' | 'liability' | 'income' | 'expense';

/** Stable identity of the built-in groups. Rules refer to these keys, never to display names. */
export type ReservedGroupKey =
  | 'branch-divisions'
  | 'capital-account'
  | 'current-assets'
  | 'current-liabilities'
  | 'direct-expenses'
  | 'direct-incomes'
  | 'fixed-assets'
  | 'indirect-expenses'
  | 'indirect-incomes'
  | 'investments'
  | 'loans-liability'
  | 'misc-expenses-asset'
  | 'purchase-accounts'
  | 'sales-accounts'
  | 'suspense'
  | 'bank-accounts'
  | 'bank-od'
  | 'cash-in-hand'
  | 'deposits-asset'
  | 'duties-and-taxes'
  | 'loans-and-advances-asset'
  | 'provisions'
  | 'reserves-and-surplus'
  | 'secured-loans'
  | 'stock-in-hand'
  | 'sundry-creditors'
  | 'sundry-debtors'
  | 'unsecured-loans';

export interface AccountGroup {
  readonly id: GroupId;
  readonly companyId: CompanyId;
  readonly name: string;
  readonly parentId: GroupId | null;
  readonly nature: Nature;
  /** True for Sales/Purchase/Direct income & expense groups — they form the Trading account. */
  readonly affectsGrossProfit: boolean;
  /** Built-in groups cannot be deleted or re-parented. */
  readonly isSystem: boolean;
  readonly reservedKey?: ReservedGroupKey | undefined;
  /** Defaults to active. A group with active ledgers or sub-groups cannot be deactivated. */
  readonly isActive?: boolean | undefined;
}

interface DefaultGroupSpec {
  readonly key: ReservedGroupKey;
  readonly name: string;
  readonly parent: ReservedGroupKey | null;
  readonly nature: Nature;
  readonly affectsGrossProfit?: boolean;
}

/** The 15 primary + 13 sub-groups every company starts with (the classic chart-of-accounts skeleton). */
export const DEFAULT_GROUPS: readonly DefaultGroupSpec[] = [
  { key: 'branch-divisions', name: 'Branch / Divisions', parent: null, nature: 'liability' },
  { key: 'capital-account', name: 'Capital Account', parent: null, nature: 'liability' },
  { key: 'current-assets', name: 'Current Assets', parent: null, nature: 'asset' },
  { key: 'current-liabilities', name: 'Current Liabilities', parent: null, nature: 'liability' },
  { key: 'direct-expenses', name: 'Direct Expenses', parent: null, nature: 'expense', affectsGrossProfit: true },
  { key: 'direct-incomes', name: 'Direct Incomes', parent: null, nature: 'income', affectsGrossProfit: true },
  { key: 'fixed-assets', name: 'Fixed Assets', parent: null, nature: 'asset' },
  { key: 'indirect-expenses', name: 'Indirect Expenses', parent: null, nature: 'expense' },
  { key: 'indirect-incomes', name: 'Indirect Incomes', parent: null, nature: 'income' },
  { key: 'investments', name: 'Investments', parent: null, nature: 'asset' },
  { key: 'loans-liability', name: 'Loans (Liability)', parent: null, nature: 'liability' },
  { key: 'misc-expenses-asset', name: 'Misc. Expenses (ASSET)', parent: null, nature: 'asset' },
  { key: 'purchase-accounts', name: 'Purchase Accounts', parent: null, nature: 'expense', affectsGrossProfit: true },
  { key: 'sales-accounts', name: 'Sales Accounts', parent: null, nature: 'income', affectsGrossProfit: true },
  { key: 'suspense', name: 'Suspense A/c', parent: null, nature: 'liability' },

  { key: 'bank-accounts', name: 'Bank Accounts', parent: 'current-assets', nature: 'asset' },
  { key: 'bank-od', name: 'Bank OD A/c', parent: 'loans-liability', nature: 'liability' },
  { key: 'cash-in-hand', name: 'Cash-in-Hand', parent: 'current-assets', nature: 'asset' },
  { key: 'deposits-asset', name: 'Deposits (Asset)', parent: 'current-assets', nature: 'asset' },
  { key: 'duties-and-taxes', name: 'Duties & Taxes', parent: 'current-liabilities', nature: 'liability' },
  { key: 'loans-and-advances-asset', name: 'Loans & Advances (Asset)', parent: 'current-assets', nature: 'asset' },
  { key: 'provisions', name: 'Provisions', parent: 'current-liabilities', nature: 'liability' },
  { key: 'reserves-and-surplus', name: 'Reserves & Surplus', parent: 'capital-account', nature: 'liability' },
  { key: 'secured-loans', name: 'Secured Loans', parent: 'loans-liability', nature: 'liability' },
  { key: 'stock-in-hand', name: 'Stock-in-Hand', parent: 'current-assets', nature: 'asset' },
  { key: 'sundry-creditors', name: 'Sundry Creditors', parent: 'current-liabilities', nature: 'liability' },
  { key: 'sundry-debtors', name: 'Sundry Debtors', parent: 'current-assets', nature: 'asset' },
  { key: 'unsecured-loans', name: 'Unsecured Loans', parent: 'loans-liability', nature: 'liability' },
];

/** Builds the default chart for a new company. The caller supplies ids (UUIDs in production). */
export function seedDefaultGroups(
  companyId: CompanyId,
  newId: (key: ReservedGroupKey) => GroupId,
): AccountGroup[] {
  return DEFAULT_GROUPS.map((spec) => ({
    id: newId(spec.key),
    companyId,
    name: spec.name,
    parentId: spec.parent === null ? null : newId(spec.parent),
    nature: spec.nature,
    affectsGrossProfit: spec.affectsGrossProfit ?? false,
    isSystem: true,
    reservedKey: spec.key,
  }));
}

/**
 * Immutable, validated view of a company's group hierarchy.
 * Invariants checked at build time: unique ids, parents exist, no cycles, and every child has
 * the same nature as its parent (so a ledger's nature is always well-defined).
 */
export class GroupTree {
  private constructor(private readonly byId: ReadonlyMap<GroupId, AccountGroup>) {}

  static build(groups: readonly AccountGroup[]): Result<GroupTree> {
    const byId = new Map<GroupId, AccountGroup>();
    const problems: Issue[] = [];

    for (const g of groups) {
      if (byId.has(g.id)) problems.push(issue(IssueCode.GroupTreeInvalid, `Duplicate group id ${g.id}`));
      byId.set(g.id, g);
    }
    for (const g of groups) {
      if (g.parentId === null) continue;
      const parent = byId.get(g.parentId);
      if (!parent) {
        problems.push(issue(IssueCode.GroupTreeInvalid, `Group "${g.name}" has unknown parent ${g.parentId}`));
      } else if (parent.nature !== g.nature) {
        problems.push(
          issue(
            IssueCode.GroupTreeInvalid,
            `Group "${g.name}" (${g.nature}) must have the same nature as its parent "${parent.name}" (${parent.nature})`,
          ),
        );
      }
    }
    for (const g of groups) {
      const seen = new Set<GroupId>();
      let cursor: AccountGroup | undefined = g;
      while (cursor && cursor.parentId !== null) {
        if (seen.has(cursor.id)) {
          problems.push(issue(IssueCode.GroupTreeInvalid, `Group "${g.name}" is part of a cycle`));
          break;
        }
        seen.add(cursor.id);
        cursor = byId.get(cursor.parentId);
      }
    }
    return problems.length > 0 ? failWith(problems) : ok(new GroupTree(byId));
  }

  static buildOrThrow(groups: readonly AccountGroup[]): GroupTree {
    const r = GroupTree.build(groups);
    if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
    return r.value;
  }

  get all(): readonly AccountGroup[] {
    return [...this.byId.values()];
  }

  get(id: GroupId): AccountGroup | undefined {
    return this.byId.get(id);
  }

  /** The group itself first, then each ancestor up to the primary group. Empty if `id` is unknown. */
  ancestorsOf(id: GroupId): AccountGroup[] {
    const chain: AccountGroup[] = [];
    let cursor = this.byId.get(id);
    while (cursor) {
      chain.push(cursor);
      cursor = cursor.parentId === null ? undefined : this.byId.get(cursor.parentId);
    }
    return chain;
  }

  rootOf(id: GroupId): AccountGroup | undefined {
    return this.ancestorsOf(id).at(-1);
  }

  natureOf(id: GroupId): Nature | undefined {
    return this.byId.get(id)?.nature;
  }

  /** True if `id` is `ancestorId` or lies anywhere beneath it. */
  isWithin(id: GroupId, ancestorId: GroupId): boolean {
    return this.ancestorsOf(id).some((g) => g.id === ancestorId);
  }

  /** True if the group, or any ancestor, is one of the given built-in groups. */
  isWithinReserved(id: GroupId, ...keys: ReservedGroupKey[]): boolean {
    return this.ancestorsOf(id).some((g) => g.reservedKey !== undefined && keys.includes(g.reservedKey));
  }
}
