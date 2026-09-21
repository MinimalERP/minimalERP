import {
  type CompanyId,
  type FinancialYearId,
  type LocalDate,
  type VoucherId,
} from '@minimalerp/domain';
import { PostgresBackend, type PostgresBackendOptions } from '@minimalerp/adapter-postgres';
import {
  type ContractBackend,
  type DemoData,
  type DemoWorld,
  type MakeWorld,
  type RevisionView,
  buildDemoData,
  randomSeed,
  worldAround,
} from '@minimalerp/testkit';
import type pg from 'pg';
import type { TestDb } from './testDb';

/** Everything the demo company contains, as one JSON document (so seeding is a single statement). */
function seedPayload(data: DemoData, ownerId: string) {
  const m = data.masters.data;
  return {
    ownerId,
    company: { id: m.company.id, name: m.company.name },
    financialYears: m.financialYears.map((f) => ({ id: f.id, label: f.label, start: f.start, end: f.end })),
    groups: m.groups.all.map((g) => ({
      id: g.id, name: g.name, parent: g.parentId, nature: g.nature,
      gp: g.affectsGrossProfit, system: g.isSystem, key: g.reservedKey ?? null,
    })),
    ledgers: m.ledgers.map((l) => ({ id: l.id, name: l.name, group: l.groupId, active: l.isActive })),
    types: m.voucherTypes.map((t) => ({ id: t.id, name: t.name, kind: t.baseKind })),
    series: m.series.map((s) => ({
      id: s.id, type: s.voucherTypeId, fy: s.financialYearId,
      prefix: s.prefix, suffix: s.suffix, width: s.width, start: s.startAt,
    })),
  };
}

const SEED_SQL = `
with d as (select $1::jsonb as j),
c as (
  insert into public.companies (id, name)
  select (j #>> '{company,id}')::uuid, j #>> '{company,name}' from d
),
u as (
  insert into auth.users (id, email)
  select (j ->> 'ownerId')::uuid, (j ->> 'ownerId') || '@example.test' from d
),
m as (
  insert into public.company_members (company_id, user_id, role)
  select (j #>> '{company,id}')::uuid, (j ->> 'ownerId')::uuid, 'owner' from d
),
fy as (
  insert into public.financial_years (id, company_id, label, start_date, end_date)
  select (x ->> 'id')::uuid, (j #>> '{company,id}')::uuid, x ->> 'label', (x ->> 'start')::date, (x ->> 'end')::date
    from d, jsonb_array_elements(j -> 'financialYears') x
),
g as (
  insert into public.account_groups (id, company_id, name, parent_id, nature, affects_gross_profit, is_system, reserved_key)
  select (x ->> 'id')::uuid, (j #>> '{company,id}')::uuid, x ->> 'name', (x ->> 'parent')::uuid, x ->> 'nature',
         (x ->> 'gp')::boolean, (x ->> 'system')::boolean, x ->> 'key'
    from d, jsonb_array_elements(j -> 'groups') x
),
l as (
  insert into public.ledgers (id, company_id, name, group_id, is_active)
  select (x ->> 'id')::uuid, (j #>> '{company,id}')::uuid, x ->> 'name', (x ->> 'group')::uuid, (x ->> 'active')::boolean
    from d, jsonb_array_elements(j -> 'ledgers') x
),
t as (
  insert into public.voucher_types (id, company_id, name, base_kind)
  select (x ->> 'id')::uuid, (j #>> '{company,id}')::uuid, x ->> 'name', x ->> 'kind'
    from d, jsonb_array_elements(j -> 'types') x
),
s as (
  insert into public.numbering_series (id, company_id, voucher_type_id, financial_year_id, prefix, suffix, width, start_at)
  select (x ->> 'id')::uuid, (j #>> '{company,id}')::uuid, (x ->> 'type')::uuid, (x ->> 'fy')::uuid,
         x ->> 'prefix', x ->> 'suffix', (x ->> 'width')::int, (x ->> 'start')::int
    from d, jsonb_array_elements(j -> 'series') x
)
select 1
`;

export async function seedCompany(pool: pg.Pool, data: DemoData, ownerId: string): Promise<void> {
  await pool.query(SEED_SQL, [JSON.stringify(seedPayload(data, ownerId))]);
}

/** Adds a signed-up user to a company with the given role (owner | accountant | clerk | viewer). */
export async function addMember(
  pool: pg.Pool,
  companyId: string,
  userId: string,
  role: 'owner' | 'accountant' | 'clerk' | 'viewer',
): Promise<void> {
  await pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [userId, `${userId}@example.test`]);
  await pool.query(`insert into public.company_members (company_id, user_id, role) values ($1, $2, $3)`, [companyId, userId, role]);
}

/**
 * The real backend plus the two admin hooks the behavioural contract needs. `lockThrough` is a
 * plain UPDATE by the superuser (locking a period is an admin action); `history` reads the audit trail.
 */
export class PgTestBackend extends PostgresBackend implements ContractBackend {
  constructor(
    private readonly pool: pg.Pool,
    private readonly companyId: CompanyId,
    options: PostgresBackendOptions,
  ) {
    super(pool, options);
  }

  async lockThrough(financialYearId: FinancialYearId, date: LocalDate | undefined): Promise<void> {
    await this.pool.query('update public.financial_years set locked_through = $2::date where id = $1::uuid', [
      financialYearId,
      date ?? null,
    ]);
  }

  async history(voucherId: VoucherId): Promise<readonly RevisionView[]> {
    return this.revisionsOf(this.companyId, voucherId);
  }
}

export interface PgWorld extends DemoWorld {
  readonly ownerId: string;
  readonly pool: pg.Pool;
  readonly data: DemoData;
}

/** A fresh company (own uuids) in the shared test database, wired to the real posting service. */
export function pgWorldFactory(db: TestDb): (options?: Parameters<MakeWorld>[0]) => Promise<PgWorld> {
  return async (options = {}) => {
    const data = buildDemoData(randomSeed(), options.withSeries ?? true);
    const ownerId = data.uuid('user:owner');
    await seedCompany(db.pool, data, ownerId);
    const backend = new PgTestBackend(db.pool, data.companyId, {
      actorId: ownerId,
      ...(options.registry ? { registry: options.registry } : {}),
    });
    return { ...worldAround(data, backend), ownerId, pool: db.pool, data };
  };
}
