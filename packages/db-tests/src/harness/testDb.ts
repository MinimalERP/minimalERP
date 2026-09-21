import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PG_PASSWORD, PG_USER } from './globalSetup';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MIGRATIONS = join(root, 'supabase', 'migrations');
const PRELUDE = join(root, 'supabase', 'tests', 'support', 'supabase_prelude.sql');

// Postgres returns numeric/bigint/date as strings or Dates by default. We want raw strings for
// dates and numerics so nothing is silently coerced through a JS number or a time zone.
pg.types.setTypeParser(1082, (v) => v); // date  → 'YYYY-MM-DD'
pg.types.setTypeParser(1700, (v) => v); // numeric → '1234.56'
pg.types.setTypeParser(20, (v) => v);   // int8 → string

export interface TestDb {
  readonly name: string;
  /** Superuser pool (like Supabase's `postgres` role): runs migrations and seeds data. */
  readonly pool: pg.Pool;
  /** A fresh dedicated connection, superuser. Caller must release(). */
  connect(): Promise<pg.PoolClient>;
  /** Run `fn` inside a transaction as a Supabase-style role, with a JWT for `userId`. Always rolls back. */
  asRole<T>(role: 'anon' | 'authenticated' | 'service_role', userId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const connOpts = (port: number, database: string): pg.PoolConfig => ({
  host: '127.0.0.1',
  port,
  user: PG_USER,
  password: PG_PASSWORD,
  database,
});

export function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), 'utf8') }));
}

/** Creates an isolated database, applies the Supabase prelude, then EVERY migration in order. */
export async function createTestDb(port: number): Promise<TestDb> {
  const name = `t_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Client(connOpts(port, 'postgres'));
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const pool = new pg.Pool({ ...connOpts(port, name), max: 40 });

  const setup = await pool.connect();
  try {
    await setup.query('set search_path = public, extensions');
    await setup.query(readFileSync(PRELUDE, 'utf8'));
    for (const m of migrationFiles()) {
      try {
        await setup.query(m.sql);
      } catch (e) {
        throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    setup.release();
  }

  return {
    name,
    pool,
    connect: () => pool.connect(),
    async asRole(role, userId, fn) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(`set local role ${role}`);
        const claims = userId === null ? {} : { sub: userId, role };
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        return await fn(c);
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    },
    close: () => pool.end(),
  };
}
