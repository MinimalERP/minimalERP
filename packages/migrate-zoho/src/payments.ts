#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { MemoryBackend } from '@minimalerp/adapter-memory';
import { PostgresBackend } from '@minimalerp/adapter-postgres';
import {
  type CompanyId,
  type Ledger,
  type Masters,
  type Money,
  type Party,
  type Voucher,
  type VoucherId,
  canonicalId,
  customerLedgerOf,
  deterministicUuid,
  formatMoney,
  money,
  openBills,
  parseMoney,
} from '@minimalerp/domain';
import pg from 'pg';
import { type ZohoPayment, groupByPayment, invoiceFilterOf, parseZohoPaymentsCsv } from './csv';

/**
 * Posts Zoho Books customer payments as Receipts, each SET AGAINST the invoices it paid in Zoho, so the Outstanding report shows the
 * same open invoices Zoho does. Run it after `post` has brought the invoices in. A one-off migration.
 *
 *   - the customer is found by GSTIN, else its exact name; the bank or cash ledger by Zoho's "Deposit To" account name (or --deposit maps one);
 *   - each invoice the payment was applied to must be an open bill of that customer with the same number (prefix and sequence), and
 *     the payment may not settle more of it than is pending; TDS the customer deducted settles the bill too, and goes to TDS
 *     Receivable;
 *   - money Zoho left unapplied ("Unused Amount") is posted on account;
 *   - Zoho's bank charges are NOT posted (a receipt only credits the customer): they are listed, to be journaled by hand.
 *
 * Receipts are numbered by minimalERP's own Receipt series, in date order; the Zoho payment number is in each narration.
 * Without --commit it checks everything against the books and rehearses the posting in memory, writing nothing.
 * Every receipt's id comes from Zoho's payment ID, so a re-run skips what is already there.
 *
 *   pnpm --filter @minimalerp/migrate-zoho payments -- --csv Customer_Payment.csv [--csv …] --company <uuid> --actor <uuid>
 *     [--only "1..250"] [--deposit "Undeposited Funds=HDFC Bank,Petty Cash=Cash"] [--commit] [--out zoho-payments-report.json]
 *
 * DATABASE_URL carries the connection string. Never commit it, the CSV, or the report.
 */

export type PaymentGateway = Pick<PostgresBackend, 'post' | 'get'>;

const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();
const lower = (s: string | undefined): string => tidy(s ?? '').toLowerCase();
const seqOf = (n: string): number => Number(/(\d+)\s*$/.exec(n)?.[1] ?? Number.NaN);
/** An invoice number however it is padded: "25-26/97" and "25-26/097" are both "25-26/97". */
const unpadded = (n: string): string => tidy(n).toUpperCase().replace(/0*(\d+)$/, '$1');
/**
 * Whether a bill of the books is the Zoho invoice: the same number, or the same number under a prefix of the series' own
 * ("SAL/25-26/0001" is Zoho's "25-26/001").
 */
const isBillOf = (ref: string, zoho: string): boolean => {
  const r = unpadded(ref);
  const z = unpadded(zoho);
  return r === z || (r.endsWith(z) && /[^A-Z0-9]$/.test(r.slice(0, -z.length)));
};
/** A Zoho amount; an empty cell is nothing. */
const amountOf = (s: string): Money | undefined => (s.trim() === '' ? money(0n) : parseMoney(s.replace(/,/g, '').trim()));

/** The id a payment is posted under: derived from Zoho's own payment ID, so a re-run finds it. */
export const receiptIdOf = (companyId: string, p: ZohoPayment): VoucherId =>
  deterministicUuid(`zoho-payment-post|${companyId}|${p.rows[0]?.paymentId || p.paymentNumber}`) as VoucherId;

export interface PlannedBill {
  readonly zoho: string;
  /** The bill's reference in minimalERP: the Sales Invoice's own number. */
  readonly ref: string;
  /** The whole of the bill this settles, TDS included. */
  readonly amount: Money;
  readonly tds: Money;
}

export interface PlannedReceipt {
  readonly zoho: ZohoPayment;
  readonly id: VoucherId;
  readonly date: string;
  readonly party: Party;
  readonly bank: Ledger;
  readonly bills: readonly PlannedBill[];
  readonly onAccount: Money;
  /** What reaches the bank: Zoho's Amount. */
  readonly received: Money;
  readonly bankCharges: Money;
  readonly narration: string;
}

export interface PaymentPlan {
  readonly receipts: readonly PlannedReceipt[];
  /** Payments already in the books from an earlier run. */
  readonly skipped: readonly string[];
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Checks every payment against the books as they stand (`vouchers`: everything posted so far) and works out the receipt for it. Nothing
 * is posted here; a payment with a problem gets no receipt.
 */
export function planPayments(payments: readonly ZohoPayment[], masters: Masters, vouchers: readonly Voucher[], deposit: ReadonlyMap<string, string> = new Map()): PaymentPlan {
  const companyId = masters.company.id;
  const problems: string[] = [];
  const warnings: string[] = [];
  const skipped: string[] = [];
  const receipts: PlannedReceipt[] = [];
  const posted = new Set(vouchers.map((v) => v.id));
  const tdsLedger = masters.systemLedger('tds-receivable');
  // what each customer still owes, bill by bill — reduced as this run settles them, so two payments cannot both settle the same rupee
  const pendingByLedger = new Map<string, { ref: string; pending: bigint }[]>();
  const billsOf = (ledgerId: Ledger['id']) => {
    let bills = pendingByLedger.get(ledgerId);
    if (!bills) {
      bills = openBills(vouchers, masters, ledgerId).filter((b) => b.side === 'debit').map((b) => ({ ref: b.ref, pending: b.pending as bigint }));
      pendingByLedger.set(ledgerId, bills);
    }
    return bills;
  };
  const banks = masters.ledgers.filter((l) => l.isActive && masters.isCashOrBank(l.id));

  const sorted = [...payments].sort((a, b) => (a.rows[0]?.date ?? '').localeCompare(b.rows[0]?.date ?? '') || seqOf(a.paymentNumber) - seqOf(b.paymentNumber));
  for (const p of sorted) {
    const z = p.rows[0];
    if (!z) continue;
    const id = receiptIdOf(companyId, p);
    if (posted.has(id)) {
      skipped.push(p.paymentNumber);
      continue;
    }
    const at = `Payment ${p.paymentNumber} (${z.date}, ${z.customerName})`;
    const fail = (why: string) => problems.push(`${at}: ${why}`);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(z.date)) {
      fail(`the date "${z.date}" is not YYYY-MM-DD`);
      continue;
    }
    if (!masters.financialYears.some((y) => z.date >= y.start && z.date <= y.end)) {
      fail('no financial year covers its date');
      continue;
    }
    // GSTIN, else the exact name — as the invoices were matched
    const active = masters.parties.filter((x) => x.isActive);
    const party =
      (z.gstin ? active.find((x) => x.gstin !== undefined && canonicalId(x.gstin) === canonicalId(z.gstin)) : undefined) ??
      active.find((x) => lower(x.name) === lower(z.customerName));
    if (!party || !masters.ledger(customerLedgerOf(party.id))) {
      fail(party ? `"${party.name}" is not a customer` : `customer "${z.customerName}" is not in the books`);
      continue;
    }
    const bankName = deposit.get(lower(z.depositTo)) ?? z.depositTo;
    const bank = banks.find((l) => lower(l.name) === lower(bankName));
    if (!bank) {
      fail(`deposited to "${z.depositTo}", which is no cash or bank ledger here (map it with --deposit "${z.depositTo}=<ledger>")`);
      continue;
    }

    const amount = amountOf(z.amount);
    const unused = amountOf(z.unusedAmount);
    const charges = amountOf(z.bankCharges);
    if (amount === undefined || unused === undefined || charges === undefined || amount <= 0n) {
      fail(`cannot read its amounts (Amount "${z.amount}", Unused "${z.unusedAmount}", Bank Charges "${z.bankCharges}")`);
      continue;
    }
    const applied = p.rows.filter((r) => r.invoiceNumber !== '');
    const parts = applied.map((r) => ({ zoho: r.invoiceNumber, applied: amountOf(r.appliedAmount), tds: amountOf(r.tds) }));
    if (parts.some((x) => x.applied === undefined || x.tds === undefined)) {
      fail('cannot read an amount applied to an invoice');
      continue;
    }
    const sumApplied = parts.reduce((s, x) => s + (x.applied as bigint), 0n);
    const sumTds = parts.reduce((s, x) => s + (x.tds as bigint), 0n);
    // Zoho's Amount is what the customer paid; whether "applied" counts the TDS as well is told by which way the payment adds up
    let tdsInApplied: boolean;
    if (sumApplied + unused === amount) tdsInApplied = false;
    else if (sumTds > 0n && sumApplied - sumTds + unused === amount) tdsInApplied = true;
    else {
      fail(`applied ${formatMoney(money(sumApplied))} + unused ${formatMoney(unused)} does not come to the ${formatMoney(amount)} paid`);
      continue;
    }
    if (sumTds > 0n && !tdsLedger) {
      fail('TDS was deducted but the company has no TDS Receivable ledger (reopen the company to add it)');
      continue;
    }

    const open = billsOf(customerLedgerOf(party.id));
    const bills: PlannedBill[] = [];
    const settling: { ref: string; pending: bigint }[] = [];
    let bad = false;
    for (const x of parts) {
      const tds = x.tds as bigint;
      const whole = tdsInApplied ? (x.applied as bigint) : (x.applied as bigint) + tds;
      if (whole <= 0n) continue;
      const found = open.filter((b) => b.pending > 0n && isBillOf(b.ref, x.zoho));
      const bill = found[0];
      if (!bill || found.length > 1) {
        fail(bill ? `invoice ${x.zoho} could be any of ${found.map((b) => b.ref).join(', ')}` : `invoice ${x.zoho} is not an open bill of "${party.name}"`);
        bad = true;
        break;
      }
      // the same invoice twice in one payment: what the first row settles is not pending for the second
      const already = bills.filter((b) => b.ref === bill.ref).reduce((t, b) => t + b.amount, 0n);
      if (whole + already > bill.pending) {
        fail(`settles ${formatMoney(money(whole + already))} of ${bill.ref}, which has only ${formatMoney(money(bill.pending))} pending`);
        bad = true;
        break;
      }
      bills.push({ zoho: x.zoho, ref: bill.ref, amount: money(whole), tds: money(tds) });
      settling.push(bill);
    }
    if (bad) continue;
    bills.forEach((b, i) => {
      const bill = settling[i];
      if (bill) bill.pending -= b.amount;
    });
    if (charges > 0n) warnings.push(`${at}: bank charges ${formatMoney(charges)} are not posted — journal them to ${bank.name}`);

    const narration = tidy(
      [`Zoho payment ${p.paymentNumber}`, z.mode, z.reference ? `Ref ${z.reference}` : '', z.description].filter((s) => s !== '').join(' · '),
    ).slice(0, 500);
    receipts.push({ zoho: p, id, date: z.date, party, bank, bills, onAccount: unused, received: amount, bankCharges: charges, narration });
  }
  return { receipts, skipped, problems, warnings };
}

export interface PostedReceipt {
  readonly zoho: string;
  readonly number: string;
  readonly date: string;
  readonly party: string;
  readonly received: string;
  readonly against: readonly string[];
  readonly onAccount: string;
}

export async function postReceipts(companyId: CompanyId, gw: PaymentGateway, plan: PaymentPlan, masters: Masters, log: (line: string) => void = () => {}): Promise<PostedReceipt[]> {
  const type = masters.voucherTypes.find((t) => t.baseKind === 'receipt');
  if (!type) throw new Error('No Receipt voucher type');
  const out: PostedReceipt[] = [];
  for (const r of plan.receipts) {
    if (await gw.get(companyId, r.id)) continue;
    const allocations = [
      ...r.bills.map((b) => ({ kind: 'against' as const, ref: b.ref, amount: formatMoney(b.amount), ...(b.tds > 0n ? { tds: formatMoney(b.tds) } : {}) })),
      ...(r.onAccount > 0n ? [{ kind: 'onAccount' as const, amount: formatMoney(r.onAccount) }] : []),
    ];
    const settled = money(r.bills.reduce((s, b) => s + b.amount, 0n) + r.onAccount);
    const posted = await gw.post({
      companyId,
      draft: {
        id: r.id,
        voucherTypeId: type.id,
        date: r.date,
        narration: r.narration,
        accountLedgerId: r.bank.id,
        lines: [{ ledgerId: customerLedgerOf(r.party.id), amount: formatMoney(settled), allocations }],
      },
    });
    if (!posted.ok) throw new Error(`Payment ${r.zoho.paymentNumber} was refused: ${posted.issues.map((i) => `${i.message}${i.path ? ` (${i.path})` : ''}`).join('; ')}`);
    const v = posted.value.voucher;
    out.push({ zoho: r.zoho.paymentNumber, number: v.number, date: v.date, party: r.party.name, received: formatMoney(r.received), against: r.bills.map((b) => b.ref), onAccount: formatMoney(r.onAccount) });
    log(`${r.zoho.paymentNumber}\t${v.number}\t${v.date}\t${formatMoney(r.received)}\t${r.party.name}\t${r.bills.map((b) => b.ref).join(', ') || 'on account'}`);
  }
  return out;
}

interface Args {
  readonly csv: readonly string[];
  readonly company: string;
  readonly actor: string;
  readonly dbUrl: string;
  readonly only: string | undefined;
  readonly deposit: ReadonlyMap<string, string>;
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
  const dbUrl = process.env['DATABASE_URL'];
  if (csv.length === 0 || !company || !actor || !dbUrl) {
    throw new Error('Usage: DATABASE_URL=... payments --csv <path> [--csv <path> …] --company <uuid> --actor <uuid> [--only <range>] [--deposit "Zoho account=Ledger,…"] [--commit] [--out <path>]');
  }
  const deposit = new Map(
    (get('--deposit') ?? '')
      .split(',')
      .map((p) => p.split('='))
      .filter((p): p is [string, string] => p.length === 2)
      .map(([a, b]) => [lower(a), tidy(b)] as const),
  );
  return { csv, company, actor, dbUrl, only: get('--only'), deposit, commit: argv.includes('--commit'), out: get('--out') ?? 'zoho-payments-report.json' };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const companyId = args.company as CompanyId;
  const filter = invoiceFilterOf(args.only);
  const all = groupByPayment(args.csv.flatMap((file) => parseZohoPaymentsCsv(readFileSync(file, 'utf8'))));
  const payments = filter ? all.filter((p) => filter(p.paymentNumber)) : all;

  const pool = new pg.Pool({ connectionString: args.dbUrl });
  const db = new PostgresBackend(pool, { actorId: args.actor, requestId: `zoho-payments-${Date.now()}` });
  const report: Record<string, unknown> = { commit: args.commit };
  try {
    const masters = await db.load(companyId);
    const vouchers = await db.list(companyId);
    const plan = planPayments(payments, masters, vouchers, args.deposit);
    const total = plan.receipts.reduce((s, r) => s + r.received, 0n);

    console.log(`Company: ${masters.company.name}; ${vouchers.length} vouchers already in the books`);
    console.log(`${payments.length} Zoho payments: ${plan.receipts.length} to post (${formatMoney(money(total))}), ${plan.skipped.length} already posted`);
    const deposits = [...new Set(plan.receipts.map((r) => `${r.zoho.rows[0]?.depositTo} → ${r.bank.name}`))];
    console.log(`Deposited to: ${deposits.join('; ') || 'none'}`);
    for (const w of plan.warnings) console.log(`NOTE: ${w}`);
    for (const p of plan.problems) console.log(`PROBLEM: ${p}`);
    Object.assign(report, { skipped: plan.skipped, problems: plan.problems, warnings: plan.warnings });
    if (plan.problems.length > 0) throw new Error(`Fix the ${plan.problems.length} problems above first (or leave those payments out with --only)`);

    // rehearse on an in-memory copy of the company: the bills were checked against the real books above, the drafts are checked here
    const gw: PaymentGateway = args.commit ? db : new MemoryBackend(masters);
    const posted = await postReceipts(companyId, gw, plan, masters, args.commit ? (l) => console.log(l) : () => {});
    report['posted'] = args.commit ? posted : plan.receipts.map((r) => ({ zoho: r.zoho.paymentNumber, date: r.date, party: r.party.name, received: formatMoney(r.received), against: r.bills.map((b) => b.ref), onAccount: formatMoney(r.onAccount) }));
    console.log(`\n${args.commit ? 'POSTED' : 'Dry run OK — would post'} ${posted.length} receipts${args.commit ? '' : '. Nothing was written.'}`);
  } catch (e) {
    report['error'] = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    await pool.end();
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('src/payments.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
