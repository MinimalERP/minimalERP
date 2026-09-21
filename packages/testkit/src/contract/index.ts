import type { MakeWorld } from '../world';
import { buggyRulesContract } from './buggyRules';
import { lifecycleContract } from './lifecycle';
import { masterContract } from './masters';
import { gstContract } from './gst';
import { purchaseContract } from './purchase';
import { salesContract } from './sales';
import { stockContract } from './stock';
import { voucherDetailsContract } from './vouchers';
import { type PropertyRuns, propertiesContract } from './properties';
import { postingRulesContract } from './rules';
import { trialBalanceContract } from './trialBalance';

export { buggyRulesContract, gstContract, lifecycleContract, masterContract, purchaseContract, salesContract, stockContract, voucherDetailsContract, postingRulesContract, propertiesContract, trialBalanceContract };
export type { PropertyRuns };

/**
 * The full behavioural contract every PostingGateway + repositories implementation must satisfy.
 * Call it from a test file with a `makeWorld` for the backend under test.
 */
export function backendContract(label: string, makeWorld: MakeWorld, runs: PropertyRuns): void {
  postingRulesContract(label, makeWorld);
  lifecycleContract(label, makeWorld);
  buggyRulesContract(label, makeWorld);
  trialBalanceContract(label, makeWorld);
  propertiesContract(label, makeWorld, runs);
}
