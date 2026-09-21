import type { Issue, JournalLine, Result } from '@minimalerp/domain';
import type { PostOutcome } from '@minimalerp/ports';
import type { Scenario } from './scenarios';
import type { DemoWorld } from './world';

const show = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x), 2);

/** Unwraps a successful Result, or fails the test with the issues that were returned. */
export function mustOk<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`Expected ok, got issues:\n${show(r.issues)}`);
  return r.value;
}

/** Unwraps a failed Result's issues, or fails the test because it unexpectedly succeeded. */
export function mustFail(r: Result<unknown>): readonly Issue[] {
  if (r.ok) throw new Error(`Expected failure, but it succeeded:\n${show(r.value)}`);
  return r.issues;
}

export const codesOf = (r: Result<unknown>): string[] => mustFail(r).map((i) => i.code);

export const post = (w: DemoWorld, s: Scenario): Promise<Result<PostOutcome>> =>
  w.backend.post({ companyId: w.companyId, draft: s.voucher });

export const postOk = async (w: DemoWorld, s: Scenario): Promise<PostOutcome> => mustOk(await post(w, s));

/** A compact, comparable view of journal lines: [ledger, side, minor units, lineNo]. */
export const brief = (lines: readonly JournalLine[]) =>
  lines.map((l) => [l.ledgerId, l.side, l.amount, l.lineNo] as const);

export const allLines = (w: DemoWorld) => w.backend.lines({ companyId: w.companyId });
