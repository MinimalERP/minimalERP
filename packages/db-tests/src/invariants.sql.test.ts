/**
 * PHASE 2 EXIT GATE: "raw SQL cannot insert an unbalanced voucher".
 *
 * These tests bypass the application entirely and write with a superuser connection — the worst
 * case: a bug in a future code path, a careless script, someone with database access. The database
 * must still refuse to hold a corrupt book. (Superusers can disable triggers; that is out of scope —
 * these guard against mistakes, and RLS/privileges in security.test.ts guard against clients.)
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { type PgWorld, pgWorldFactory } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let makeWorld: ReturnType<typeof pgWorldFactory>;
let w: PgWorld;
let c: pg.PoolClient;

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  makeWorld = pgWorldFactory(db);
});
afterAll(async () => {
  c?.release();
  await db?.close();
});
beforeEach(async () => {
  w = await makeWorld();
  c?.release();
  c = await db.connect();
});

/** Runs `fn` in a transaction and returns the error it ended with (COMMIT included), or undefined. */
async function tx(client: pg.PoolClient, fn: () => Promise<void>): Promise<unknown> {
  await client.query('begin');
  try {
    await fn();
    await client.query('commit');
    return undefined;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    return e;
  }
}

const count = async (table: string, where = 'true', values: unknown[] = []) =>
  Number((await db.pool.query(`select count(*)::int as n from public.${table} where ${where}`, values)).rows[0].n);

// ---- raw-write helpers (deliberately NOT going through the application) ----
const seriesId = (fyLabel = '2024-25', kind = 'payment') =>
  w.data.masters.seriesFor(w.types[kind as 'payment'], (fyLabel === '2024-25' ? w.fy2425 : w.fy2526).id)!.id;

let seq = 0;
async function rawVoucher(
  id: string,
  opts: { date?: string; status?: string; fy?: string } = {},
): Promise<void> {
  const fy = opts.fy === '2025-26' ? w.fy2526 : w.fy2425;
  await c.query(
    `insert into public.vouchers (id, company_id, voucher_type_id, financial_year_id, series_id, number, voucher_date, status, content)
     values ($1, $2, $3, $4, $5, $6, $7::date, $8, '{}'::jsonb)`,
    [id, w.companyId, w.types.payment, fy.id, seriesId(opts.fy ?? '2024-25'), `RAW-${++seq}-${id.slice(0, 4)}`, opts.date ?? '2024-05-10', opts.status ?? 'posted'],
  );
}

async function rawLine(
  voucher: string,
  lineNo: number,
  ledger: string,
  debit: string,
  credit: string,
  opts: { date?: string; fyId?: string } = {},
): Promise<void> {
  await c.query(
    `insert into public.journal_lines (company_id, voucher_id, line_no, entry_date, financial_year_id, ledger_id, debit, credit)
     values ($1, $2, $3, $4::date, $5, $6, $7::numeric, $8::numeric)`,
    [w.companyId, voucher, lineNo, opts.date ?? '2024-05-10', opts.fyId ?? w.fy2425.id, ledger, debit, credit],
  );
}

describe('the deferred balance trigger (checked at COMMIT)', () => {
  it('REFUSES an unbalanced voucher — even off by one paisa', async () => {
    const id = randomUUID();
    const err = await tx(c, async () => {
      await rawVoucher(id);
      await rawLine(id, 1, w.ledgers.rent, '100.00', '0');
      await rawLine(id, 2, w.ledgers.bank, '0', '99.99');
    });
    expect(err).toMatchObject({ message: 'PLAN_UNBALANCED', code: '23514' });
    expect(await count('vouchers', 'id = $1', [id])).toBe(0);
    expect(await count('journal_lines', 'voucher_id = $1', [id])).toBe(0);
  });

  it('ACCEPTS a balanced voucher (the trigger is not simply blocking everything)', async () => {
    const id = randomUUID();
    const err = await tx(c, async () => {
      await rawVoucher(id);
      await rawLine(id, 1, w.ledgers.rent, '100.00', '0');
      await rawLine(id, 2, w.ledgers.bank, '0', '60.00');
      await rawLine(id, 3, w.ledgers.cash, '0', '40.00');
    });
    expect(err).toBeUndefined();
    expect(await count('journal_lines', 'voucher_id = $1', [id])).toBe(3);
  });

  it('is checked at COMMIT, so lines may be inserted in any order within a transaction', async () => {
    const id = randomUUID();
    const err = await tx(c, async () => {
      await rawVoucher(id);
      await rawLine(id, 1, w.ledgers.bank, '0', '50.00'); // credit first: temporarily unbalanced
      await rawLine(id, 2, w.ledgers.rent, '50.00', '0');
    });
    expect(err).toBeUndefined();
  });

  it('REFUSES a posted voucher with fewer than two lines', async () => {
    const id = randomUUID();
    const err = await tx(c, async () => {
      await rawVoucher(id);
      // a single line cannot balance unless it is zero, which the one-side check forbids
    });
    expect(err).toMatchObject({ message: 'PLAN_TOO_FEW_LINES' });
  });

  it('REFUSES a cancelled voucher that still has lines', async () => {
    const id = randomUUID();
    const err = await tx(c, async () => {
      await rawVoucher(id, { status: 'cancelled' });
      await rawLine(id, 1, w.ledgers.rent, '10.00', '0');
      await rawLine(id, 2, w.ledgers.bank, '0', '10.00');
    });
    expect(err).toMatchObject({ message: 'CANCELLED_WITH_LINES' });
  });

  it('REFUSES lines whose date differs from their voucher’s', async () => {
    const id = randomUUID();
    const err = await tx(c, async () => {
      await rawVoucher(id, { date: '2024-05-10' });
      await rawLine(id, 1, w.ledgers.rent, '10.00', '0', { date: '2024-06-01' });
      await rawLine(id, 2, w.ledgers.bank, '0', '10.00', { date: '2024-06-01' });
    });
    expect(err).toMatchObject({ message: 'LINE_DATE_MISMATCH' });
  });

  it('REFUSES a voucher dated outside its financial year', async () => {
    const id = randomUUID();
    const err = await tx(c, async () => {
      await rawVoucher(id, { date: '2030-01-01' });
      await rawLine(id, 1, w.ledgers.rent, '10.00', '0', { date: '2030-01-01' });
      await rawLine(id, 2, w.ledgers.bank, '0', '10.00', { date: '2030-01-01' });
    });
    expect(err).toMatchObject({ message: 'DATE_OUTSIDE_FINANCIAL_YEAR' });
  });

  describe('a voucher that is already committed and balanced', () => {
    let id: string;
    beforeEach(async () => {
      id = randomUUID();
      expect(
        await tx(c, async () => {
          await rawVoucher(id);
          await rawLine(id, 1, w.ledgers.rent, '100.00', '0');
          await rawLine(id, 2, w.ledgers.bank, '0', '100.00');
        }),
      ).toBeUndefined();
    });

    it('cannot lose one of its lines', async () => {
      const err = await tx(c, async () => {
        await c.query('delete from public.journal_lines where voucher_id = $1 and line_no = 2', [id]);
      });
      expect(err).toMatchObject({ message: expect.stringMatching(/PLAN_UNBALANCED|PLAN_TOO_FEW_LINES/) });
      expect(await count('journal_lines', 'voucher_id = $1', [id])).toBe(2);
    });

    it('cannot have an amount changed to unbalance it', async () => {
      const err = await tx(c, async () => {
        await c.query(`update public.journal_lines set debit = 100.01 where voucher_id = $1 and line_no = 1`, [id]);
      });
      expect(err).toMatchObject({ message: 'PLAN_UNBALANCED' });
    });

    it('cannot be flipped to cancelled while its lines remain', async () => {
      const err = await tx(c, async () => {
        await c.query(`update public.vouchers set status = 'cancelled' where id = $1`, [id]);
      });
      expect(err).toMatchObject({ message: 'CANCELLED_WITH_LINES' });
    });

    it('CAN be cancelled properly: remove the lines and flip the status in one transaction', async () => {
      const err = await tx(c, async () => {
        await c.query('delete from public.journal_lines where voucher_id = $1', [id]);
        await c.query(`update public.vouchers set status = 'cancelled' where id = $1`, [id]);
      });
      expect(err).toBeUndefined();
    });

    it('cannot have its lines moved to another voucher to unbalance both', async () => {
      const other = randomUUID();
      const err = await tx(c, async () => {
        await rawVoucher(other);
        await rawLine(other, 1, w.ledgers.rent, '5.00', '0');
        await rawLine(other, 2, w.ledgers.bank, '0', '5.00');
        await c.query(`update public.journal_lines set voucher_id = $2 where voucher_id = $1 and line_no = 1`, [id, other]);
      });
      expect(err).toBeDefined();
    });
  });
});

describe('row-level shape checks', () => {
  it('a line is a debit XOR a credit', async () => {
    const id = randomUUID();
    const both = await tx(c, async () => {
      await rawVoucher(id);
      await rawLine(id, 1, w.ledgers.rent, '10.00', '10.00');
    });
    expect(both).toMatchObject({ code: '23514', constraint: 'journal_one_side' });

    const neither = await tx(c, async () => {
      await rawVoucher(id);
      await rawLine(id, 1, w.ledgers.rent, '0', '0');
    });
    expect(neither).toMatchObject({ code: '23514', constraint: 'journal_one_side' });
  });

  it('amounts can never be negative', async () => {
    const id = randomUUID();
    const err = await tx(c, async () => {
      await rawVoucher(id);
      await rawLine(id, 1, w.ledgers.rent, '-10.00', '0');
    });
    expect(err).toMatchObject({ code: '23514' });
  });

  it('line numbers are unique within a voucher', async () => {
    const id = randomUUID();
    const err = await tx(c, async () => {
      await rawVoucher(id);
      await rawLine(id, 1, w.ledgers.rent, '10.00', '0');
      await rawLine(id, 1, w.ledgers.bank, '0', '10.00');
    });
    expect(err).toMatchObject({ code: '23505' });
  });

  it('money is stored to exactly two decimal places', async () => {
    const id = randomUUID();
    await tx(c, async () => {
      await rawVoucher(id);
      await rawLine(id, 1, w.ledgers.rent, '10.005', '0'); // rounds, never stores a third place
      await rawLine(id, 2, w.ledgers.bank, '0', '10.01');
    });
    const r = await db.pool.query(`select debit::text as d from public.journal_lines where voucher_id = $1 and line_no = 1`, [id]);
    expect(r.rows[0]?.d).toBe('10.01');
  });
});

describe('cross-company isolation (composite foreign keys)', () => {
  it('a journal line cannot reference another company’s ledger', async () => {
    const other = await makeWorld();
    const id = randomUUID();
    const err = await tx(c, async () => {
      await rawVoucher(id);
      await rawLine(id, 1, other.ledgers.rent, '10.00', '0'); // company B's ledger
      await rawLine(id, 2, w.ledgers.bank, '0', '10.00');
    });
    expect(err).toMatchObject({ code: '23503' });
  });

  it('a voucher cannot use another company’s voucher type or financial year', async () => {
    const other = await makeWorld();
    const wrongType = await tx(c, async () => {
      await c.query(
        `insert into public.vouchers (id, company_id, voucher_type_id, financial_year_id, series_id, number, voucher_date, status, content)
         values ($1, $2, $3, $4, $5, 'X', '2024-05-10', 'posted', '{}')`,
        [randomUUID(), w.companyId, other.types.payment, w.fy2425.id, seriesId()],
      );
    });
    expect(wrongType).toMatchObject({ code: '23503' });

    const wrongFy = await tx(c, async () => {
      await c.query(
        `insert into public.vouchers (id, company_id, voucher_type_id, financial_year_id, series_id, number, voucher_date, status, content)
         values ($1, $2, $3, $4, $5, 'X', '2024-05-10', 'posted', '{}')`,
        [randomUUID(), w.companyId, w.types.payment, other.fy2425.id, seriesId()],
      );
    });
    expect(wrongFy).toMatchObject({ code: '23503' });
  });

  it('a ledger cannot be put in another company’s group', async () => {
    const other = await makeWorld();
    const err = await tx(c, async () => {
      await c.query(`insert into public.ledgers (id, company_id, name, group_id) values ($1, $2, 'Sneaky', $3)`, [
        randomUUID(), w.companyId, other.group('sales-accounts'),
      ]);
    });
    expect(err).toMatchObject({ code: '23503' });
  });
});

describe('the period lock (a second layer, independent of the posting function)', () => {
  const lock = () => db.pool.query(`update public.financial_years set locked_through = '2024-06-30' where id = $1`, [w.fy2425.id]);

  it('refuses raw line inserts on or before the lock date, immediately', async () => {
    await lock();
    const id = randomUUID();
    const err = await tx(c, async () => {
      await rawVoucher(id, { date: '2024-06-30' });
    });
    expect(err).toMatchObject({ message: 'PERIOD_LOCKED' });
  });

  it('allows the day after the lock', async () => {
    await lock();
    const id = randomUUID();
    const err = await tx(c, async () => {
      await rawVoucher(id, { date: '2024-07-01' });
      await rawLine(id, 1, w.ledgers.rent, '1.00', '0', { date: '2024-07-01' });
      await rawLine(id, 2, w.ledgers.bank, '0', '1.00', { date: '2024-07-01' });
    });
    expect(err).toBeUndefined();
  });

  it('refuses to change or delete existing lines inside the locked period', async () => {
    const id = randomUUID();
    await tx(c, async () => {
      await rawVoucher(id, { date: '2024-05-10' });
      await rawLine(id, 1, w.ledgers.rent, '5.00', '0');
      await rawLine(id, 2, w.ledgers.bank, '0', '5.00');
    });
    await lock();

    const upd = await tx(c, async () => {
      await c.query(`update public.journal_lines set narration = 'x' where voucher_id = $1`, [id]);
    });
    expect(upd).toMatchObject({ message: 'PERIOD_LOCKED' });

    const del = await tx(c, async () => {
      await c.query('delete from public.journal_lines where voucher_id = $1', [id]);
    });
    expect(del).toMatchObject({ message: 'PERIOD_LOCKED' });

    const cancel = await tx(c, async () => {
      await c.query(`update public.vouchers set status = 'cancelled' where id = $1`, [id]);
    });
    expect(cancel).toMatchObject({ message: 'PERIOD_LOCKED' });
  });

  it('refuses to move a voucher into the locked period', async () => {
    const id = randomUUID();
    await tx(c, async () => {
      await rawVoucher(id, { date: '2024-08-01' });
      await rawLine(id, 1, w.ledgers.rent, '5.00', '0', { date: '2024-08-01' });
      await rawLine(id, 2, w.ledgers.bank, '0', '5.00', { date: '2024-08-01' });
    });
    await lock();
    const err = await tx(c, async () => {
      await c.query(`update public.vouchers set voucher_date = '2024-05-01' where id = $1`, [id]);
    });
    expect(err).toMatchObject({ message: 'PERIOD_LOCKED' });
  });
});

describe('voucher identity and permanence', () => {
  let id: string;
  beforeEach(async () => {
    id = randomUUID();
    await tx(c, async () => {
      await rawVoucher(id);
      await rawLine(id, 1, w.ledgers.rent, '5.00', '0');
      await rawLine(id, 2, w.ledgers.bank, '0', '5.00');
    });
  });

  it.each([
    ['number', `update public.vouchers set number = 'HACKED' where id = $1`],
    ['type', `update public.vouchers set voucher_type_id = (select id from public.voucher_types where base_kind = 'journal' and company_id = (select company_id from public.vouchers where id = $1)) where id = $1`],
    ['series', `update public.vouchers set series_id = (select id from public.numbering_series where company_id = (select company_id from public.vouchers where id = $1) and id <> (select series_id from public.vouchers where id = $1) limit 1) where id = $1`],
  ])('a voucher’s %s can never change', async (_what, sql) => {
    const err = await tx(c, async () => {
      await c.query(sql, [id]);
    });
    expect(err).toMatchObject({ message: 'VOUCHER_IDENTITY_IMMUTABLE' });
  });

  it('a voucher can never be deleted — only cancelled', async () => {
    const err = await tx(c, async () => {
      await c.query('delete from public.journal_lines where voucher_id = $1', [id]);
      await c.query('delete from public.vouchers where id = $1', [id]);
    });
    expect(err).toMatchObject({ message: 'VOUCHER_DELETE_FORBIDDEN' });
  });

  it('two vouchers can never share a number within a series', async () => {
    const dup = randomUUID();
    const number = (await db.pool.query('select number from public.vouchers where id = $1', [id])).rows[0].number;
    const err = await tx(c, async () => {
      await c.query(
        `insert into public.vouchers (id, company_id, voucher_type_id, financial_year_id, series_id, number, voucher_date, status, content)
         values ($1, $2, $3, $4, $5, $6, '2024-05-10', 'posted', '{}')`,
        [dup, w.companyId, w.types.payment, w.fy2425.id, seriesId(), number],
      );
    });
    expect(err).toMatchObject({ code: '23505' });
  });
});

describe('append-only tables (audit_log, voucher_revisions)', () => {
  beforeEach(async () => {
    await db.pool.query(
      `insert into public.audit_log (company_id, actor, action, entity_type) values ($1, $2, 'test', 'thing')`,
      [w.companyId, w.ownerId],
    );
  });

  it.each([
    ['UPDATE', `update public.audit_log set action = 'forged'`],
    ['DELETE', `delete from public.audit_log`],
    ['TRUNCATE', `truncate public.audit_log`],
  ])('refuses %s on audit_log — even for the superuser', async (_op, sql) => {
    const err = await tx(c, async () => {
      await c.query(sql);
    });
    expect(err).toMatchObject({ message: 'APPEND_ONLY' });
  });

  it('refuses UPDATE, DELETE and TRUNCATE on voucher_revisions', async () => {
    // row-level triggers only fire when there is a row, so give it one
    const id = randomUUID();
    await tx(c, async () => {
      await rawVoucher(id);
      await rawLine(id, 1, w.ledgers.rent, '5.00', '0');
      await rawLine(id, 2, w.ledgers.bank, '0', '5.00');
      await c.query(
        `insert into public.voucher_revisions (company_id, voucher_id, version, reason, snapshot) values ($1, $2, 1, 'alter', '{}')`,
        [w.companyId, id],
      );
    });
    expect(await count('voucher_revisions', 'voucher_id = $1', [id])).toBe(1);

    for (const sql of [
      `update public.voucher_revisions set reason = 'alter'`,
      `delete from public.voucher_revisions`,
      `truncate public.voucher_revisions`,
    ]) {
      expect(await tx(c, async () => void (await c.query(sql)))).toMatchObject({ message: 'APPEND_ONLY' });
    }
  });
});

describe('master data integrity', () => {
  it('financial years of one company cannot overlap', async () => {
    const err = await tx(c, async () => {
      await c.query(
        `insert into public.financial_years (company_id, label, start_date, end_date) values ($1, 'overlap', '2025-01-01', '2025-12-31')`,
        [w.companyId],
      );
    });
    expect(err).toMatchObject({ code: '23P01' });
  });

  it('a lock date must lie within its financial year', async () => {
    const err = await tx(c, async () => {
      await c.query(`update public.financial_years set locked_through = '2030-01-01' where id = $1`, [w.fy2425.id]);
    });
    expect(err).toMatchObject({ code: '23514' });
  });

  it('ledger names are unique per company, case-insensitively', async () => {
    const err = await tx(c, async () => {
      await c.query(`insert into public.ledgers (company_id, name, group_id) values ($1, 'CASH', $2)`, [w.companyId, w.group('cash-in-hand')]);
    });
    expect(err).toMatchObject({ code: '23505' });
  });

  it('the same ledger name is fine in another company', async () => {
    const other = await makeWorld();
    expect(other.ledgers.cash).not.toBe(w.ledgers.cash);
    expect(await count('ledgers', `lower(name) = 'cash'`)).toBeGreaterThanOrEqual(2);
  });

  it('a group cannot be its own parent', async () => {
    const err = await tx(c, async () => {
      await c.query(`update public.account_groups set parent_id = id where id = $1`, [w.group('bank-accounts')]);
    });
    expect(err).toMatchObject({ code: '23514' });
  });
});
