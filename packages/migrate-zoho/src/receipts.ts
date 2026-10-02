#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { MemoryBackend } from '@minimalerp/adapter-memory';
import { PostgresBackend } from '@minimalerp/adapter-postgres';
import {
  type CompanyId,
  type Masters,
  type Party,
  type Voucher,
  type VoucherId,
  canonicalId,
  customerLedgerOf,
  deterministicUuid,
  formatMoney,
  openBills,
  parseCsvRecords,
  parseMoney,
  resolvePartyRow,
} from '@minimalerp/domain';
import pg from 'pg';

/**
 * Posts Zoho Books "Payments Received" as Receipts, each settling the invoices Zoho applied it to — bill by bill, with the TDS the
 * customer deducted — so the Outstanding report shows what Zoho shows. The invoices must already be in the books (see post.ts): a
 * payment naming an invoice that is not there, or settling more than is still open on it, stops the run before anything is written.
 *
 *   1. one Receipt per Zoho payment, dated as in Zoho, into the bank ledger named by --bank, numbered by the Receipt series;
 *   2. per invoice applied: "against" that invoice for what it settled (Zoho's amount applied + the TDS withheld), the TDS going to
 *      TDS Receivable; what Zoho left unused goes on account (a Customer Advance: as an advance);
 *   3. a customer the books do not have yet is created (Customer role added to a supplier that is one).
 *
 * Without --commit it rehearses against an in-memory copy and writes nothing. Every id derives from Zoho's CustomerPayment ID, so a
 * re-run skips what is already posted.
 *
 *   pnpm --filter @minimalerp/migrate-zoho receipts -- --csv 1.csv [--csv 2.csv] --company <uuid> --actor <uuid> --bank "Yes Bank" [--commit]
 *
 * DATABASE_URL carries the connection string. Never commit it, the CSV, or the report.
 */

export type Gateway = Pick<PostgresBackend, 'post' | 'execute' | 'load' | 'get' | 'list'>;

/** One row of Zoho's export: a payment's header (repeated) and ONE invoice it was applied to. */
export interface ZohoPaymentRow {
  readonly paymentId: string;
  readonly paymentNumber: string;
  readonly date: string;
  readonly type: string;
  readonly customerName: string;
  readonly gstin: string;
  readonly amount: string;
  readonly unused: string;
  readonly bankCharges: string;
  readonly reference: string;
  readonly description: string;
  readonly depositTo: string;
  readonly invoiceNumber: string;
  readonly applied: string;
  readonly tds: string;
}

export interface ZohoPayment {
  readonly id: string;
  readonly rows: readonly ZohoPaymentRow[];
}

const col = (r: Record<string, string>, name: string): string => (r[name] ?? '').trim();

export function parseZohoPayments(csvText: string): ZohoPaymentRow[] {
  return parseCsvRecords(csvText).map((r) => ({
    paymentId: col(r, 'CustomerPayment ID'),
    paymentNumber: col(r, 'Payment Number'),
    date: col(r, 'Date'),
    type: col(r, 'Payment Type'),
    customerName: col(r, 'Customer Name'),
    gstin: col(r, 'GST Identification Number (GSTIN)'),
    amount: col(r, 'Amount'),
    unused: col(r, 'Unused Amount'),
    bankCharges: col(r, 'Bank Charges'),
    reference: col(r, 'Reference Number'),
    description: col(r, 'Description'),
    depositTo: col(r, 'Deposit To'),
    invoiceNumber: col(r, 'Invoice Number'),
    applied: col(r, 'Amount Applied to Invoice'),
    tds: col(r, 'Withholding Tax Amount'),
  }));
}

/** Rows sharing a CustomerPayment ID are one payment; payments oldest first (Zoho's number breaking a tie on the same day). */
export function groupPayments(rows: readonly ZohoPaymentRow[]): ZohoPayment[] {
  const by = new Map<string, ZohoPaymentRow[]>();
  for (const r of rows) {
    if (r.paymentId === '') continue;
    by.set(r.paymentId, [...(by.get(r.paymentId) ?? []), r]);
  }
  const seq = (n: string) => Number(/(\d+)\s*$/.exec(n)?.[1] ?? 0);
  return [...by.entries()]
    .map(([id, rs]) => ({ id, rows: rs }))
    .sort((a, b) => {
      const x = a.rows[0] as ZohoPaymentRow;
      const y = b.rows[0] as ZohoPaymentRow;
      return x.date < y.date ? -1 : x.date > y.date ? 1 : seq(x.paymentNumber) - seq(y.paymentNumber);
    });
}

/** The id a Zoho payment is posted under: derived from its CustomerPayment ID, so a re-run finds it. */
export const receiptIdOf = (companyId: string, paymentId: string): VoucherId => deterministicUuid(`zoho-payment|${companyId}|${paymentId}`) as VoucherId;

/** Paise, from Zoho's "1234.560" (three decimals, the last always 0 for INR). */
const paise = (s: string): bigint => (s.trim() === '' ? 0n : (parseMoney(Number(s).toFixed(2)) ?? 0n));
const lower = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
/** "24-25/097" and "24-25/97" are one number: the prefix, then the sequence without leading zeros. */
const numberKey = (n: string): string => lower(n).replace(/(\d+)\s*$/, (d) => String(Number(d)));

function findParty(masters: Masters, r: ZohoPaymentRow): Party | undefined {
  const active = masters.parties.filter((p) => p.isActive);
  if (r.gstin) {
    const byGstin = active.find((p) => p.gstin !== undefined && canonicalId(p.gstin) === canonicalId(r.gstin));
    if (byGstin) return byGstin;
  }
  return active.find((p) => lower(p.name) === lower(r.customerName));
}

export interface PlannedAllocation {
  readonly kind: 'against' | 'advance' | 'onAccount';
  readonly ref?: string;
  readonly amount: bigint;
  readonly tds?: bigint;
}

export interface PlannedReceipt {
  readonly payment: ZohoPayment;
  readonly customer: string;
  /** The customer in the books, when known before posting (by GSTIN, name, or the invoices the payment settles). */
  readonly partyId?: string;
  /** What the bank received: Zoho's Amount. */
  readonly received: bigint;
  readonly allocations: readonly PlannedAllocation[];
}

export interface ReceiptPlan {
  readonly receipts: readonly PlannedReceipt[];
  /** Customers to create (no party in the books by GSTIN or name), and suppliers that need the Customer role. */
  readonly newCustomers: readonly ZohoPaymentRow[];
  readonly problems: readonly string[];
}

/**
 * Each payment as the bills it settles. An invoice must be a posted Sales invoice of the same customer, and what this run settles on
 * it (with what earlier receipts already did) may not exceed it. The amounts must add up the way Zoho's do: Amount = applied + unused.
 */
export function planReceipts(payments: readonly ZohoPayment[], masters: Masters, vouchers: readonly Voucher[]): ReceiptPlan {
  const problems: string[] = [];
  const salesType = new Set(masters.voucherTypes.filter((t) => t.baseKind === 'sales').map((t) => t.id as string));
  const invoices = new Map<string, Voucher>();
  for (const v of vouchers) if (v.status === 'posted' && salesType.has(v.voucherTypeId)) invoices.set(numberKey(v.number), v);

  // Zoho's "25-26/001" is the books' "25-26/001" — or "SAL/25-26/0001" where the series kept its own prefix
  const invoiceFor = (zohoNumber: string): Voucher | undefined => {
    const key = numberKey(zohoNumber);
    return invoices.get(key) ?? [...invoices.entries()].find(([k]) => k.endsWith(`/${key}`))?.[1];
  };
  const newCustomers = new Map<string, ZohoPaymentRow>();
  const settledHere = new Map<string, bigint>();
  const receipts: PlannedReceipt[] = [];
  const posted = new Set<string>(vouchers.map((v) => v.id));
  for (const payment of payments) {
    const head = payment.rows[0] as ZohoPaymentRow;
    // already in the books (an earlier run): what it settled is in the open bills below, not to be counted again
    const done = posted.has(receiptIdOf(masters.company.id, payment.id));
    const where = `Zoho payment ${head.paymentNumber} (${head.date}, ${head.customerName})`;
    // the customer is the one whose invoices the payment settles (Zoho's "…PRIVATE LIMITED" may be the books' "…Pvt Ltd"), else by
    // GSTIN or name; only a payment that names no invoice of a customer the books have makes a new one
    const invoiceParty = payment.rows.map((r) => (r.invoiceNumber ? invoiceFor(r.invoiceNumber) : undefined)).find((v) => v !== undefined);
    const fromInvoice = invoiceParty ? masters.party((invoiceParty.content as unknown as { partyId: string }).partyId as never) : undefined;
    const party = fromInvoice ?? findParty(masters, head);
    if (!party && !newCustomers.has(lower(head.customerName))) newCustomers.set(lower(head.customerName), head);
    if (paise(head.bankCharges) !== 0n) problems.push(`${where}: has bank charges, which this import does not post`);

    const allocations: PlannedAllocation[] = [];
    let applied = 0n;
    for (const r of payment.rows) {
      if (r.invoiceNumber === '') continue;
      const amount = paise(r.applied) + paise(r.tds);
      applied += paise(r.applied);
      const inv = invoiceFor(r.invoiceNumber);
      if (!inv) {
        problems.push(`${where}: invoice ${r.invoiceNumber} is not in the books — import that year's invoices first`);
        continue;
      }
      if (party && (inv.content as unknown as { partyId?: string }).partyId !== party.id) {
        problems.push(`${where}: invoice ${r.invoiceNumber} is another customer's`);
        continue;
      }
      allocations.push({ kind: 'against', ref: inv.number, amount, ...(paise(r.tds) > 0n ? { tds: paise(r.tds) } : {}) });
      if (!done) settledHere.set(inv.number, (settledHere.get(inv.number) ?? 0n) + amount);
    }
    const unused = paise(head.unused);
    if (unused > 0n) allocations.push({ kind: lower(head.type) === 'customer advance' ? 'advance' : 'onAccount', amount: unused });
    const received = paise(head.amount);
    if (received !== applied + unused) {
      problems.push(`${where}: Zoho's amount ${formatMoney(received as never)} is not the ${formatMoney((applied + unused) as never)} it was applied as`);
    }
    if (allocations.length === 0) problems.push(`${where}: settles nothing`);
    receipts.push({ payment, customer: party?.name ?? head.customerName, ...(party ? { partyId: party.id } : {}), received, allocations });
  }

  // nothing may settle more of an invoice than is still open on it (receipts already in the books included)
  for (const [ref, here] of settledHere) {
    const inv = [...invoices.values()].find((v) => v.number === ref) as Voucher;
    const partyId = (inv.content as unknown as { partyId: string }).partyId;
    const open = openBills(vouchers, masters, customerLedgerOf(partyId as never)).find((b) => b.ref === ref)?.pending ?? 0n;
    if (here > open) problems.push(`Invoice ${ref}: these payments settle ${formatMoney(here as never)} but only ${formatMoney(open as never)} is open on it`);
  }
  return { receipts, newCustomers: [...newCustomers.values()], problems };
}

export interface Context {
  readonly companyId: CompanyId;
  readonly gw: Gateway;
  readonly bank: string;
  readonly log: (line: string) => void;
}

const failed = (what: string, r: { ok: false; issues: readonly { message: string; path?: string | undefined }[] }): Error =>
  new Error(`${what}: ${r.issues.map((i) => `${i.message}${i.path ? ` (${i.path})` : ''}`).join('; ')}`);

/** The customers the payments name that the books do not have, created; a supplier that is one gets the Customer role. */
export async function createCustomers(ctx: Context, plan: ReceiptPlan): Promise<Masters> {
  const { companyId, gw } = ctx;
  let masters = await gw.load(companyId);
  for (const z of plan.newCustomers) {
    const existing = findParty(masters, z);
    if (existing) {
      if ((existing.roles ?? []).includes('customer')) continue;
      const { id, companyId: _c, isActive: _a, creditLimit, ...rest } = existing as Party & { companyId?: unknown; isActive?: unknown };
      const r = await gw.execute({ companyId, command: { op: 'alter', kind: 'party', id, data: { ...rest, ...(creditLimit !== undefined ? { creditLimit: formatMoney(creditLimit) } : {}), roles: [...(existing.roles ?? []), 'customer'] } } });
      if (!r.ok) throw failed(`Customer role for "${existing.name}"`, r);
      continue;
    }
    const row = resolvePartyRow({
      name: z.customerName, gstin: z.gstin, pan: '', phone: '', email: '', address: '', stateCode: z.gstin ? z.gstin.slice(0, 2) : '', creditDays: '', creditLimit: '',
      gstRegistration: z.gstin ? 'regular' : '', pincode: '', country: 'India', shippingLines: '', shippingStateCode: '', shippingPincode: '', shippingCountry: '', roles: 'customer',
    });
    if (!row.ok) throw new Error(`Customer "${z.customerName}": ${row.errors.join('; ')}`);
    const r = await gw.execute({ companyId, command: { op: 'create', kind: 'party', id: deterministicUuid(`zoho-migrate|${companyId}|party|${z.customerName}`), data: row.data } });
    if (!r.ok) throw failed(`Customer "${z.customerName}"`, r);
    ctx.log(`Customer created: ${z.customerName}`);
  }
  masters = await gw.load(companyId);
  return masters;
}

export interface PostedReceipt {
  readonly zoho: string;
  readonly number: string;
  readonly date: string;
  readonly customer: string;
  readonly received: string;
  readonly skipped?: true;
}

export async function postReceipts(ctx: Context, plan: ReceiptPlan, masters: Masters): Promise<PostedReceipt[]> {
  const { companyId, gw } = ctx;
  const type = masters.voucherTypes.find((t) => t.baseKind === 'receipt' && t.isActive !== false);
  if (!type) throw new Error('No Receipt voucher type');
  const banks = masters.ledgers.filter((l) => l.isActive && masters.isCashOrBank(l.id));
  const bank = banks.find((l) => lower(l.name) === lower(ctx.bank));
  if (!bank) throw new Error(`No bank ledger called "${ctx.bank}". The bank and cash ledgers are: ${banks.map((l) => l.name).join(', ')}`);

  const out: PostedReceipt[] = [];
  for (const r of plan.receipts) {
    const head = r.payment.rows[0] as ZohoPaymentRow;
    const id = receiptIdOf(companyId, r.payment.id);
    const done = await gw.get(companyId, id);
    if (done) {
      out.push({ zoho: head.paymentNumber, number: done.number, date: done.date, customer: r.customer, received: formatMoney(r.received as never), skipped: true });
      continue;
    }
    const party = r.partyId ? masters.party(r.partyId as never) : findParty(masters, head);
    if (!party) throw new Error(`Zoho payment ${head.paymentNumber}: customer "${head.customerName}" is not in the books`);
    const amount = r.allocations.reduce((t, a) => t + a.amount, 0n);
    const narration = [`Zoho payment ${head.paymentNumber}`, head.reference, head.description].filter((s) => s !== '').join(' · ').slice(0, 500);
    const posted = await gw.post({
      companyId,
      draft: {
        id,
        voucherTypeId: type.id,
        date: head.date,
        accountLedgerId: bank.id,
        narration,
        lines: [
          {
            ledgerId: customerLedgerOf(party.id),
            amount: formatMoney(amount as never),
            allocations: r.allocations.map((a) => ({
              kind: a.kind,
              ...(a.ref ? { ref: a.ref } : {}),
              amount: formatMoney(a.amount as never),
              ...(a.tds ? { tds: formatMoney(a.tds as never) } : {}),
            })),
          },
        ],
      },
    });
    if (!posted.ok) throw failed(`Zoho payment ${head.paymentNumber} was refused`, posted);
    const v = posted.value.voucher;
    out.push({ zoho: head.paymentNumber, number: v.number, date: v.date, customer: party.name, received: formatMoney(r.received as never) });
    ctx.log(`${head.paymentNumber}\t${v.number}\t${v.date}\t${formatMoney(r.received as never)}\t${party.name}`);
  }
  return out;
}

interface Args {
  readonly csv: readonly string[];
  readonly company: string;
  readonly actor: string;
  readonly bank: string;
  readonly dbUrl: string;
  readonly commit: boolean;
  readonly out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const csv = argv.flatMap((a, i) => (a === '--csv' && argv[i + 1] !== undefined ? [argv[i + 1] as string] : []));
  const company = get('--company');
  const actor = get('--actor');
  const bank = get('--bank');
  const dbUrl = process.env['DATABASE_URL'];
  if (csv.length === 0 || !company || !actor || !bank || !dbUrl) {
    throw new Error('Usage: DATABASE_URL=... receipts --csv <path> [--csv <path> …] --company <uuid> --actor <uuid> --bank "<bank ledger>" [--commit] [--out <path>]');
  }
  return { csv, company, actor, bank, dbUrl, commit: argv.includes('--commit'), out: get('--out') ?? 'zoho-receipts-report.json' };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const companyId = args.company as CompanyId;
  const payments = groupPayments(args.csv.flatMap((file) => parseZohoPayments(readFileSync(file, 'utf8'))));

  const pool = new pg.Pool({ connectionString: args.dbUrl });
  const db = new PostgresBackend(pool, { actorId: args.actor, requestId: `zoho-receipts-${Date.now()}` });
  const report: Record<string, unknown> = { commit: args.commit };
  try {
    const masters = await db.load(companyId);
    const vouchers = await db.list(companyId);
    const plan = planReceipts(payments, masters, vouchers);
    const first = payments[0]?.rows[0];
    const last = payments.at(-1)?.rows[0];
    console.log(`Company: ${masters.company.name}`);
    console.log(`${payments.length} payments (${first?.date} … ${last?.date}), into "${args.bank}"; ${vouchers.length} vouchers already in the books`);
    console.log(`Customers: ${[...new Set(plan.receipts.map((r) => r.customer))].join('; ')}`);
    if (plan.newCustomers.length > 0) console.log(`Customers to create (or give the Customer role): ${plan.newCustomers.map((c) => c.customerName).join('; ')}`);
    const tds = plan.receipts.reduce((t, r) => t + r.allocations.reduce((s, a) => s + (a.tds ?? 0n), 0n), 0n);
    const received = plan.receipts.reduce((t, r) => t + r.received, 0n);
    console.log(`Received ${formatMoney(received as never)}; TDS deducted ${formatMoney(tds as never)}`);
    for (const r of plan.receipts.filter((x) => x.allocations.some((a) => a.kind !== 'against'))) {
      const head = r.payment.rows[0] as ZohoPaymentRow;
      for (const a of r.allocations.filter((x) => x.kind !== 'against')) console.log(`  ${head.paymentNumber} ${r.customer}: ${formatMoney(a.amount as never)} ${a.kind === 'advance' ? 'as an advance' : 'on account'}`);
    }
    for (const p of plan.problems) console.log(`PROBLEM: ${p}`);
    report['problems'] = plan.problems;
    if (plan.problems.length > 0) throw new Error('Fix the problems above first');

    let gw: Gateway = db;
    if (!args.commit) {
      // rehearse on an in-memory copy of the masters: every invoice a receipt settles was checked against the real books above, and
      // here each receipt is posted through the same rules the database applies
      gw = new MemoryBackend(masters);
    }
    const ctx: Context = { companyId, gw, bank: args.bank, log: args.commit ? (l) => console.log(l) : () => {} };
    const after = await createCustomers(ctx, plan);
    const posted = await postReceipts(ctx, plan, after);
    report['posted'] = posted;
    console.log(`\n${args.commit ? 'POSTED' : 'Dry run OK — would post'} ${posted.filter((p) => !p.skipped).length} receipts${args.commit ? '' : '. Nothing was written.'}`);
  } catch (e) {
    report['error'] = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    await pool.end();
  }
}

// run only as the script itself, not when a test imports the steps
if (process.argv[1]?.replaceAll('\\', '/').endsWith('src/receipts.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
