/**
 * The in-memory backend against the full contract, plus the checks that only apply to it
 * or that are pure domain logic (no backend involved).
 */
import { MemoryBackend, assertCommitInvariants } from '@minimalerp/adapter-memory';
import {
  type JournalLine,
  IssueCode,
  VoucherKindRegistry,
  asCompanyId,
  asLedgerId,
  asVoucherId,
  checkPlanInvariants,
  defaultVoucherKinds,
  ledgerMovements,
  localDate,
  money,
  paymentKind,
  prepareVoucher,
  receiptKind,
  totalsOf,
} from '@minimalerp/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbSpec, scenarioFrom } from './arbitraries';
import { backendContract, gstContract, masterContract, purchaseContract, salesContract, stockContract, voucherDetailsContract } from './contract';
import { mustOk, postOk } from './helpers';
import { expectedBalances, payment } from './scenarios';
import { buildMasterWorld, seedForWorld } from './masterWorld';
import { buildDemoWorld } from './world';

backendContract('memory', (opts) => buildDemoWorld(opts), { runs: 150, sequenceRuns: 100 });
masterContract('memory', buildMasterWorld);
voucherDetailsContract('memory', buildMasterWorld);
stockContract('memory', buildMasterWorld);
salesContract('memory', buildMasterWorld);
purchaseContract('memory', buildMasterWorld);
gstContract('memory', buildMasterWorld);

describe('pure domain properties (no backend)', () => {
  const w0 = buildDemoWorld();
  const closings = (lines: readonly JournalLine[]) => {
    const m = new Map<string, bigint>();
    for (const [id, mv] of ledgerMovements(lines)) if (mv.closing !== 0n) m.set(id, mv.closing);
    return m;
  };

  it('a valid voucher always yields a balanced, correct posting plan', () => {
    fc.assert(
      fc.property(arbSpec(), (spec) => {
        const sc = scenarioFrom(w0, spec, 'v1');
        const lines = mustOk(prepareVoucher(sc.voucher, w0.masters, defaultVoucherKinds())).plan.journal;

        const { debit, credit } = totalsOf(lines);
        expect(debit).toBe(credit);
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(lines.every((l) => l.amount > 0n)).toBe(true);
        expect(lines.map((l) => l.lineNo)).toEqual(lines.map((_, i) => i + 1));
        expect(closings(lines)).toEqual(expectedBalances([sc]));
      }),
      { numRuns: 150 },
    );
  });

  it('is deterministic: the same draft always yields the identical plan', () => {
    fc.assert(
      fc.property(arbSpec(), (spec) => {
        const sc = scenarioFrom(w0, spec, 'v1');
        const a = mustOk(prepareVoucher(sc.voucher, w0.masters, defaultVoucherKinds()));
        const b = mustOk(prepareVoucher(sc.voucher, w0.masters, defaultVoucherKinds()));
        expect(a.plan).toEqual(b.plan);
      }),
      { numRuns: 150 },
    );
  });
});

const line = (voucher: string, no: number, side: 'debit' | 'credit', amount: bigint): JournalLine => ({
  voucherId: asVoucherId(voucher),
  lineNo: no,
  date: localDate('2024-05-01'),
  ledgerId: asLedgerId('l'),
  side,
  amount: money(amount),
});

describe('checkPlanInvariants', () => {
  it('accepts a balanced two-line plan', () => {
    expect(checkPlanInvariants({ journal: [line('v', 1, 'debit', 100n), line('v', 2, 'credit', 100n)], stock: [], links: [] })).toEqual([]);
  });

  it('refuses fewer than two lines', () => {
    const codes = checkPlanInvariants({ journal: [line('v', 1, 'debit', 100n)], stock: [], links: [] }).map((i) => i.code);
    expect(codes).toContain(IssueCode.PlanTooFewLines);
    expect(codes).toContain(IssueCode.PlanUnbalanced);
  });

  it('refuses an unbalanced plan by a single paisa', () => {
    const codes = checkPlanInvariants({ journal: [line('v', 1, 'debit', 100n), line('v', 2, 'credit', 99n)], stock: [], links: [] }).map((i) => i.code);
    expect(codes).toEqual([IssueCode.PlanUnbalanced]);
  });

  it.each([0n, -5n])('refuses a non-positive amount (%s)', (amount) => {
    const codes = checkPlanInvariants({ journal: [line('v', 1, 'debit', amount), line('v', 2, 'credit', amount)], stock: [], links: [] }).map((i) => i.code);
    expect(codes).toContain(IssueCode.PlanNonPositiveAmount);
  });

  it('refuses lines that mix vouchers or are not numbered 1..n', () => {
    expect(checkPlanInvariants({ journal: [line('a', 1, 'debit', 5n), line('b', 2, 'credit', 5n)], stock: [], links: [] }).map((i) => i.code)).toEqual([
      IssueCode.PlanInconsistentLines,
    ]);
    expect(checkPlanInvariants({ journal: [line('a', 1, 'debit', 5n), line('a', 3, 'credit', 5n)], stock: [], links: [] }).map((i) => i.code)).toEqual([
      IssueCode.PlanInconsistentLines,
    ]);
  });
});

describe('assertCommitInvariants — the memory backend’s last line of defence (the DB trigger has its own tests)', () => {
  it('passes balanced vouchers, including several at once', () => {
    expect(
      assertCommitInvariants([
        line('a', 1, 'debit', 10n),
        line('a', 2, 'credit', 10n),
        line('b', 1, 'debit', 7n),
        line('b', 2, 'credit', 3n),
        line('b', 3, 'credit', 4n),
      ]),
    ).toEqual([]);
  });

  it('flags the one voucher that is out of balance even when the grand total balances', () => {
    const problems = assertCommitInvariants([
      line('a', 1, 'debit', 10n),
      line('a', 2, 'credit', 9n),
      line('b', 1, 'debit', 1n),
      line('b', 2, 'credit', 2n),
    ]);
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.code === IssueCode.PlanUnbalanced)).toBe(true);
  });

  it('flags non-positive amounts', () => {
    expect(assertCommitInvariants([line('a', 1, 'debit', 0n), line('a', 2, 'credit', 0n)]).map((p) => p.code)).toContain(
      IssueCode.PlanNonPositiveAmount,
    );
  });
});

describe('voucher kind registry', () => {
  it('refuses to register two kinds for the same base', () => {
    const r = new VoucherKindRegistry().register(paymentKind);
    expect(() => r.register(paymentKind)).toThrow(/already registered/);
  });

  it('lists what is registered', () => {
    const r = new VoucherKindRegistry().register(paymentKind).register(receiptKind);
    expect(r.list().map((k) => k.base)).toEqual(['payment', 'receipt']);
    expect(r.get('journal')).toBeUndefined();
  });
});

describe('memory backend specifics', () => {
  it('stores the parsed draft (money as bigint) as the voucher content', async () => {
    const w = buildDemoWorld();
    const out = await postOk(w, payment(w, { id: 'p1', date: '2024-05-10', account: w.ledgers.bank, lines: [[w.ledgers.rent, '12.34']] }));
    const lines = (out.voucher.content as unknown as { lines: { amount: bigint }[] }).lines;
    expect(lines[0]?.amount).toBe(1234n);
  });
});

describe('memory backend change log', () => {
  const setup = async () => {
    const { masters, uuid } = seedForWorld();
    const companyId = asCompanyId(masters.company.id);
    const live = new MemoryBackend(masters, defaultVoucherKinds());
    const cmd = (command: unknown) => live.execute({ companyId, command });
    mustOk(await cmd({ op: 'create', kind: 'ledger', id: uuid('n:bank'), data: { name: 'HDFC Bank', groupId: uuid('group:bank-accounts') } }));
    mustOk(await cmd({ op: 'create', kind: 'party', id: uuid('n:abc'), data: { name: 'ABC Industries' } }));
    mustOk(
      await live.post({
        companyId,
        draft: { id: uuid('v:ob'), voucherTypeId: uuid('type:opening'), date: '2024-04-01', ledgerId: uuid('n:bank'), side: 'debit', amount: '750.00', offsetLedgerId: uuid('ledger:opening-difference') },
      }),
    );
    return { masters, uuid, companyId, live };
  };

  it('replaying the log into a fresh backend reproduces the same masters, vouchers and numbers', async () => {
    const { masters, companyId, live } = await setup();
    const copy = new MemoryBackend(masters, defaultVoucherKinds());
    mustOk(await copy.replay(live.changes()));
    expect((await copy.load(companyId)).ledgers.map((l) => l.name)).toEqual((await live.load(companyId)).ledgers.map((l) => l.name));
    expect((await copy.load(companyId)).parties).toHaveLength(1);
    expect((await copy.list(companyId)).map((v) => [v.id, v.number])).toEqual((await live.list(companyId)).map((v) => [v.id, v.number]));
    expect(await copy.lines({ companyId })).toEqual(await live.lines({ companyId }));
  });

  it('records only changes that happened — not refusals and not safe retries', async () => {
    const { uuid, companyId, live } = await setup();
    const before = live.changes().length;
    await live.execute({ companyId, command: { op: 'create', kind: 'party', id: uuid('n:abc'), data: { name: 'ABC Industries' } } }); // replay
    await live.execute({ companyId, command: { op: 'create', kind: 'party', id: uuid('n:dup'), data: { name: 'abc industries' } } }); // refused
    expect(live.changes()).toHaveLength(before);
  });

  it('tells listeners about each change, and stops after unsubscribe', async () => {
    const { uuid, companyId, live } = await setup();
    const seen: string[] = [];
    const off = live.onChange((e) => seen.push(e.type));
    await live.execute({ companyId, command: { op: 'create', kind: 'unit', id: uuid('n:u1'), data: { symbol: 'Cm', name: 'Cm' } } });
    off();
    await live.execute({ companyId, command: { op: 'create', kind: 'unit', id: uuid('n:u2'), data: { symbol: 'Mm', name: 'Mm' } } });
    expect(seen).toEqual(['master']);
  });

  it('refuses to replay a log that does not match its starting point', async () => {
    const { live } = await setup();
    const other = seedForWorld();
    const stranger = new MemoryBackend(other.masters, defaultVoucherKinds());
    const r = await stranger.replay(live.changes());
    expect(r.ok).toBe(false);
  });
});
