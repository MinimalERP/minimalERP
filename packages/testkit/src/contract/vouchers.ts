import { IssueCode, type Masters } from '@minimalerp/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { codesOf, mustOk } from '../helpers';
import type { MakeMasterWorld, MasterWorld } from '../masterWorld';

/**
 * Phase 5 on every backend: bill-wise details and the party-details snapshot travel with a voucher through post, replay, alter and
 * cancel, are validated by the same rules, and never change the journal; a party's registration type and address book round-trip.
 */
export function voucherDetailsContract(label: string, makeWorld: MakeMasterWorld): void {
  describe(`${label}: bill-wise details, party details and the address book`, () => {
    let w: MasterWorld;
    beforeEach(async () => {
      w = await makeWorld();
      const seed = async (kind: string, id: string, data: unknown) =>
        mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
      await seed('party', w.uuid('p:steel'), { name: 'Steel Supplies', gstin: '24AAACC1206D1ZM'.slice(0, 14) + gstinCheck('24AAACC1206D1Z'), gstRegistration: 'regular' });
      await seed('ledger', w.uuid('l:bank'), { name: 'HDFC', groupId: w.uuid('group:bank-accounts') });
      await seed('ledger', w.uuid('l:steel'), { name: 'Steel Supplies', groupId: w.uuid('group:sundry-creditors'), partyId: w.uuid('p:steel') });
      await seed('ledger', w.uuid('l:rent'), { name: 'Rent', groupId: w.uuid('group:indirect-expenses') });
    });

    const L = (n: string) => w.uuid(`l:${n}`);
    const type = (kind: string) => w.uuid(`type:${kind}`);
    const payment = (id: string, over: Record<string, unknown> = {}) => ({
      id: w.uuid(`v:${id}`),
      voucherTypeId: type('payment'),
      date: '2024-05-10',
      accountLedgerId: L('bank'),
      lines: [{ ledgerId: L('steel'), amount: '1000', allocations: [{ kind: 'new', ref: 'PO-1', dueDate: '2024-06-15', amount: '1000' }] }],
      ...over,
    });
    const post = (draft: unknown) => w.backend.post({ companyId: w.companyId, draft });
    const lines = () => w.backend.lines({ companyId: w.companyId });
    interface Content {
      lines: { allocations: { kind: string; ref: string; dueDate?: string }[] }[];
      allocations: { ref: string }[];
      partyDetails: object;
    }
    const contentOf = async (id: string) => (await w.backend.get(w.companyId, w.uuid(`v:${id}`) as never))?.content as unknown as Content;

    it('posts a payment carrying bill-wise parts; the content keeps them and the journal is exactly the plain one', async () => {
      mustOk(await post(payment('a')));
      const c = await contentOf('a');
      expect(c.lines[0]?.allocations[0]).toMatchObject({ kind: 'new', ref: 'PO-1', dueDate: '2024-06-15' });
      expect((await lines()).map((l) => [l.ledgerId, l.side, l.amount])).toEqual([
        [L('steel'), 'debit', 100000n],
        [L('bank'), 'credit', 100000n],
      ]);
    });

    it('keeps the party details snapshot, and a replay of the same voucher is a replay', async () => {
      const draft = payment('b', {
        partyDetails: {
          partyId: w.uuid('p:steel'),
          mailingName: 'Steel Supplies Pvt Ltd',
          billTo: { lines: 'GIDC Vatva, Ahmedabad', stateCode: '24', country: 'India' },
          shipTo: { name: 'Steel — Unit 2', lines: 'Sanand', stateCode: '24' },
          gstRegistration: 'regular',
          gstin: '24AAACC1206D1Z' + gstinCheck('24AAACC1206D1Z'),
          placeOfSupply: '24',
        },
      });
      const first = mustOk(await post(draft));
      const c = await contentOf('b');
      expect(c.partyDetails).toMatchObject({ mailingName: 'Steel Supplies Pvt Ltd', shipTo: { name: 'Steel — Unit 2' }, placeOfSupply: '24' });
      expect(first.replayed).toBe(false);
      expect(mustOk(await post(draft)).replayed).toBe(true);
      expect(await lines()).toHaveLength(2);
    });

    it('refuses parts that do not add up, bill details on a non-party ledger, and a wrong GSTIN — with the same codes everywhere', async () => {
      expect(codesOf(await post(payment('c', { lines: [{ ledgerId: L('steel'), amount: '1000', allocations: [{ kind: 'new', ref: 'X', amount: '900' }] }] })))).toEqual([IssueCode.AllocationInvalid]);
      expect(codesOf(await post(payment('d', { lines: [{ ledgerId: L('rent'), amount: '10', allocations: [{ kind: 'new', ref: 'X', amount: '10' }] }] })))).toEqual([IssueCode.AllocationInvalid]);
      expect(codesOf(await post(payment('e', { partyDetails: { gstin: '24AAACC1206D1ZA' } })))).toEqual([IssueCode.InvalidGstin]);
      expect(codesOf(await post(payment('f', { partyDetails: { partyId: w.uuid('nobody') } })))).toEqual([IssueCode.PartyDetailsInvalid]);
      expect(await lines()).toHaveLength(0); // nothing was posted
    });

    it('alter replaces the bill-wise parts; cancel keeps the voucher but takes it out of the books', async () => {
      const v = mustOk(await post(payment('g')));
      const altered = mustOk(
        await w.backend.alter({
          companyId: w.companyId,
          voucherId: v.voucher.id,
          expectedVersion: 1,
          draft: payment('g', { lines: [{ ledgerId: L('steel'), amount: '1000', allocations: [{ kind: 'new', ref: 'PO-2', amount: '1000' }] }] }),
        }),
      );
      expect(altered.voucher.version).toBe(2);
      expect((await contentOf('g')).lines[0]?.allocations[0]?.ref).toBe('PO-2');
      mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: v.voucher.id, expectedVersion: 2 }));
      expect(await lines()).toHaveLength(0);
    });

    it('an opening balance can carry its bills too', async () => {
      mustOk(
        await post({
          id: w.uuid('v:ob'),
          voucherTypeId: type('opening'),
          date: '2024-04-01',
          ledgerId: L('steel'),
          side: 'credit',
          amount: '5000',
          offsetLedgerId: w.uuid('ledger:opening-difference'),
          allocations: [{ kind: 'new', ref: 'OB-1', dueDate: '2024-04-30', amount: '5000' }],
        }),
      );
      expect((await contentOf('ob')).allocations[0]?.ref).toBe('OB-1');
    });

    it('a party keeps its GST registration type and saved addresses (and they survive a profile change)', async () => {
      const partyId = w.uuid('p:steel');
      const alter = (data: unknown) => w.backend.execute({ companyId: w.companyId, command: { op: 'alter', kind: 'party', id: partyId, data: { name: 'Steel Supplies', ...(data as object) } } });
      mustOk(await alter({ gstRegistration: 'composition', addresses: [{ id: 'a1', label: 'Head office', lines: 'Vatva', stateCode: '24' }, { id: 'a2', label: 'Unit 2', lines: 'Sanand', pincode: '382110' }] }));
      const party = (m: Masters) => m.parties.find((p) => p.id === partyId);
      let p = party(await w.backend.load(w.companyId));
      expect(p?.gstRegistration).toBe('composition');
      expect(p?.addresses?.map((a) => a.label)).toEqual(['Head office', 'Unit 2']);
      expect(p?.addresses?.[1]).toMatchObject({ lines: 'Sanand', pincode: '382110' });
      mustOk(await alter({ phone: '9820012345' })); // the form never sends the book: it must be kept
      p = party(await w.backend.load(w.companyId));
      expect(p?.addresses).toHaveLength(2);
      expect(p?.phone).toBe('9820012345');
    });
  });
}

/** The check character for a 14-character GSTIN prefix (mirrors the domain rule; kept local so this file needs only the public API). */
function gstinCheck(prefix14: string): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(prefix14.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return chars.charAt((36 - (sum % 36)) % 36);
}
