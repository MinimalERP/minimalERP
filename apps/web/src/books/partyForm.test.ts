import { MemoryBackend } from '@minimalerp/adapter-memory';
import { IssueCode, findMaster, partyLedgerId } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { preferSiblings, preferredRole, type LedgerChoice, ledgerChoices } from '../vouchers/model';
import { type Books, BooksHost, type LocalBackend } from './books';
import { FORMS, type FormValues, blankValues, issueField, labelOfRef, optionsFor, recordToValues, roleTypeRoles, valuesToData } from './forms';
import { createLocalFactory, memoryStore } from './local';

const spec = FORMS.party;
const withValues = (over: FormValues): FormValues => ({ ...blankValues(spec), ...over });

async function opened(): Promise<Books> {
  const host = new BooksHost(
    createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }),
  );
  const created = await host.create({ name: 'Acme Works', fyStart: '2024-04-01' });
  if (!created.ok) throw new Error(JSON.stringify(created.issues));
  return created.value;
}

describe('the party form', () => {
  it('starts as a customer with the shipping address the same as billing', () => {
    const v = blankValues(spec);
    expect(v.roleType).toBe('customer');
    expect(v.shipMode).toBe('same');
    expect(valuesToData(spec, withValues({ name: 'ABC' }))).toEqual({ name: 'ABC', roles: ['customer'] });
  });

  it('turns the type into roles', () => {
    expect(roleTypeRoles('customer')).toEqual(['customer']);
    expect(roleTypeRoles('vendor')).toEqual(['vendor']);
    expect(roleTypeRoles('both')).toEqual(['customer', 'vendor']);
    expect(valuesToData(spec, withValues({ name: 'K', roleType: 'both' })).roles).toEqual(['customer', 'vendor']);
  });

  it('sends billing fields as they are, and a shipping address only when it is a different one', () => {
    const billing = withValues({ name: 'ABC', address: 'Plot 14', stateCode: '27', pincode: '411026', country: 'India', shipLines: 'ignored', shipPincode: '999999' });
    expect(valuesToData(spec, billing)).toEqual({ name: 'ABC', roles: ['customer'], address: 'Plot 14', stateCode: '27', pincode: '411026', country: 'India' });
    const different = withValues({ ...billing, shipMode: 'different', shipLines: ' Godown 3 ', shipStateCode: '27', shipPincode: '410501', shipCountry: '' });
    expect(valuesToData(spec, different).shipping).toEqual({ lines: 'Godown 3', stateCode: '27', pincode: '410501' });
  });

  it('never sends the opening balances as party data (they are posted to the ledgers)', () => {
    const data = valuesToData(spec, withValues({ name: 'ABC', openCustAmount: '5000', openCustBill: 'INV-1' }));
    expect(Object.keys(data)).toEqual(['name', 'roles']);
  });

  it('shows the opening balance fields only for the roles chosen', () => {
    const shown = (roleType: string) =>
      spec.fields.filter((f) => f.key.startsWith('open') && (f.visibleIf?.(withValues({ roleType })) ?? true)).map((f) => f.key);
    expect(shown('customer')).toEqual(['openCustAmount', 'openCustSide', 'openCustBill']);
    expect(shown('vendor')).toEqual(['openVendAmount', 'openVendSide', 'openVendBill']);
    expect(shown('both')).toHaveLength(6);
    expect(blankValues(spec).openCustSide).toBe('debit');
    expect(blankValues(spec).openVendSide).toBe('credit');
  });

  it('shows the ship-to fields only for a different address', () => {
    const visible = (shipMode: string) => spec.fields.filter((f) => f.key.startsWith('ship') && f.key !== 'shipMode' && f.visibleIf?.(withValues({ shipMode }))).map((f) => f.key);
    expect(visible('same')).toEqual([]);
    expect(visible('different')).toEqual(['shipLines', 'shipStateCode', 'shipPincode', 'shipCountry']);
  });

  it('reads a saved party back into the form, and back out to the same command data', async () => {
    const books = await opened();
    const id = crypto.randomUUID();
    const data = { name: 'Kumar Works', roles: ['customer', 'vendor'], address: 'Peenya', stateCode: '29', pincode: '560058', shipping: { lines: 'Hosur', stateCode: '33', pincode: '635126' } };
    expect((await books.execute({ op: 'create', kind: 'party', id, data })).ok).toBe(true);
    const saved = findMaster(books.masters, 'party', id) as NonNullable<ReturnType<typeof findMaster>>;
    const values = recordToValues(spec, saved);
    expect(values).toMatchObject({ roleType: 'both', shipMode: 'different', shipLines: 'Hosur', shipPincode: '635126', pincode: '560058' });
    expect(valuesToData(spec, values)).toMatchObject(data); // saving it unchanged is a no-op
    expect((await books.execute({ op: 'alter', kind: 'party', id, data: valuesToData(spec, values) })).ok).toBe(true);
    const again = await books.execute({ op: 'alter', kind: 'party', id, data: valuesToData(spec, values) });
    expect(again.ok && again.value.replayed).toBe(true);
  });

  it('offers a party only the types it can grow into: a role is added, never taken away', async () => {
    const books = await opened();
    const id = crypto.randomUUID();
    await books.execute({ op: 'create', kind: 'party', id, data: { name: 'V', roles: ['vendor'] } });
    const field = spec.fields.find((f) => f.key === 'roleType');
    if (!field) throw new Error('no roleType field');
    const saved = findMaster(books.masters, 'party', id);
    expect(optionsFor(field, books.masters, undefined, saved).map((o) => o.value)).toEqual(['vendor', 'both']);
    expect(optionsFor(field, books.masters).map((o) => o.value)).toEqual(['customer', 'vendor', 'both']);
  });

  it('puts a role problem on the Type field', () => {
    expect(issueField(spec, { code: IssueCode.UnsupportedOperation, message: 'x', path: 'roles' })).toBe('roleType');
    expect(issueField(spec, { code: IssueCode.OutOfRange, message: 'x', path: 'shipPincode' })).toBe('shipPincode');
  });
});

describe('the ledger form no longer makes customers and suppliers', () => {
  it('does not offer Sundry Debtors or Sundry Creditors, but still shows a group already stored', async () => {
    const books = await opened();
    const field = FORMS.ledger.fields.find((f) => f.key === 'groupId');
    if (!field) throw new Error('no groupId field');
    const offered = optionsFor(field, books.masters).map((o) => o.label);
    expect(offered).toContain('Indirect Expenses');
    expect(offered).not.toContain('Sundry Debtors');
    expect(offered).not.toContain('Sundry Creditors');
    const debtors = books.masters.groups.all.find((g) => g.name === 'Sundry Debtors');
    expect(labelOfRef(field, books.masters, debtors?.id ?? '')).toBe('Sundry Debtors');
  });

  it('keeps the link of an older ledger to its party when it is altered (the field is hidden, not dropped)', () => {
    const party = FORMS.ledger.fields.find((f) => f.key === 'partyId');
    expect(party?.visibleIf?.({})).toBe(false);
    expect(valuesToData(FORMS.ledger, { ...blankValues(FORMS.ledger), name: 'X', groupId: 'g', partyId: 'p1' })).toMatchObject({ partyId: 'p1' });
  });
});

describe('voucher pickers rank a party’s ledgers by what the voucher is about', () => {
  const choice = (id: string, partyId: string | undefined, partyRole: 'customer' | 'vendor' | undefined): LedgerChoice => ({ id, name: id, group: '', partyId, partyRole });
  const both = [choice('k-vendor', 'k', 'vendor'), choice('k-customer', 'k', 'customer')];

  it('a receipt puts the customer ledger first, a payment the vendor ledger', () => {
    expect(preferSiblings(both, preferredRole('receipt')).map((c) => c.id)).toEqual(['k-customer', 'k-vendor']);
    expect(preferSiblings([...both].reverse(), preferredRole('payment')).map((c) => c.id)).toEqual(['k-vendor', 'k-customer']);
  });

  it('a journal or contra has no preference, and other hits keep their order', () => {
    expect(preferredRole('journal')).toBeUndefined();
    expect(preferSiblings(both, undefined).map((c) => c.id)).toEqual(['k-vendor', 'k-customer']);
    const mixed = [choice('rent', undefined, undefined), ...both, choice('other', 'o', 'customer')];
    expect(preferSiblings(mixed, 'customer').map((c) => c.id)).toEqual(['rent', 'k-customer', 'k-vendor', 'other']);
  });

  it('never adds, drops or repeats a hit', () => {
    const hits = [choice('a', 'p', 'vendor'), choice('b', 'q', 'vendor'), choice('c', 'p', 'customer'), choice('d', undefined, undefined)];
    for (const prefer of ['customer', 'vendor', undefined] as const) {
      expect(preferSiblings(hits, prefer).map((c) => c.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    }
  });

  it('the choices carry the party and its side', async () => {
    const books = await opened();
    const id = crypto.randomUUID();
    await books.execute({ op: 'create', kind: 'party', id, data: { name: 'Both Co', roles: ['customer', 'vendor'] } });
    const mine = ledgerChoices(books.masters, 'particular').filter((c) => c.partyId === id);
    expect(mine.map((c) => [c.name, c.partyRole, c.group]).sort()).toEqual([
      ['Both Co (Vendor)', 'vendor', 'Sundry Creditors'],
      ['Both Co', 'customer', 'Sundry Debtors'],
    ].sort());
    expect(mine.map((c) => c.id).sort()).toEqual([partyLedgerId(id, 'customer'), partyLedgerId(id, 'vendor')].sort());
  });
});
