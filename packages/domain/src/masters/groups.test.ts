import { describe, expect, it } from 'vitest';
import { IssueCode } from '../errors';
import { asCompanyId, asGroupId } from '../ids';
import { type AccountGroup, DEFAULT_GROUPS, GroupTree, seedDefaultGroups } from './groups';

const company = asCompanyId('c1');
const seed = () => seedDefaultGroups(company, (k) => asGroupId(`g-${k}`));

const custom = (id: string, parent: string | null, nature: AccountGroup['nature']): AccountGroup => ({
  id: asGroupId(id),
  companyId: company,
  name: id,
  parentId: parent === null ? null : asGroupId(parent),
  nature,
  affectsGrossProfit: false,
  isSystem: false,
});

describe('default chart of groups', () => {
  it('has 15 primary and 13 sub-groups with unique keys', () => {
    expect(DEFAULT_GROUPS).toHaveLength(28);
    expect(DEFAULT_GROUPS.filter((g) => g.parent === null)).toHaveLength(15);
    expect(new Set(DEFAULT_GROUPS.map((g) => g.key)).size).toBe(28);
  });

  it('builds into a valid tree', () => {
    expect(GroupTree.build(seed()).ok).toBe(true);
  });

  it('marks only the trading-account groups as affecting gross profit', () => {
    const gp = DEFAULT_GROUPS.filter((g) => g.affectsGrossProfit).map((g) => g.key).sort();
    expect(gp).toEqual(['direct-expenses', 'direct-incomes', 'purchase-accounts', 'sales-accounts']);
  });

  it('gives every sub-group its parent’s nature', () => {
    const byKey = new Map(DEFAULT_GROUPS.map((g) => [g.key, g]));
    for (const g of DEFAULT_GROUPS) {
      if (g.parent) expect(byKey.get(g.parent)?.nature).toBe(g.nature);
    }
  });
});

describe('GroupTree', () => {
  const tree = GroupTree.buildOrThrow([...seed(), custom('g-petty', 'g-cash-in-hand', 'asset')]);

  it('resolves nature through the chain', () => {
    expect(tree.natureOf(asGroupId('g-petty'))).toBe('asset');
    expect(tree.natureOf(asGroupId('g-sales-accounts'))).toBe('income');
    expect(tree.natureOf(asGroupId('nope'))).toBeUndefined();
  });

  it('lists ancestors self-first up to the primary group', () => {
    expect(tree.ancestorsOf(asGroupId('g-petty')).map((g) => g.id)).toEqual([
      'g-petty',
      'g-cash-in-hand',
      'g-current-assets',
    ]);
    expect(tree.rootOf(asGroupId('g-petty'))?.id).toBe('g-current-assets');
  });

  it('answers isWithin for self, ancestors and unrelated groups', () => {
    expect(tree.isWithin(asGroupId('g-petty'), asGroupId('g-petty'))).toBe(true);
    expect(tree.isWithin(asGroupId('g-petty'), asGroupId('g-current-assets'))).toBe(true);
    expect(tree.isWithin(asGroupId('g-petty'), asGroupId('g-fixed-assets'))).toBe(false);
  });

  it('recognises a user-created group under Cash-in-Hand as cash, by reserved key not name', () => {
    expect(tree.isWithinReserved(asGroupId('g-petty'), 'cash-in-hand')).toBe(true);
    expect(tree.isWithinReserved(asGroupId('g-petty'), 'bank-accounts')).toBe(false);
    expect(tree.isWithinReserved(asGroupId('g-sundry-debtors'), 'cash-in-hand', 'bank-accounts')).toBe(false);
  });
});

describe('GroupTree.build validation', () => {
  const codes = (groups: AccountGroup[]) => {
    const r = GroupTree.build(groups);
    return r.ok ? [] : r.issues.map((i) => i.code);
  };

  it('rejects duplicate ids', () => {
    expect(codes([custom('a', null, 'asset'), custom('a', null, 'asset')])).toContain(IssueCode.GroupTreeInvalid);
  });

  it('rejects an unknown parent', () => {
    expect(codes([custom('a', 'ghost', 'asset')])).toContain(IssueCode.GroupTreeInvalid);
  });

  it('rejects a child whose nature differs from its parent', () => {
    expect(codes([custom('a', null, 'asset'), custom('b', 'a', 'liability')])).toContain(IssueCode.GroupTreeInvalid);
  });

  it('rejects cycles', () => {
    expect(codes([custom('a', 'b', 'asset'), custom('b', 'a', 'asset')])).toContain(IssueCode.GroupTreeInvalid);
  });

  it('buildOrThrow throws on an invalid tree', () => {
    expect(() => GroupTree.buildOrThrow([custom('a', 'ghost', 'asset')])).toThrow();
  });
});
