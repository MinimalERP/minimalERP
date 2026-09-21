import { PostgresBackend } from '@minimalerp/adapter-postgres';
import { type CompanyId, asCompanyId } from '@minimalerp/domain';
import { type MakeMasterWorld, type MasterWorld, mustOk, seedForWorld } from '@minimalerp/testkit';
import type { TestDb } from './testDb';

export interface PgMasterWorld extends MasterWorld {
  readonly ownerId: string;
  readonly companyId: CompanyId;
  readonly backend: PostgresBackend;
}

/**
 * A company made the way onboarding makes one: `seedCompany` in the domain, written by the `company_seed` SQL function in
 * one transaction, with the actor as owner. No hand-written inserts, so this also proves the seed round-trips through the
 * database into the exact same masters the domain started from.
 */
export function pgMasterWorldFactory(db: TestDb): (actorRole?: 'owner') => Promise<PgMasterWorld> {
  return async () => {
    const { masters, uuid } = seedForWorld();
    const ownerId = uuid('user:owner');
    await db.pool.query(`insert into auth.users (id, email) values ($1, $2)`, [ownerId, `${ownerId}@example.test`]);
    const backend = new PostgresBackend(db.pool, { actorId: ownerId });
    mustOk(await backend.createCompany(masters));
    return { backend, companyId: asCompanyId(masters.company.id), seed: masters, uuid, ownerId };
  };
}

export const asMakeMasterWorld = (db: TestDb): MakeMasterWorld => pgMasterWorldFactory(db);
