import { type Issue, IssueCode, issue } from '../errors';
import { canonicalId, gstinProblem, normalizeName, stateOfGstin } from './rules';
import { parseLocalDate } from '../dates';

/**
 * The choices made when a company is created. Everything else about a new company is the standard seed.
 * Checked in the browser (to point at the field) and again on the server (which trusts nothing it is sent).
 */
export interface NewCompany {
  readonly name: string;
  /** First day of the first financial year, `YYYY-MM-DD`. */
  readonly fyStart: string;
  readonly gstin?: string | undefined;
  readonly stateCode?: string | undefined;
  readonly address?: string | undefined;
}

/** Problems with the details typed for a new company (each carries the field it belongs to). */
export function newCompanyIssues(input: NewCompany): Issue[] {
  const problems: Issue[] = [];
  if (normalizeName(input.name) === '') problems.push(issue(IssueCode.SchemaInvalid, 'Enter the company name', 'name'));
  if (parseLocalDate(input.fyStart) === undefined) problems.push(issue(IssueCode.SchemaInvalid, 'Enter a valid date as YYYY-MM-DD', 'fyStart'));
  const gstin = canonicalId(input.gstin ?? '');
  if (gstin !== '') {
    const p = gstinProblem(gstin);
    if (p) problems.push(issue(IssueCode.InvalidGstin, p, 'gstin'));
    else if (input.stateCode && input.stateCode !== stateOfGstin(gstin)) {
      problems.push(issue(IssueCode.InvalidGstin, `State code ${input.stateCode} does not match the GSTIN (${stateOfGstin(gstin)})`, 'stateCode'));
    }
  }
  return problems;
}
