#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { MemoryBackend } from '@minimalerp/adapter-memory';
import { PostgresBackend } from '@minimalerp/adapter-postgres';
import {
  type CompanyId,
  type Masters,
  type Party,
  type PartyDetails,
  type StockItem,
  type Voucher,
  type VoucherId,
  canonicalId,
  deriveGstHeader,
  deterministicUuid,
  formatMoney,
  grandTotal,
  parseMoney,
  resolveItemRow,
  resolvePartyRow,
} from '@minimalerp/domain';
import pg from 'pg';
import { type ZohoInvoice, type ZohoLine, groupByInvoice, invoiceFilterOf, parseZohoCsv } from './csv';

/**
 * Posts Zoho Books invoices DIRECTLY as Sales Invoices, one by one in Zoho's own number order, so that each gets the SAME number in
 * minimalERP (the app numbers a voucher from its series when it is posted — there is no per-voucher number). A one-off migration, not
 * the everyday path (that is `run.ts`, the AI Inbox staging).
 *
 *   1. the customers and stock items the invoices need, created as masters. Customers match by GSTIN or exact name; items by PART
 *      NUMBER (Zoho writes one part as "20232-3- PIN…" and "[20232-3] PIN…"), else the exact name — never the closest one;
 *   2. stock for exactly what these invoices sell, at rate 0 (a sale may never take stock below zero): an Opening Stock voucher per new
 *      item, and one Stock Journal "in" for the items already in the books, so their stock today stays what it is;
 *   3. the invoices: before each, the Sales series' next number must BE the Zoho number; after, the posted number must match. Else it stops.
 *
 * Without --commit it rehearses everything against an in-memory copy of the company and writes nothing to the database.
 * Every id is deterministic, so a re-run skips what is already there and carries on where it stopped.
 *
 *   pnpm --filter @minimalerp/migrate-zoho post -- --csv Invoice.csv --company <uuid> --actor <uuid> --only "26-27/002..26-27/145"
 *     [--same "15213=EC15213"] [--commit]
 *
 * --same maps a Zoho part number onto an item already in the books under another code. DATABASE_URL carries the connection string.
 * Never commit it, the CSV, or the report.
 */

export type Gateway = Pick<PostgresBackend, 'post' | 'execute' | 'load' | 'get' | 'seriesStatus'>;

interface Args {
  readonly csv: string;
  readonly company: string;
  readonly actor: string;
  readonly dbUrl: string;
  readonly only: string | undefined;
  readonly same: ReadonlyMap<string, string>;
  readonly commit: boolean;
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
  const dbUrl = process.env['DATABASE_URL'];
  if (!csv || !company || !actor || !dbUrl) throw new Error('Usage: DATABASE_URL=... post --csv <path> --company <uuid> --actor <uuid> [--only <range>] [--same a=b,…] [--commit] [--out <path>]');
  const same = new Map(
    (get('--same') ?? '')
      .split(',')
      .map((p) => p.split('='))
      .filter((p): p is [string, string] => p.length === 2)
      .map(([a, b]) => [canonicalId(a), canonicalId(b)] as const),
  );
  return { csv, company, actor, dbUrl, only: get('--only'), same, commit: argv.includes('--commit'), out: get('--out') ?? 'zoho-post-report.json' };
}

// compared by sequence, not text: Zoho wrote one number unpadded ("26-27/97" for 26-27/097)
const seqOf = (n: string): number => Number(/(\d+)\s*$/.exec(n)?.[1] ?? Number.NaN);
const isService = (l: ZohoLine): boolean => l.hsn.startsWith('99');
const unitOf = (l: ZohoLine): string => (l.usageUnit === '' ? 'Nos' : l.usageUnit);
const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();
const lower = (s: string | undefined): string => tidy(s ?? '').toLowerCase();
const partKey = (code: string): string => canonicalId(code).replace(/[^A-Z0-9]/g, '');

/**
 * The part number leading a Zoho item name, and the rest. "[14188-42]PLT,ORIF" → 14188-42; "14188-4 PLT,ORIF" → 14188-4;
 * "52402-R1 - Contact Ring" → 52402-R1; "14188-23-PLT,ORIF" → 14188-23 (a dash segment belongs to the number only when it has a digit).
 * A name whose first word has no digit ("Burner Flange") has no part number.
 */
export function partOf(itemName: string): { code: string | undefined; description: string } {
  const s = tidy(itemName);
  const bracket = /^\[\s*([^\]]+?)\s*\]\s*-?\s*(.*)$/.exec(s);
  if (bracket) return { code: bracket[1] as string, description: bracket[2] as string };
  const m = /^([A-Za-z0-9]+(?:-[A-Za-z0-9]*\d[A-Za-z0-9]*)*)(.*)$/.exec(s);
  const code = m?.[1] ?? '';
  if (!/\d/.test(code)) return { code: undefined, description: s };
  return { code, description: (m?.[2] ?? '').replace(/^[\s-]+/, '') };
}

/** One part, however Zoho spelled it: its part number, else its whole name. */
const keyOf = (l: ZohoLine): string => {
  const { code } = partOf(l.itemName);
  return code ? partKey(code) : `name:${lower(l.itemName)}`;
};

/** Strict: the item carrying that part number (or the one --same names), else the exact name. Never the closest one. */
function findItem(masters: Masters, key: string, name: string, same: ReadonlyMap<string, string>): StockItem | undefined {
  const active = masters.stockItems.filter((i) => i.isActive);
  if (!key.startsWith('name:')) {
    const want = same.get(key) ?? key;
    const byCode = active.find((i) => i.code !== undefined && partKey(i.code) === want);
    if (byCode) return byCode;
  }
  return active.find((i) => lower(i.name) === lower(name));
}

/** Strict: GSTIN, else the exact name. */
function findParty(masters: Masters, l: ZohoLine): Party | undefined {
  const active = masters.parties.filter((p) => p.isActive);
  if (l.gstin) {
    const byGstin = active.find((p) => p.gstin !== undefined && canonicalId(p.gstin) === canonicalId(l.gstin));
    if (byGstin) return byGstin;
  }
  return active.find((p) => lower(p.name) === lower(l.customerName));
}

/** Zoho's "27-Maharashtra" → "27". */
const posCode = (l: ZohoLine): string | undefined => /^(\d{2})/.exec(l.placeOfSupply)?.[1];

/** What the Party Details window starts a sale with (`partyDetailsOfParty` in the app), with Zoho's own place of supply for the invoice. */
function partyDetailsOf(party: Party, l: ZohoLine): PartyDetails {
  const place = posCode(l) ?? party.stateCode;
  return {
    partyId: party.id,
    mailingName: party.name,
    billTo: { lines: party.address, stateCode: party.stateCode, country: party.country ?? 'India', pincode: party.pincode },
    ...(party.gstin ? { gstRegistration: party.gstRegistration ?? 'regular', gstin: canonicalId(party.gstin) } : {}),
    ...(place ? { placeOfSupply: place } : {}),
  } as PartyDetails;
}

interface PlannedItem {
  readonly key: string;
  readonly zoho: ZohoLine;
  readonly code: string | undefined;
  /** The name a NEW item is created with: "<part number> - <description>", or Zoho's own name when it has no part number. */
  readonly name: string;
  readonly zohoNames: Set<string>;
  qty: number;
  readonly existing: StockItem | undefined;
}

interface Plan {
  readonly invoices: readonly ZohoInvoice[];
  readonly units: readonly string[];
  readonly parties: readonly { readonly zoho: ZohoLine; readonly existing: Party | undefined }[];
  readonly items: readonly PlannedItem[];
  readonly problems: readonly string[];
}

export function planOf(invoices: readonly ZohoInvoice[], masters: Masters, same: ReadonlyMap<string, string> = new Map()): Plan {
  const problems: string[] = [];
  const lines = invoices.flatMap((i) => i.rows);

  // numbers must run without a gap; a gap is reported, never papered over here
  const seqs = invoices.map((i) => seqOf(i.invoiceNumber)).sort((a, b) => a - b);
  seqs.forEach((n, i) => {
    if (i > 0 && n !== (seqs[i - 1] as number) + 1) problems.push(`Zoho numbers jump from ${seqs[i - 1]} to ${n}`);
  });

  const units = [...new Set(lines.filter((l) => !isService(l)).map(unitOf))].filter((u) => !masters.units.some((m) => lower(m.symbol) === lower(u)));

  const parties = new Map<string, { zoho: ZohoLine; existing: Party | undefined }>();
  for (const l of lines) if (!parties.has(l.customerName)) parties.set(l.customerName, { zoho: l, existing: findParty(masters, l) });

  const items = new Map<string, PlannedItem>();
  for (const l of lines) {
    if (isService(l)) continue;
    const key = keyOf(l);
    const seen = items.get(key);
    if (seen) {
      seen.qty += Number(l.quantity);
      seen.zohoNames.add(tidy(l.itemName));
      continue;
    }
    const { code, description } = partOf(l.itemName);
    const name = code ? `${code} - ${description}` : tidy(l.itemName);
    items.set(key, { key, zoho: l, code, name, zohoNames: new Set([tidy(l.itemName)]), qty: Number(l.quantity), existing: findItem(masters, key, name, same) });
  }
  return { invoices, units, parties: [...parties.values()], items: [...items.values()], problems };
}

export interface Context {
  readonly companyId: CompanyId;
  readonly gw: Gateway;
  readonly same: ReadonlyMap<string, string>;
  readonly log: (line: string) => void;
}

const failed = (what: string, r: { ok: false; issues: readonly { message: string; path?: string | undefined }[] }): Error =>
  new Error(`${what}: ${r.issues.map((i) => `${i.message}${i.path ? ` (${i.path})` : ''}`).join('; ')}`);

export async function createMasters(ctx: Context, plan: Plan): Promise<Masters> {
  const { companyId, gw } = ctx;
  const run = async (op: 'create' | 'alter', kind: string, id: string, data: unknown): Promise<void> => {
    const r = await gw.execute({ companyId, command: { op, kind, id, data } });
    if (!r.ok) throw failed(`Could not ${op} ${kind} ${id}`, r);
  };
  const newId = (kind: string, key: string) => deterministicUuid(`zoho-migrate|${companyId}|${kind}|${key}`);

  for (const u of plan.units) await run('create', 'unit', newId('unit', u), { symbol: u.charAt(0).toUpperCase() + u.slice(1).toLowerCase(), name: u, decimals: 0 });

  for (const p of plan.parties) {
    const z = p.zoho;
    if (p.existing) {
      // a supplier we now also invoice: the Customer role added, every other detail sent back exactly as it is
      if ((p.existing.roles ?? []).includes('customer')) continue;
      const { id, companyId: _c, isActive: _a, creditLimit, ...rest } = p.existing as Party & { companyId?: unknown; isActive?: unknown };
      await run('alter', 'party', id, { ...rest, ...(creditLimit !== undefined ? { creditLimit: formatMoney(creditLimit) } : {}), roles: [...(p.existing.roles ?? []), 'customer'] });
      ctx.log(`Customer role added to "${p.existing.name}"`);
      continue;
    }
    const row = resolvePartyRow({
      name: z.customerName, gstin: z.gstin, pan: '', phone: '', email: z.primaryEmail,
      address: [z.billingAddress, z.billingCity, z.billingState].filter((s) => s !== '').join(', '),
      stateCode: z.gstin ? z.gstin.slice(0, 2) : (posCode(z) ?? ''), creditDays: z.paymentTermsDays, creditLimit: '', gstRegistration: z.gstin ? 'regular' : '',
      pincode: z.billingCode, country: 'India', shippingLines: '', shippingStateCode: '', shippingPincode: '', shippingCountry: '', roles: 'customer',
    });
    if (!row.ok) throw new Error(`Customer "${z.customerName}": ${row.errors.join('; ')}`);
    await run('create', 'party', newId('party', z.customerName), row.data);
  }

  let masters = await gw.load(companyId);
  for (const it of plan.items.filter((x) => !x.existing)) {
    const row = resolveItemRow({ name: it.name, code: it.code ?? '', alias: '', group: '', unit: unitOf(it.zoho), hsn: it.zoho.hsn, gstRate: '18', itemType: '' }, masters);
    if (!row.ok) throw new Error(`Item "${it.name}": ${row.errors.join('; ')}`);
    await run('create', 'stockItem', newId('stockItem', it.key), row.data);
  }
  masters = await gw.load(companyId);
  return masters;
}

function mainGodown(masters: Masters) {
  const active = masters.warehouses.filter((w) => w.isActive);
  const main = active.length === 1 ? active[0] : active.find((w) => lower(w.name) === 'main location');
  if (!main) throw new Error(`Which godown? There are ${active.length}: ${active.map((w) => w.name).join(', ')}`);
  return main;
}

export async function postStock(ctx: Context, plan: Plan, masters: Masters): Promise<void> {
  const { companyId, gw } = ctx;
  const opening = masters.voucherTypes.find((t) => t.baseKind === 'stockOpening');
  const journal = masters.voucherTypes.find((t) => t.baseKind === 'stockJournal');
  const firstDate = plan.invoices.map((i) => i.rows[0]?.invoiceDate ?? '').sort()[0] ?? '';
  const fy = masters.financialYears.find((y) => firstDate >= y.start && firstDate <= y.end);
  if (!opening || !journal || !fy) throw new Error('No Opening Stock / Stock Journal voucher type, or no financial year for the invoices');
  const godown = mainGodown(masters);
  const itemOf = (it: PlannedItem): StockItem => {
    const item = findItem(masters, it.key, it.name, ctx.same);
    if (!item) throw new Error(`Item "${it.name}" is not in the books`);
    return item;
  };

  const fresh = plan.items.filter((i) => !i.existing);
  for (const it of fresh) {
    const item = itemOf(it);
    const r = await gw.post({
      companyId,
      draft: { id: deterministicUuid(`zoho-migrate|${companyId}|opening|${item.id}`), voucherTypeId: opening.id, date: fy.start, itemId: item.id, warehouseId: godown.id, qty: String(it.qty), rate: '0' },
    });
    if (!r.ok) throw failed(`Opening stock for "${it.name}"`, r);
  }

  // items already in the books keep the stock they have today: what these invoices sell comes in once, at the start of the year
  const known = plan.items.filter((i) => i.existing);
  if (known.length > 0) {
    const r = await gw.post({
      companyId,
      draft: {
        id: deterministicUuid(`zoho-migrate|${companyId}|stock-in`),
        voucherTypeId: journal.id,
        date: fy.start,
        narration: `Zoho migration: stock sold on Zoho invoices ${plan.invoices[0]?.invoiceNumber} to ${plan.invoices.at(-1)?.invoiceNumber}, rate 0`.slice(0, 200),
        entries: known.map((it) => ({ itemId: itemOf(it).id, warehouseId: godown.id, direction: 'in', qty: String(it.qty), rate: '0' })),
      },
    });
    if (!r.ok) throw failed('Stock in for items already in the books', r);
  }
  ctx.log(`Stock at rate 0 in ${godown.name}, dated ${fy.start}: opening for ${fresh.length} new items; one stock-in for ${known.length} existing items`);
}

interface Posted {
  readonly zoho: string;
  readonly number: string;
  readonly date: string;
  readonly party: string;
  readonly total: string;
  readonly skipped?: true;
}

export async function postInvoices(ctx: Context, plan: Plan, masters: Masters): Promise<Posted[]> {
  const { companyId, gw } = ctx;
  const type = masters.voucherTypes.find((t) => t.baseKind === 'sales');
  if (!type) throw new Error('No Sales voucher type');
  const ledgers = masters.ledgers.filter((l) => l.isActive && l.reservedKey === undefined && masters.groups.isWithinReserved(l.groupId, 'sales-accounts'));
  const ledger = ledgers.length === 1 ? ledgers[0] : ledgers.find((l) => /^sales( account)?$/i.test(l.name));
  if (!ledger) throw new Error(`Which sales ledger? ${ledgers.map((l) => l.name).join(', ')}`);
  const godown = mainGodown(masters);
  const planned = new Map(plan.items.map((i) => [i.key, i]));
  const out: Posted[] = [];

  for (const inv of [...plan.invoices].sort((a, b) => seqOf(a.invoiceNumber) - seqOf(b.invoiceNumber))) {
    const z = inv.rows[0] as ZohoLine;
    const id = deterministicUuid(`zoho-invoice-post|${companyId}|${z.invoiceId || inv.invoiceNumber}`);
    const done = await gw.get(companyId, id as VoucherId);
    if (done) {
      if (seqOf(done.number) !== seqOf(inv.invoiceNumber)) throw new Error(`${inv.invoiceNumber} was posted earlier as ${done.number}: stopping`);
      out.push({ zoho: inv.invoiceNumber, number: done.number, date: done.date, party: z.customerName, total: '', skipped: true });
      continue;
    }

    const fy = masters.financialYears.find((y) => z.invoiceDate >= y.start && z.invoiceDate <= y.end);
    const series = fy ? masters.seriesFor(type.id, fy.id) : undefined;
    if (!series) throw new Error(`No Sales numbering series for ${z.invoiceDate}`);
    const next = await gw.seriesStatus(companyId, series.id);
    const expected = seqOf(inv.invoiceNumber);
    if (!next.ok || next.value.nextValue !== expected) {
      throw new Error(`${inv.invoiceNumber}: the Sales series would give number ${next.ok ? next.value.nextValue : '?'}, not ${expected}. Stopping before posting it.`);
    }

    const party = findParty(masters, z);
    if (!party) throw new Error(`${inv.invoiceNumber}: customer "${z.customerName}" is not in the books`);
    const lines = inv.rows.map((l) => {
      const gst = { gstRate: '18', ...(l.hsn ? { hsn: l.hsn } : {}) };
      if (isService(l)) return { description: (l.itemDesc || l.itemName).slice(0, 200), ...(l.usageUnit ? { unit: l.usageUnit } : {}), qty: l.quantity, rate: l.itemPrice, ...gst };
      const it = planned.get(keyOf(l));
      const item = it ? findItem(masters, it.key, it.name, ctx.same) : undefined;
      if (!item) throw new Error(`${inv.invoiceNumber}: item "${l.itemName}" is not in the books`);
      return { itemId: item.id, warehouseId: godown.id, qty: l.quantity, rate: l.itemPrice, ...gst };
    });
    const partyDetails = partyDetailsOf(party, z);
    const header = deriveGstHeader(masters, 'sales', { partyId: party.id, partyDetails, lines });
    const total = grandTotal(lines, header);
    const zohoTotal = parseMoney(z.total);
    if (zohoTotal === undefined || zohoTotal !== total) throw new Error(`${inv.invoiceNumber}: comes to ${formatMoney(total)} here but ${z.total} in Zoho. Stopping.`);

    const r = await gw.post({
      companyId,
      draft: {
        id,
        voucherTypeId: type.id,
        date: z.invoiceDate,
        partyId: party.id,
        ...(z.purchaseOrder ? { reference: z.purchaseOrder } : {}),
        partyDetails,
        lines,
        salesLedgerId: ledger.id,
        dueDate: z.dueDate || z.invoiceDate,
        ...(header ? { gst: header } : {}),
      },
    });
    if (!r.ok) throw failed(`${inv.invoiceNumber} was refused`, r);
    const v: Voucher = r.value.voucher;
    if (seqOf(v.number) !== seqOf(inv.invoiceNumber)) throw new Error(`${inv.invoiceNumber} was posted as ${v.number}: stopping so nothing more goes out of step`);
    out.push({ zoho: inv.invoiceNumber, number: v.number, date: v.date, party: party.name, total: formatMoney(total) });
    ctx.log(`${inv.invoiceNumber}\t${v.date}\t${formatMoney(total)}\t${party.name}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const companyId = args.company as CompanyId;
  const filter = invoiceFilterOf(args.only);
  const all = groupByInvoice(parseZohoCsv(readFileSync(args.csv, 'utf8')));
  const invoices = filter ? all.filter((i) => filter(i.invoiceNumber)) : all;

  const pool = new pg.Pool({ connectionString: args.dbUrl });
  const db = new PostgresBackend(pool, { actorId: args.actor, requestId: `zoho-post-${Date.now()}` });
  const report: Record<string, unknown> = { commit: args.commit };
  try {
    const masters = await db.load(companyId);
    const existing = await db.list(companyId);
    const plan = planOf(invoices, masters, args.same);
    const sales = masters.voucherTypes.find((t) => t.baseKind === 'sales');
    const firstDate = invoices.map((i) => i.rows[0]?.invoiceDate ?? '').sort()[0] ?? '';
    const fy = masters.financialYears.find((y) => firstDate >= y.start && firstDate <= y.end);
    const series = sales && fy ? masters.seriesFor(sales.id, fy.id) : undefined;
    const next = series ? await db.seriesStatus(companyId, series.id) : undefined;
    const known = plan.items.filter((i) => i.existing);

    console.log(`Company: ${masters.company.name} (GST ${masters.company.chargeGst ? 'on' : 'OFF'}, state ${masters.company.stateCode ?? '?'})`);
    console.log(`${invoices.length} invoices (${invoices[0]?.invoiceNumber} … ${invoices.at(-1)?.invoiceNumber}); ${existing.length} vouchers already in the books`);
    console.log(`Sales series: prefix "${series?.prefix ?? '?'}", width ${series?.width ?? '?'}, next number ${next?.ok ? next.value.nextValue : '?'}`);
    console.log(`Units to create: ${plan.units.join(', ') || 'none'}`);
    console.log(`Customers: ${plan.parties.map((p) => `${p.zoho.customerName}${p.existing ? ` = "${p.existing.name}"${(p.existing.roles ?? []).includes('customer') ? '' : ' (+ Customer role)'}` : ' (NEW)'}`).join('; ')}`);
    console.log(`Stock items: ${plan.items.length} parts — ${known.length} already in the books, ${plan.items.length - known.length} new`);
    for (const k of known) console.log(`  existing: ${[...k.zohoNames].join(' | ')}  →  "${k.existing?.name}"  (+${k.qty} in)`);
    for (const p of plan.problems) console.log(`PROBLEM: ${p}`);
    Object.assign(report, {
      units: plan.units,
      parties: plan.parties.map((p) => ({ zoho: p.zoho.customerName, existing: p.existing?.name })),
      items: plan.items.map((i) => ({ name: i.name, code: i.code, qty: i.qty, zohoNames: [...i.zohoNames], existing: i.existing?.name })),
      problems: plan.problems,
    });
    if (plan.problems.length > 0) throw new Error('Fix the problems above first');

    // rehearse on an in-memory copy of the company, its Sales series set to where the real one stands
    let gw: Gateway = db;
    if (!args.commit) {
      const memory = new MemoryBackend(masters);
      if (series && next?.ok) {
        const moved = await memory.execute({ companyId, command: { op: 'advanceSeries', kind: 'numberingSeries', id: series.id, data: { nextValue: next.value.nextValue } } });
        if (!moved.ok) throw failed('Rehearsal series', moved);
      }
      gw = memory;
    }
    const ctx: Context = { companyId, gw, same: args.same, log: args.commit ? (l) => console.log(l) : () => {} };
    const after = await createMasters(ctx, plan);
    await postStock(ctx, plan, after);
    const posted = await postInvoices(ctx, plan, after);
    report['posted'] = posted;
    console.log(`\n${args.commit ? 'POSTED' : 'Dry run OK — would post'} ${posted.filter((p) => !p.skipped).length} invoices (${posted[0]?.number} … ${posted.at(-1)?.number})${args.commit ? '' : '. Nothing was written.'}`);
  } catch (e) {
    report['error'] = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    await pool.end();
  }
}

// run only as the script itself, not when a rehearsal imports the steps
if (process.argv[1]?.replaceAll('\\', '/').endsWith('src/post.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
