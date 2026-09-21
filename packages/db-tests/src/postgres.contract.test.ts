/**
 * THE parity test: the exact same behavioural contract the in-memory backend passes
 * (~150 tests including the property-based ones), run against the real PostgreSQL implementation —
 * posting functions, triggers and all. If SQL and TypeScript disagree about anything, it fails here.
 */
import { backendContract } from '@minimalerp/testkit';
import { afterAll, beforeAll, inject } from 'vitest';
import { type TestDb, createTestDb } from './harness/testDb';
import { pgWorldFactory } from './harness/pgWorld';

let db: TestDb;
let factory: ReturnType<typeof pgWorldFactory>;

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  factory = pgWorldFactory(db);
});
afterAll(async () => {
  await db?.close();
});

// Each property run posts real vouchers over real connections, so fewer runs than in memory —
// still hundreds of randomised histories, each checked against the independent model.
backendContract('postgres', (options) => factory(options), { runs: 25, sequenceRuns: 15 });
