import { type Issue, IssueCode, issue } from '@minimalerp/domain';

const KNOWN = new Set<string>(Object.values(IssueCode));

/**
 * The posting functions and integrity triggers raise exceptions whose MESSAGE is a stable code
 * (the same strings as the domain's IssueCode) and whose DETAIL is the human explanation.
 * Recognised codes become ordinary Issues; anything else is a genuine failure and must propagate.
 */
export function issueFromDbError(error: unknown): Issue | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const { message, detail } = error as { message?: unknown; detail?: unknown };
  if (typeof message !== 'string' || !KNOWN.has(message)) return undefined;
  return issue(message, typeof detail === 'string' && detail.length > 0 ? detail : message);
}
