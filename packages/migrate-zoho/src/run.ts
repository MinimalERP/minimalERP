#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { type CompanyId, localDate, orderBookOf } from '@minimalerp/domain';
import { PostgresBackend } from '@minimalerp/adapter-postgres';
import pg from 'pg';
import { groupByInvoice, invoiceFilterOf, parseZohoCsv } from './csv';
import { stageInvoice } from './stage';

/**
 * Stages Zoho Books "Invoices" CSV export rows as AI Inbox proposals — the same review queue Gmail- and
 * Upload-sourced documents land in. Nothing is posted here: each invoice waits in the Inbox until a person
 * opens it, fixes anything unmatched (Alt+C), and accepts it.
 *
 * Usage:
 *   pnpm --filter @minimalerp/migrate-zoho stage -- \
 *     --csv /path/to/Invoice.csv --company <uuid> --actor <uuid> --db-url postgres://... \
 *     [--only "26-27/001..26-27/090"] [--out report.json]
 *
 * --db-url may also be given as the DATABASE_URL environment variable. Never commit a connection string or
 * the CSV itself — both carry real customer/financial data.
 */

interface Args {
  readonly csv: string;
  readonly company: string;
  readonly actor: string;
  readonly dbUrl: string;
  readonly only: string | undefined;
  readonly out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const csv = get('--csv');
  const company = get('--company');
  const actor = get('--actor');
  const dbUrl = get('--db-url') ?? process.env['DATABASE_URL'];
  if (!csv || !company || !actor || !dbUrl) {
    throw new Error('Usage: --csv <path> --company <uuid> --actor <uuid> --db-url <postgres://...> (or DATABASE_URL) [--only <range>] [--out <path>]');
  }
  return { csv, company, actor, dbUrl, only: get('--only'), out: get('--out') ?? 'zoho-import-report.json' };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const companyId = args.company as CompanyId;

  const rows = parseZohoCsv(readFileSync(args.csv, 'utf8'));
  const invoices = groupByInvoice(rows);
  const filter = invoiceFilterOf(args.only);
  const batch = filter ? invoices.filter((inv) => filter(inv.invoiceNumber)) : invoices;
  console.log(`${invoices.length} invoices in the file, ${batch.length} in this batch.`);
  if (batch.length === 0) return;

  const pool = new pg.Pool({ connectionString: args.dbUrl });
  const backend = new PostgresBackend(pool, { actorId: args.actor, requestId: `zoho-import-${Date.now()}` });
  try {
    const masters = await backend.load(companyId);
    const vouchers = await backend.list(companyId);
    const orders = orderBookOf(vouchers, masters);
    const today = localDate(new Date().toISOString().slice(0, 10));

    const report: unknown[] = [];
    for (const invoice of batch) {
      const result = await stageInvoice(backend, companyId, { masters, vouchers, orders, today }, invoice);
      report.push(result);
      const flag = result.error ? `ERROR: ${result.error}` : result.notes.length > 0 ? result.notes.join(' | ') : 'ok';
      console.log(`${result.zohoNumber}\t${result.party ?? '(no party matched)'}\t${flag}`);
    }
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`\nWrote ${report.length} entries to ${args.out}. Review and accept each one from the AI Inbox.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
