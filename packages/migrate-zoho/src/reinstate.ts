#!/usr/bin/env node
import { PostgresBackend } from '@minimalerp/adapter-postgres';
import { type CompanyId, type Masters, type Voucher, type VoucherId, deterministicUuid } from '@minimalerp/domain';
import pg from 'pg';

/**
 * Re-enters a Sales invoice that was cancelled by mistake. A voucher is never un-cancelled or deleted (the database refuses both: the
 * cancelled one stays on record with its number), so the invoice is posted again, exactly as it was — customer, lines, GST, date — under
 * the "Sales (Zoho number)" voucher type, whose series for that year carries the same prefix and is moved to the same number. The
 * books then hold the cancelled invoice and, beside it, a live one with the same number.
 *
 *   pnpm --filter @minimalerp/migrate-zoho reinstate -- --number "25-26/345" --company <uuid> --actor <uuid> [--commit]
 *
 * Without --commit it only says what it would do. Running it again is safe: the re-entry's id derives from the cancelled invoice's.
 */

type Gateway = Pick<PostgresBackend, 'post' | 'execute' | 'load' | 'get' | 'list' | 'seriesStatus'>;

const seqOf = (n: string): number => Number(/(\d+)\s*$/.exec(n)?.[1] ?? Number.NaN);
const prefixOf = (n: string): string => n.replace(/\d+\s*$/, '');
/** "25-26/345" and "25-26/0345" are one number; "SAL/25-26/0345" also answers to "25-26/345". */
const numberKey = (n: string): string => `${prefixOf(n).trim().toLowerCase()}${seqOf(n)}`;
const sameNumber = (inBooks: string, asked: string): boolean => numberKey(inBooks) === numberKey(asked) || numberKey(inBooks).endsWith(`/${numberKey(asked)}`);

const failed = (what: string, r: { ok: false; issues: readonly { message: string; path?: string | undefined }[] }): Error =>
  new Error(`${what}: ${r.issues.map((i) => `${i.message}${i.path ? ` (${i.path})` : ''}`).join('; ')}`);

/** The cancelled Sales invoice with that number (prefix and value, so "25-26/345" finds "25-26/345" however it is padded). */
export function cancelledInvoice(masters: Masters, vouchers: readonly Voucher[], number: string): Voucher {
  const sales = new Set(masters.voucherTypes.filter((t) => t.baseKind === 'sales').map((t) => t.id as string));
  const same = vouchers.filter((v) => sales.has(v.voucherTypeId) && sameNumber(v.number, number));
  if (same.length === 0) throw new Error(`No Sales invoice numbered ${number}`);
  const cancelled = same.find((v) => v.status === 'cancelled');
  if (!cancelled) throw new Error(`${number} is not cancelled: nothing to re-enter`);
  return cancelled;
}

/** Posts the cancelled invoice again under "Sales (Zoho number)" with the same number. Returns the live invoice (posted now or before). */
export async function reinstate(gw: Gateway, companyId: CompanyId, number: string, commit: boolean, log: (l: string) => void): Promise<Voucher | undefined> {
  let masters = await gw.load(companyId);
  const old = cancelledInvoice(masters, await gw.list(companyId), number);
  const id = deterministicUuid(`reinstate|${companyId}|${old.id}`) as VoucherId;
  const done = await gw.get(companyId, id);
  if (done) {
    log(`${old.number} was re-entered already, as ${done.number} (${done.status})`);
    return done;
  }
  const mainSeries = masters.seriesFor(old.voucherTypeId, old.financialYearId);
  if (!mainSeries) throw new Error(`No numbering series for ${old.number}`);
  const prefix = mainSeries.prefix;
  const seq = seqOf(old.number);
  const typeId = deterministicUuid(`zoho-migrate|${companyId}|type|sales-zoho-number`);
  log(`${old.number} (${old.date}) is cancelled; it will be posted again as it was, under "Sales (Zoho number)", numbered ${old.number}`);
  if (!commit) return undefined;

  if (!masters.voucherType(typeId as never)) {
    const r = await gw.execute({ companyId, command: { op: 'create', kind: 'voucherType', id: typeId, data: { name: 'Sales (Zoho number)', baseKind: 'sales' } } });
    if (!r.ok) throw failed('Voucher type "Sales (Zoho number)"', r);
    masters = await gw.load(companyId);
  }
  let series = masters.seriesFor(typeId as never, old.financialYearId);
  if (!series) {
    const sid = deterministicUuid(`zoho-migrate|${companyId}|series|${typeId}|${old.financialYearId}`);
    const r = await gw.execute({ companyId, command: { op: 'create', kind: 'numberingSeries', id: sid, data: { voucherTypeId: typeId, financialYearId: old.financialYearId, prefix, suffix: mainSeries.suffix, width: mainSeries.width, startAt: seq } } });
    if (!r.ok) throw failed(`Series ${prefix} for "Sales (Zoho number)"`, r);
    series = (await gw.load(companyId)).seriesFor(typeId as never, old.financialYearId);
  }
  if (!series) throw new Error('The "Sales (Zoho number)" series could not be made');
  if (series.prefix !== prefix) throw new Error(`"Sales (Zoho number)" already numbers this year as ${series.prefix}…, not ${prefix}…`);
  const next = await gw.seriesStatus(companyId, series.id);
  if (!next.ok) throw failed('Reading the "Sales (Zoho number)" series', next);
  if (next.value.nextValue > seq) throw new Error(`"Sales (Zoho number)" is past ${seq} for this year (next is ${next.value.nextValue})`);
  if (next.value.nextValue < seq) {
    const r = await gw.execute({ companyId, command: { op: 'advanceSeries', kind: 'numberingSeries', id: series.id, data: { nextValue: seq } } });
    if (!r.ok) throw failed(`Moving the "Sales (Zoho number)" series to ${seq}`, r);
  }

  const content = old.content as unknown as Record<string, unknown>;
  const narration = [typeof content['narration'] === 'string' ? content['narration'] : '', `Re-entered: ${old.number} was cancelled by mistake`].filter((s) => s !== '').join(' · ').slice(0, 500);
  const posted = await gw.post({ companyId, draft: { ...content, id, voucherTypeId: typeId, narration } });
  if (!posted.ok) throw failed(`Posting ${old.number} again`, posted);
  const v = posted.value.voucher;
  if (seqOf(v.number) !== seq) throw new Error(`${old.number} was posted again as ${v.number}`);
  log(`Posted ${v.number} (${v.date}) under "Sales (Zoho number)"`);
  return v;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const number = get('--number');
  const company = get('--company');
  const actor = get('--actor');
  const dbUrl = process.env['DATABASE_URL'];
  if (!number || !company || !actor || !dbUrl) throw new Error('Usage: DATABASE_URL=... reinstate --number "<invoice no>" --company <uuid> --actor <uuid> [--commit]');
  const commit = argv.includes('--commit');
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const db = new PostgresBackend(pool, { actorId: actor, requestId: `reinstate-${Date.now()}` });
    await reinstate(db, company as CompanyId, number, commit, (l) => console.log(l));
    if (!commit) console.log('Dry run — nothing was written. Add --commit to post it.');
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('src/reinstate.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
