/**
 * PHASE 2 EXIT GATE: "parallel numbering".
 * Real simultaneous connections racing on one company: numbering must stay gapless and unique,
 * one voucher id must yield one voucher, stale writers must lose cleanly, and nothing may deadlock.
 */
import { IssueCode, type Result, trialBalance } from '@minimalerp/domain';
import { PostgresBackend } from '@minimalerp/adapter-postgres';
import { allLines, journal, mustOk, payment } from '@minimalerp/testkit';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgWorld, pgWorldFactory } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let make: ReturnType<typeof pgWorldFactory>;

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  make = pgWorldFactory(db);
});
afterAll(async () => {
  await db?.close();
});

const seqOf = (number: string) => Number(number.slice(number.lastIndexOf('/') + 1));
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const okOf = <T>(rs: Result<T>[]) => rs.filter((r) => r.ok).length;
const codes = (r: Result<unknown>) => (r.ok ? [] : r.issues.map((i) => i.code));

// A separate service instance per request, exactly as the Edge Function creates them.
const service = (w: PgWorld) => new PostgresBackend(db.pool, { actorId: w.ownerId });

const pay = (w: PgWorld, id: string, amount = '1', date = '2024-05-10') =>
  payment(w, { id, date, account: w.ledgers.bank, lines: [[w.ledgers.rent, amount]] });

describe('numbering under parallel posting', () => {
  it('60 simultaneous posts get 60 distinct, gapless numbers', async () => {
    const w = await make();
    const N = 60;
    const results = await Promise.all(
      range(N).map((i) => service(w).post({ companyId: w.companyId, draft: pay(w, `c${i}`).voucher })),
    );

    expect(okOf(results)).toBe(N);
    const numbers = results.map((r) => (r.ok ? seqOf(r.value.voucher.number) : -1)).sort((x, y) => x - y);
    expect(numbers).toEqual(range(N).map((i) => i + 1)); // exactly 1..N: no gaps, no duplicates

    const tb = trialBalance(await allLines(w));
    expect(tb.isBalanced).toBe(true);
    expect(tb.totalClosingDebit).toBe(BigInt(N) * 100n);
  });

  it('is independent per voucher type and financial year, all racing at once', async () => {
    const w = await make();
    const drafts = [
      ...range(15).map((i) => pay(w, `p${i}`)),
      ...range(15).map((i) => journal(w, { id: `j${i}`, date: '2024-05-10', entries: [[w.ledgers.rent, 'debit', '1'], [w.ledgers.creditor, 'credit', '1']] })),
      ...range(15).map((i) => pay(w, `n${i}`, '1', '2025-04-05')), // next financial year
    ];
    const results = await Promise.all(drafts.map((d) => service(w).post({ companyId: w.companyId, draft: d.voucher })));
    expect(okOf(results)).toBe(45);

    const groups = new Map<string, number[]>();
    for (const r of results) {
      if (!r.ok) continue;
      const prefix = r.value.voucher.number.slice(0, r.value.voucher.number.lastIndexOf('/') + 1);
      groups.set(prefix, [...(groups.get(prefix) ?? []), seqOf(r.value.voucher.number)]);
    }
    expect([...groups.keys()].sort()).toEqual(['JRN/24-25/', 'PAY/24-25/', 'PAY/25-26/']);
    for (const seq of groups.values()) {
      expect(seq.sort((x, y) => x - y)).toEqual(range(15).map((i) => i + 1));
    }
  });

  it('refused postings never consume a number, even when racing with successful ones', async () => {
    const w = await make();
    const good = range(20).map((i) => pay(w, `g${i}`));
    const bad = range(20).map((i) =>
      journal(w, { id: `b${i}`, date: '2024-05-10', entries: [[w.ledgers.rent, 'debit', '2'], [w.ledgers.creditor, 'credit', '1']] }),
    );
    // interleave good and bad
    const mixed = good.flatMap((g, i) => [g, bad[i]!]);
    const results = await Promise.all(mixed.map((d) => service(w).post({ companyId: w.companyId, draft: d.voucher })));

    expect(okOf(results)).toBe(20);
    const paymentNumbers = results
      .filter((r) => r.ok)
      .map((r) => (r.ok ? seqOf(r.value.voucher.number) : 0))
      .sort((x, y) => x - y);
    expect(paymentNumbers).toEqual(range(20).map((i) => i + 1));
  });

  it('numbers wider than the configured width are never truncated', async () => {
    const w = await make();
    // width is 4; jump the counter so we cross the 4-digit boundary
    await db.pool.query(
      `update public.numbering_series set next_value = 9999 where company_id = $1 and voucher_type_id = $2 and financial_year_id = $3`,
      [w.companyId, w.types.payment, w.fy2425.id],
    );
    const numbers: string[] = [];
    for (const i of range(3)) {
      const out = mustOk(await service(w).post({ companyId: w.companyId, draft: pay(w, `wide${i}`).voucher }));
      numbers.push(out.voucher.number);
    }
    expect(numbers).toEqual(['PAY/24-25/9999', 'PAY/24-25/10000', 'PAY/24-25/10001']);
  });
});

describe('one voucher id, many simultaneous callers (idempotency)', () => {
  it('10 identical posts produce exactly one voucher; the rest replay it', async () => {
    const w = await make();
    const draft = pay(w, 'same', '7').voucher;
    const results = await Promise.all(range(10).map(() => service(w).post({ companyId: w.companyId, draft })));

    expect(okOf(results)).toBe(10);
    const fresh = results.filter((r) => r.ok && !r.value.replayed);
    expect(fresh).toHaveLength(1);
    expect(new Set(results.map((r) => (r.ok ? r.value.voucher.number : ''))).size).toBe(1);
    expect(await w.backend.list(w.companyId)).toHaveLength(1);
    expect(await allLines(w)).toHaveLength(2);
    // and no number was wasted
    expect(mustOk(await service(w).post({ companyId: w.companyId, draft: pay(w, 'next').voucher })).voucher.number).toBe('PAY/24-25/0002');
  });

  it('the same id with DIFFERENT content: exactly one content wins, the other is refused', async () => {
    const w = await make();
    const a = pay(w, 'clash', '1').voucher;
    const b = pay(w, 'clash', '2').voucher;
    const results = await Promise.all(
      range(12).map((i) => service(w).post({ companyId: w.companyId, draft: i % 2 === 0 ? a : b })),
    );

    const conflicts = results.filter((r) => codes(r).includes(IssueCode.IdempotencyConflict));
    expect(await w.backend.list(w.companyId)).toHaveLength(1);
    expect(okOf(results) + conflicts.length).toBe(12);
    expect(okOf(results)).toBe(6); // all six posts of the winning content succeed; all six of the other conflict
    expect(conflicts).toHaveLength(6);
  });
});

describe('stale writers lose cleanly (optimistic concurrency)', () => {
  it('8 simultaneous alterations of the same version: exactly one wins', async () => {
    const w = await make();
    const posted = mustOk(await service(w).post({ companyId: w.companyId, draft: pay(w, 'v', '1').voucher }));
    const results = await Promise.all(
      range(8).map((i) =>
        service(w).alter({
          companyId: w.companyId,
          voucherId: posted.voucher.id,
          expectedVersion: 1,
          draft: pay(w, 'v', String(10 + i)).voucher,
        }),
      ),
    );

    expect(okOf(results)).toBe(1);
    for (const r of results) if (!r.ok) expect(codes(r)).toEqual([IssueCode.VersionConflict]);
    const stored = await w.backend.get(w.companyId, posted.voucher.id);
    expect(stored).toMatchObject({ version: 2, revision: 1 });
    expect(trialBalance(await allLines(w)).isBalanced).toBe(true);
    expect(await allLines(w)).toHaveLength(2); // never a mixture of two alterations
  });

  it('8 simultaneous cancellations: exactly one wins', async () => {
    const w = await make();
    const posted = mustOk(await service(w).post({ companyId: w.companyId, draft: pay(w, 'v').voucher }));
    const results = await Promise.all(
      range(8).map(() => service(w).cancel({ companyId: w.companyId, voucherId: posted.voucher.id, expectedVersion: 1 })),
    );

    expect(okOf(results)).toBe(1);
    for (const r of results) {
      if (!r.ok) expect([IssueCode.VoucherNotPosted, IssueCode.VersionConflict]).toContain(r.issues[0]?.code);
    }
    expect(await allLines(w)).toEqual([]);
    expect(await w.backend.history(posted.voucher.id)).toHaveLength(1); // one revision, not eight
  });

  it('an alteration racing a cancellation leaves the voucher either altered or cancelled — never both', async () => {
    const w = await make();
    const posted = mustOk(await service(w).post({ companyId: w.companyId, draft: pay(w, 'v', '1').voucher }));
    const [alter, cancel] = await Promise.all([
      service(w).alter({ companyId: w.companyId, voucherId: posted.voucher.id, expectedVersion: 1, draft: pay(w, 'v', '9').voucher }),
      service(w).cancel({ companyId: w.companyId, voucherId: posted.voucher.id, expectedVersion: 1 }),
    ]);
    expect(Number(alter.ok) + Number(cancel.ok)).toBe(1);
    const stored = await w.backend.get(w.companyId, posted.voucher.id);
    const lines = await allLines(w);
    if (cancel.ok) expect(lines).toHaveLength(0);
    else expect(lines).toHaveLength(2);
    expect(stored?.status).toBe(cancel.ok ? 'cancelled' : 'posted');
  });
});

describe('a storm of mixed operations', () => {
  it('120 concurrent posts / alters / cancels: no deadlock, no unexpected error, books consistent', async () => {
    const w = await make();
    // 8 vouchers to fight over
    const base = await Promise.all(range(8).map((i) => service(w).post({ companyId: w.companyId, draft: pay(w, `s${i}`, '5').voucher })));
    const targets = base.map((r) => mustOk(r).voucher);

    const ops = range(120).map((i) => {
      const t = targets[i % targets.length]!;
      const kind = i % 3;
      if (kind === 0) return service(w).post({ companyId: w.companyId, draft: pay(w, `storm${i}`, String(1 + (i % 5))).voucher });
      if (kind === 1) {
        return service(w).alter({
          companyId: w.companyId, voucherId: t.id, expectedVersion: 1 + Math.floor(i / 24), draft: pay(w, `s${i % targets.length}`, String(20 + i)).voucher,
        });
      }
      return service(w).cancel({ companyId: w.companyId, voucherId: t.id, expectedVersion: 1 + Math.floor(i / 24) });
    });

    // Every operation must RESOLVE with ok or a known business issue. A rejection would mean a
    // deadlock, a serialization failure or a broken invariant.
    const results = await Promise.all(ops);
    const allowed = new Set<string>([IssueCode.VersionConflict, IssueCode.VoucherNotPosted]);
    for (const r of results) if (!r.ok) for (const i of r.issues) expect(allowed.has(i.code), i.code).toBe(true);

    // consistency: per voucher, posted ⇒ balanced lines; cancelled ⇒ none
    const vouchers = await w.backend.list(w.companyId);
    const lines = await allLines(w);
    for (const v of vouchers) {
      const own = lines.filter((l) => l.voucherId === v.id);
      if (v.status === 'cancelled') expect(own).toHaveLength(0);
      else {
        expect(own.length).toBeGreaterThanOrEqual(2);
        expect(own.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0n)).toBe(
          own.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0n),
        );
      }
    }
    expect(trialBalance(lines).isBalanced).toBe(true);

    // numbering gapless across everything that was ever posted
    const seq = vouchers.map((v) => seqOf(v.number)).sort((x, y) => x - y);
    expect(seq).toEqual(seq.map((_, i) => i + 1));
  });
});
