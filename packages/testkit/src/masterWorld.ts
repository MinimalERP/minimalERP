import { MemoryBackend } from '@minimalerp/adapter-memory';
import {
  type CompanyId,
  type Masters,
  asCompanyId,
  defaultVoucherKinds,
  localDate,
  seedCompany,
} from '@minimalerp/domain';
import type {
  JournalRepository,
  MasterGateway,
  MastersRepository,
  OrderRepository,
  PostingGateway,
  StockRepository,
  VoucherRepository,
} from '@minimalerp/ports';
import { makeUuidFactory, randomSeed } from './world';

/** A backend that can take master commands, post vouchers (opening balances), and be read back. */
export interface MasterContractBackend extends MasterGateway, MastersRepository, PostingGateway, VoucherRepository, JournalRepository, StockRepository, OrderRepository {}

/**
 * A freshly onboarded company: exactly what `seedCompany` makes, with no demo data. Ids are deterministic per world
 * (`uuid('group:sales-accounts')`, `uuid('type:opening')`, `uuid('ledger:cash')`, `uuid('unit:Kg')`, `uuid('gst:18')`…).
 */
export interface MasterWorld {
  readonly backend: MasterContractBackend;
  readonly companyId: CompanyId;
  /** The starting masters, before any command. */
  readonly seed: Masters;
  uuid(name: string): string;
}

export type MakeMasterWorld = () => MasterWorld | Promise<MasterWorld>;

export const SEED_FY_START = localDate('2024-04-01');

export function seedForWorld(seed: string = randomSeed()): { masters: Masters; uuid: (name: string) => string } {
  const uuid = makeUuidFactory(seed);
  return { masters: seedCompany({ name: 'Acme Works', fyStart: SEED_FY_START, newId: uuid }), uuid };
}

export function buildMasterWorld(): MasterWorld {
  const { masters, uuid } = seedForWorld();
  return {
    backend: new MemoryBackend(masters, defaultVoucherKinds()),
    companyId: asCompanyId(masters.company.id),
    seed: masters,
    uuid,
  };
}
