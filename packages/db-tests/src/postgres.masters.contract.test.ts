/**
 * The master-data contract — the exact tests the in-memory backend passes — against real PostgreSQL:
 * validation by the same domain code, commit through master_apply, opening balances through the posting functions,
 * duplicate names refused even when many requests race, built-ins locked.
 */
import { gstContract, masterContract, purchaseContract, salesContract, stockContract, voucherDetailsContract } from '@minimalerp/testkit';
import { afterAll, beforeAll } from 'vitest';
import { asMakeMasterWorld } from './harness/pgMasterWorld';
import { type TestDb, createTestDb } from './harness/testDb';
import { inject } from 'vitest';

let db: TestDb;
let make: ReturnType<typeof asMakeMasterWorld>;

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  make = asMakeMasterWorld(db);
});
afterAll(async () => {
  await db?.close();
});

masterContract('postgres', () => make());
voucherDetailsContract('postgres', () => make());
stockContract('postgres', () => make());
salesContract('postgres', () => make());
purchaseContract('postgres', () => make());
gstContract('postgres', () => make());
