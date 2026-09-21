import { IssueCode, type Masters, trialBalance } from '@minimalerp/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { codesOf, mustOk } from '../helpers';
import type { MakeMasterWorld, MasterWorld } from '../masterWorld';

/**
 * What every MasterGateway (+ posting + repositories) must do about master data: validate, apply atomically,
 * refuse duplicates even under concurrency, keep built-ins locked, and protect anything the books already use.
 * The rules themselves are unit-tested in the domain; this proves each backend actually enforces them.
 */
export function masterContract(label: string, makeWorld: MakeMasterWorld): void {
  describe(`${label}: master data`, () => {
    let w: MasterWorld;
    beforeEach(async () => {
      w = await makeWorld();
    });

    const id = (name: string) => w.uuid(`new:${name}`);
    const group = (key: string) => w.uuid(`group:${key}`);
    const run = (op: 'create' | 'alter' | 'setActive', kind: string, recordId: string, data?: unknown, active?: boolean) =>
      w.backend.execute({
        companyId: w.companyId,
        command: { op, kind, id: recordId, ...(data === undefined ? {} : { data }), ...(active === undefined ? {} : { active }) },
      });
    const masters = (): Promise<Masters> => w.backend.load(w.companyId);
    const ledgerNamed = async (name: string) => (await masters()).ledgers.find((l) => l.name === name);

    /** An opening-balance voucher for a ledger, the way the UI posts it. */
    const opening = (ledgerId: string, side: 'debit' | 'credit', amount: string, voucherId = w.uuid(`opening:${ledgerId}`)) =>
      w.backend.post({
        companyId: w.companyId,
        draft: {
          id: voucherId,
          voucherTypeId: w.uuid('type:opening'),
          date: '2024-04-01',
          ledgerId,
          side,
          amount,
          offsetLedgerId: w.uuid('ledger:opening-difference'),
        },
      });

    describe('creating', () => {
      it('a created ledger is visible to the next load, with its normalised name', async () => {
        const out = mustOk(await run('create', 'ledger', id('rent'), { name: '  Rent   Paid ', groupId: group('indirect-expenses') }));
        expect(out).toMatchObject({ kind: 'ledger', op: 'create', id: id('rent'), name: 'Rent Paid', replayed: false });
        expect(await ledgerNamed('Rent Paid')).toMatchObject({ id: id('rent'), isActive: true });
      });

      it('creates every kind of master', async () => {
        mustOk(await run('create', 'group', id('g'), { name: 'Domestic Sales', parentId: group('sales-accounts') }));
        mustOk(await run('create', 'party', id('p'), { name: 'ABC Industries', phone: '9876543210', creditDays: 30 }));
        mustOk(await run('create', 'unit', id('u'), { symbol: 'Ton', name: 'Tonnes', decimals: 3, baseUnitId: w.uuid('unit:Kg'), factor: '1000' }));
        mustOk(await run('create', 'stockGroup', id('sg'), { name: 'Raw Material' }));
        mustOk(await run('create', 'warehouse', id('wh'), { name: 'Plant 2' }));
        mustOk(await run('create', 'stockItem', id('i'), { name: 'MS Sheet', unitId: id('u'), groupId: id('sg'), itemType: 'raw', hsn: '7208', gstRateId: w.uuid('gst:18') }));
        mustOk(await run('create', 'gstRate', id('r'), { name: 'GST 3%', ratePercent: '3', effectiveFrom: '2024-04-01' }));
        mustOk(await run('create', 'voucherType', id('vt'), { name: 'Petty Cash', baseKind: 'payment' }));
        const m = await masters();
        expect(m.groups.all.some((g) => g.name === 'Domestic Sales')).toBe(true);
        expect(m.parties.find((p) => p.id === id('p'))).toMatchObject({ name: 'ABC Industries', creditDays: 30 });
        expect(m.units.find((u) => u.id === id('u'))).toMatchObject({ symbol: 'Ton', factor: '1000' });
        expect(m.stockItems.find((i) => i.id === id('i'))).toMatchObject({ name: 'MS Sheet', hsn: '7208' });
        expect(m.warehouses.map((x) => x.name)).toContain('Plant 2');
        expect(m.gstRates.map((x) => x.name)).toContain('GST 3%');
        expect(m.voucherTypes.map((x) => x.name)).toContain('Petty Cash');
      });

      it('retrying the same create is a safe replay that changes nothing', async () => {
        const data = { name: 'Rent', groupId: group('indirect-expenses') };
        mustOk(await run('create', 'ledger', id('rent'), data));
        const before = (await masters()).ledgers.length;
        expect(mustOk(await run('create', 'ledger', id('rent'), data)).replayed).toBe(true);
        expect((await masters()).ledgers).toHaveLength(before);
      });

      it('the same id with different content is refused', async () => {
        mustOk(await run('create', 'ledger', id('rent'), { name: 'Rent', groupId: group('indirect-expenses') }));
        expect(codesOf(await run('create', 'ledger', id('rent'), { name: 'Other', groupId: group('indirect-expenses') }))).toEqual([
          IssueCode.MasterIdExists,
        ]);
      });

      it('refuses a duplicate name however it is spelled — ledgers and groups share one pool', async () => {
        mustOk(await run('create', 'ledger', id('a'), { name: 'Rent', groupId: group('indirect-expenses') }));
        expect(codesOf(await run('create', 'ledger', id('b'), { name: ' rent ', groupId: group('indirect-expenses') }))).toEqual([IssueCode.NameTaken]);
        expect(codesOf(await run('create', 'group', id('c'), { name: 'RENT', parentId: group('indirect-expenses') }))).toEqual([IssueCode.NameTaken]);
        expect(await ledgerNamed('Rent')).toBeDefined();
        expect((await masters()).ledgers.filter((l) => l.name.toLowerCase() === 'rent')).toHaveLength(1);
      });

      it('two simultaneous creates of the same name: exactly one wins', async () => {
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) => run('create', 'ledger', id(`race${i}`), { name: 'Racing Ledger', groupId: group('indirect-expenses') })),
        );
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        for (const r of results.filter((r) => !r.ok)) expect(codesOf(r)).toEqual([IssueCode.NameTaken]);
        expect((await masters()).ledgers.filter((l) => l.name === 'Racing Ledger')).toHaveLength(1);
      });

      it('a refused command leaves nothing behind', async () => {
        const before = await masters();
        mustOk(await run('create', 'ledger', id('ok'), { name: 'Fine', groupId: group('indirect-expenses') }));
        for (const bad of [
          run('create', 'ledger', id('x1'), { name: 'X', groupId: 'ghost' }),
          run('create', 'party', id('x2'), { name: 'Y', gstin: 'nope' }),
          run('create', 'stockItem', id('x3'), { name: 'Z', unitId: 'ghost', itemType: 'raw' }),
        ]) {
          expect((await bad).ok).toBe(false);
        }
        const after = await masters();
        expect(after.ledgers).toHaveLength(before.ledgers.length + 1);
        expect(after.parties).toHaveLength(before.parties.length);
        expect(after.stockItems).toHaveLength(before.stockItems.length);
      });

      it('refuses a command for another company', async () => {
        const r = await w.backend.execute({ companyId: w.uuid('someone-else') as never, command: { op: 'create', kind: 'unit', id: id('u'), data: { symbol: 'X', name: 'X' } } });
        expect(codesOf(r)).toEqual([IssueCode.CompanyMismatch]);
      });
    });

    describe('altering and deactivating', () => {
      it('alter changes the record, and refuses a name another ledger holds', async () => {
        mustOk(await run('create', 'ledger', id('a'), { name: 'Alpha', groupId: group('sundry-debtors') }));
        mustOk(await run('create', 'ledger', id('b'), { name: 'Beta', groupId: group('sundry-debtors') }));
        mustOk(await run('alter', 'ledger', id('a'), { name: 'Alpha Two', groupId: group('sundry-debtors') }));
        expect(await ledgerNamed('Alpha Two')).toBeDefined();
        expect(await ledgerNamed('Alpha')).toBeUndefined();
        expect(codesOf(await run('alter', 'ledger', id('a'), { name: 'beta', groupId: group('sundry-debtors') }))).toEqual([IssueCode.NameTaken]);
        expect(await ledgerNamed('Alpha Two')).toBeDefined();
      });

      it('deactivate and reactivate, idempotently', async () => {
        mustOk(await run('create', 'ledger', id('t'), { name: 'Temp', groupId: group('sundry-debtors') }));
        mustOk(await run('setActive', 'ledger', id('t'), undefined, false));
        expect((await ledgerNamed('Temp'))?.isActive).toBe(false);
        mustOk(await run('setActive', 'ledger', id('t'), undefined, false));
        mustOk(await run('setActive', 'ledger', id('t'), undefined, true));
        expect((await ledgerNamed('Temp'))?.isActive).toBe(true);
      });

      it('built-in masters are locked', async () => {
        const diff = w.uuid('ledger:opening-difference');
        expect(codesOf(await run('alter', 'ledger', diff, { name: 'Renamed', groupId: group('suspense') }))).toEqual([IssueCode.SystemMasterLocked]);
        expect(codesOf(await run('setActive', 'ledger', diff, undefined, false))).toEqual([IssueCode.SystemMasterLocked]);
        expect(codesOf(await run('setActive', 'group', group('sales-accounts'), undefined, false))).toEqual([IssueCode.SystemMasterLocked]);
        expect(codesOf(await run('alter', 'voucherType', w.uuid('type:payment'), { name: 'Pay', baseKind: 'payment' }))).toEqual([IssueCode.SystemMasterLocked]);
      });

      it('cannot deactivate something that still has active dependents', async () => {
        mustOk(await run('create', 'party', id('p'), { name: 'ABC' }));
        mustOk(await run('create', 'ledger', id('l'), { name: 'ABC (Dr)', groupId: group('sundry-debtors'), partyId: id('p') }));
        expect(codesOf(await run('setActive', 'party', id('p'), undefined, false))).toEqual([IssueCode.HasDependents]);
        mustOk(await run('create', 'stockItem', id('i'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'raw' }));
        expect(codesOf(await run('setActive', 'unit', w.uuid('unit:Nos'), undefined, false))).toEqual([IssueCode.HasDependents]);
      });

      it('alters the company profile, validating the GSTIN', async () => {
        const company = (await masters()).company;
        mustOk(await run('alter', 'company', company.id, { name: 'Acme Works Pvt Ltd', address: '12 MG Road' }));
        expect((await masters()).company).toMatchObject({ name: 'Acme Works Pvt Ltd', address: '12 MG Road' });
        expect(codesOf(await run('alter', 'company', company.id, { name: 'Acme', gstin: 'bogus' }))).toEqual([IssueCode.InvalidGstin]);
        expect((await masters()).company.name).toBe('Acme Works Pvt Ltd');
      });
    });

    describe('opening balances', () => {
      it('posts through the normal posting path, offset to Opening Balance Difference, numbered OB/0001', async () => {
        mustOk(await run('create', 'ledger', id('bank'), { name: 'HDFC Bank', groupId: group('bank-accounts') }));
        const out = mustOk(await opening(id('bank'), 'debit', '50000.00'));
        expect(out.voucher.number).toBe('OB/0001');
        expect(out.plan.journal.map((l) => [l.ledgerId, l.side, l.amount])).toEqual([
          [id('bank'), 'debit', 5_000_000n],
          [w.uuid('ledger:opening-difference'), 'credit', 5_000_000n],
        ]);
      });

      it('the difference ledger holds exactly the gap, and the books still balance', async () => {
        mustOk(await run('create', 'ledger', id('bank'), { name: 'HDFC Bank', groupId: group('bank-accounts') }));
        mustOk(await run('create', 'ledger', id('cap'), { name: 'Capital', groupId: group('capital-account') }));
        mustOk(await opening(id('bank'), 'debit', '50000.00'));
        mustOk(await opening(id('cap'), 'credit', '30000.00'));
        const lines = await w.backend.lines({ companyId: w.companyId });
        const tb = trialBalance(lines);
        expect(tb.isBalanced).toBe(true);
        const gap = tb.rows.find((r) => r.ledgerId === w.uuid('ledger:opening-difference'));
        expect(gap?.closing).toBe(-2_000_000n); // 20,000.00 short on the credit side: a credit balance of the gap
      });

      it('retrying the same opening voucher is a replay: no second entry', async () => {
        mustOk(await run('create', 'ledger', id('bank'), { name: 'HDFC Bank', groupId: group('bank-accounts') }));
        mustOk(await opening(id('bank'), 'debit', '100.00'));
        expect(mustOk(await opening(id('bank'), 'debit', '100.00')).replayed).toBe(true);
        expect(await w.backend.lines({ companyId: w.companyId })).toHaveLength(2);
      });

      it('is refused for the wrong date, the wrong offset ledger, or the built-in ledger', async () => {
        mustOk(await run('create', 'ledger', id('bank'), { name: 'HDFC Bank', groupId: group('bank-accounts') }));
        const draft = (over: Record<string, unknown>) =>
          w.backend.post({
            companyId: w.companyId,
            draft: { id: id('v'), voucherTypeId: w.uuid('type:opening'), date: '2024-04-01', ledgerId: id('bank'), side: 'debit', amount: '10', offsetLedgerId: w.uuid('ledger:opening-difference'), ...over },
          });
        expect(codesOf(await draft({ date: '2024-05-01' }))).toEqual([IssueCode.OpeningInvalid]);
        expect(codesOf(await draft({ offsetLedgerId: w.uuid('ledger:cash') }))).toContain(IssueCode.OpeningInvalid);
        expect(codesOf(await draft({ ledgerId: w.uuid('ledger:opening-difference') }))).toContain(IssueCode.OpeningInvalid);
        expect(await w.backend.lines({ companyId: w.companyId })).toHaveLength(0);
      });
    });

    describe('protecting what the books already use', () => {
      it('a ledger with entries keeps its nature (asset → asset is fine, asset → expense is refused)', async () => {
        mustOk(await run('create', 'ledger', id('petty'), { name: 'Petty Cash', groupId: group('cash-in-hand') }));
        mustOk(await opening(id('petty'), 'debit', '1000'));
        mustOk(await run('alter', 'ledger', id('petty'), { name: 'Petty Cash', groupId: group('bank-accounts') }));
        expect(codesOf(await run('alter', 'ledger', id('petty'), { name: 'Petty Cash', groupId: group('indirect-expenses') }))).toEqual([IssueCode.NatureLocked]);
        expect((await ledgerNamed('Petty Cash'))?.groupId).toBe(group('bank-accounts'));
      });

      it('a numbering series in use cannot restart from a different number', async () => {
        mustOk(await run('create', 'ledger', id('bank'), { name: 'HDFC Bank', groupId: group('bank-accounts') }));
        mustOk(await opening(id('bank'), 'debit', '1'));
        const s = (await masters()).series.find((x) => x.voucherTypeId === w.uuid('type:opening'))!;
        const data = { voucherTypeId: s.voucherTypeId, financialYearId: s.financialYearId, prefix: 'OP/', suffix: '', width: 4, startAt: 1 };
        mustOk(await run('alter', 'numberingSeries', s.id, data));
        expect(codesOf(await run('alter', 'numberingSeries', s.id, { ...data, startAt: 500 }))).toEqual([IssueCode.InUse]);
      });

      it('a voucher type nobody has used yet may still change its base kind', async () => {
        mustOk(await run('create', 'voucherType', id('vt'), { name: 'Custom Payment', baseKind: 'payment' }));
        expect((await run('alter', 'voucherType', id('vt'), { name: 'Custom Payment', baseKind: 'receipt' })).ok).toBe(true); // unused: free
      });
    });

    describe('a party and its ledgers', () => {
      const partyLedgers = async (partyId: string) => (await masters()).ledgers.filter((l) => l.partyId === partyId);
      const nameOf = async (ledgerId: string) => (await masters()).ledgers.find((l) => l.id === ledgerId)?.name;

      it('creating a party makes its ledger(s) in the same step, and reports them', async () => {
        const out = mustOk(await run('create', 'party', id('both'), { name: 'Kumar Works', roles: ['customer', 'vendor'], stateCode: '27', pincode: '411026', shipping: { lines: 'Godown', pincode: '410501' } }));
        expect(out).toMatchObject({ kind: 'party', op: 'create', id: id('both'), name: 'Kumar Works', replayed: false });
        const ledgers = await partyLedgers(id('both'));
        expect(ledgers.map((l) => [l.name, l.partyRole, l.groupId]).sort()).toEqual(
          [
            ['Kumar Works', 'customer', group('sundry-debtors')],
            ['Kumar Works (Vendor)', 'vendor', group('sundry-creditors')],
          ].sort(),
        );
        expect(out.created.map((c) => c.name).sort()).toEqual(['Kumar Works', 'Kumar Works (Vendor)']);
        const party = (await masters()).parties.find((p) => p.id === id('both'));
        expect(party).toMatchObject({ roles: ['customer', 'vendor'], pincode: '411026', shipping: { lines: 'Godown', pincode: '410501' } });
      });

      it('repeating the command is a replay: nothing new', async () => {
        mustOk(await run('create', 'party', id('p'), { name: 'Steel Co', roles: ['vendor'] }));
        const again = mustOk(await run('create', 'party', id('p'), { name: 'Steel Co', roles: ['vendor'] }));
        expect(again).toMatchObject({ replayed: true, created: [] });
        expect(await partyLedgers(id('p'))).toHaveLength(1);
      });

      it('a party whose ledger name is taken is refused whole: no party, no ledger', async () => {
        mustOk(await run('create', 'ledger', id('rent'), { name: 'Steel Co (Vendor)', groupId: group('indirect-expenses') }));
        const before = await masters();
        expect(codesOf(await run('create', 'party', id('p2'), { name: 'Steel Co', roles: ['customer', 'vendor'] }))).toEqual([IssueCode.NameTaken]);
        const after = await masters();
        expect(after.parties).toHaveLength(before.parties.length);
        expect(after.ledgers).toHaveLength(before.ledgers.length);
      });

      it('two simultaneous creates of the same party name: exactly one wins, with one set of ledgers', async () => {
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) => run('create', 'party', id(`race${i}`), { name: 'Racing Party', roles: ['customer', 'vendor'] })),
        );
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        for (const r of results.filter((r) => !r.ok)) expect(codesOf(r)).toEqual([IssueCode.NameTaken]);
        expect((await masters()).ledgers.filter((l) => l.name.startsWith('Racing Party'))).toHaveLength(2);
      });

      it('a vendor who becomes a customer too: the vendor ledger keeps its identity and takes the (Vendor) name', async () => {
        mustOk(await run('create', 'party', id('v'), { name: 'Steel Co', roles: ['vendor'] }));
        const vendorLedger = (await partyLedgers(id('v')))[0]?.id ?? '';
        mustOk(await run('alter', 'party', id('v'), { name: 'Steel Co', roles: ['customer', 'vendor'] }));
        expect(await nameOf(vendorLedger)).toBe('Steel Co (Vendor)');
        expect((await partyLedgers(id('v'))).map((l) => l.name).sort()).toEqual(['Steel Co', 'Steel Co (Vendor)']);
      });

      it('renaming and deactivating the party carry to its ledgers; a role cannot be dropped', async () => {
        mustOk(await run('create', 'party', id('r'), { name: 'Old Name', roles: ['customer'] }));
        mustOk(await run('alter', 'party', id('r'), { name: 'New Name', roles: ['customer'] }));
        expect((await partyLedgers(id('r'))).map((l) => l.name)).toEqual(['New Name']);
        expect(codesOf(await run('alter', 'party', id('r'), { name: 'New Name', roles: ['vendor'] }))).toEqual([IssueCode.UnsupportedOperation]);
        mustOk(await run('setActive', 'party', id('r'), undefined, false));
        expect((await partyLedgers(id('r'))).map((l) => l.isActive)).toEqual([false]);
        mustOk(await run('setActive', 'party', id('r'), undefined, true));
        expect((await partyLedgers(id('r'))).map((l) => l.isActive)).toEqual([true]);
      });

      it('a party’s ledger cannot be edited or deactivated on its own', async () => {
        mustOk(await run('create', 'party', id('own'), { name: 'Owned', roles: ['customer'] }));
        const ledger = (await partyLedgers(id('own')))[0];
        expect(codesOf(await run('alter', 'ledger', ledger?.id ?? '', { name: 'Hacked', groupId: group('sundry-debtors'), partyId: id('own'), partyRole: 'customer' }))).toContain(IssueCode.UnsupportedOperation);
        expect(codesOf(await run('setActive', 'ledger', ledger?.id ?? '', undefined, false))).toEqual([IssueCode.UnsupportedOperation]);
      });

      it('an opening balance and a voucher post to the ledger the party made', async () => {
        mustOk(await run('create', 'party', id('op'), { name: 'ABC Industries', roles: ['customer'] }));
        const ledger = (await partyLedgers(id('op')))[0];
        mustOk(await opening(ledger?.id ?? '', 'debit', '5000'));
        const tb = trialBalance(await w.backend.lines({ companyId: w.companyId }));
        expect(tb.rows.find((r) => r.ledgerId === ledger?.id)).toBeDefined();
      });
    });
  });
}
