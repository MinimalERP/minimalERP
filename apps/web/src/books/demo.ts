import { type MasterKind, type PartyRole, type Result, IssueCode, deterministicUuid, fail, gstinCheckChar, indianFinancialYearOf, issue, localDate, ok, partyLedgerId } from '@minimalerp/domain';
import { addDays, todayText } from '../vouchers/format';
import { dueDateFor, partyDetailsOfParty } from '../vouchers/salesModel';
import type { Books, BooksHost } from './books';

const gstin = (prefix14: string) => prefix14 + gstinCheckChar(prefix14);

interface Step {
  readonly kind: MasterKind;
  readonly name: string;
  readonly data: (id: (kind: MasterKind, name: string) => string, group: (name: string) => string) => Record<string, unknown>;
  /** A ledger's opening balance, posted after it is created. */
  readonly opening?: Opening;
  /** A party's opening balances, one per ledger it made (posted to that ledger). */
  readonly partyOpenings?: readonly (Opening & { readonly role: PartyRole })[];
  /** A stock item's opening stock: how much, at what rate, in which godown (by name). */
  readonly stockOpening?: { readonly warehouse: string; readonly qty: string; readonly rate: string };
}

interface Opening {
  readonly side: 'debit' | 'credit';
  readonly amount: string;
  /** a bill reference: the opening balance of a customer/supplier is one bill */
  readonly bill?: string;
}

const ledger = (name: string, group: string, extra: Record<string, unknown> = {}, opening?: Step['opening']): Step => ({
  kind: 'ledger',
  name,
  data: (_id, g) => ({ name, groupId: g(group), ...extra }),
  ...(opening ? { opening } : {}),
});

/**
 * A realistic small manufacturer, so every part of Go To can be tried straight away: a chart with balances, customers
 * and suppliers with GSTINs, steel and fastener items with HSN codes. Note "ABC" — it exists as a party AND a
 * stock item, which is what "search finds parties to items" looks like. Kumar Engineering Works is both a customer and a vendor.
 */
const STEPS: readonly Step[] = [
  ledger('HDFC Bank Current A/c', 'Bank Accounts', { code: 'BANK01' }, { side: 'debit', amount: '850000' }),
  ledger('Petty Cash Box', 'Cash-in-Hand', {}, { side: 'debit', amount: '25000' }),
  // A party is the one thing created for a customer or supplier: its ledger(s) come with it.
  {
    kind: 'party',
    name: 'ABC Industries',
    data: () => ({
      name: 'ABC Industries', roles: ['customer'], gstin: gstin('27AAPFU0939F1Z'), phone: '9820012345', email: 'accounts@abcindustries.in',
      address: 'Plot 14, MIDC Bhosari, Pune', pincode: '411026', creditDays: 30, creditLimit: '500000',
    }),
    partyOpenings: [{ role: 'customer', side: 'debit', amount: '120000', bill: 'INV-001' }],
  },
  {
    kind: 'party',
    name: 'Sharma Traders',
    data: () => ({ name: 'Sharma Traders', roles: ['customer'], gstin: gstin('07AAACR5055K1Z'), phone: '9811122233', address: 'Karol Bagh, New Delhi', creditDays: 45 }),
    partyOpenings: [{ role: 'customer', side: 'debit', amount: '45000', bill: 'INV-014' }],
  },
  {
    // Both a customer and a vendor: two ledgers under the hood (Sundry Debtors and Sundry Creditors), one party to the user. Ships elsewhere.
    kind: 'party',
    name: 'Kumar Engineering Works',
    data: () => ({
      name: 'Kumar Engineering Works', roles: ['customer', 'vendor'], gstin: gstin('29AABCT1332L1Z'), phone: '9845098450',
      address: 'Peenya Industrial Area, Bengaluru', pincode: '560058', creditDays: 30,
      shipping: { lines: 'SIPCOT Industrial Park, Hosur', stateCode: '33', pincode: '635126' },
    }),
  },
  {
    kind: 'party',
    name: 'Steel Supplies Pvt Ltd',
    data: () => ({ name: 'Steel Supplies Pvt Ltd', roles: ['vendor'], gstin: gstin('24AAACC1206D1Z'), phone: '9898098980', address: 'GIDC Vatva, Ahmedabad', creditDays: 60 }),
    partyOpenings: [{ role: 'vendor', side: 'credit', amount: '210000', bill: 'PO-2210' }],
  },
  { kind: 'party', name: 'Bharat Chemicals', data: () => ({ name: 'Bharat Chemicals', roles: ['vendor'], phone: '9765432109', address: 'Taloja, Navi Mumbai' }) },

  ledger("Owner's Capital", 'Capital Account', {}, { side: 'credit', amount: '830000' }),
  ledger('Sales - Domestic', 'Sales Accounts'),
  ledger('Purchase - Raw Material', 'Purchase Accounts'),
  ledger('Factory Rent', 'Indirect Expenses', { alias: 'Rent' }),
  ledger('Salaries & Wages', 'Indirect Expenses'),
  ledger('Electricity & Power', 'Indirect Expenses'),
  ledger('Freight Outward', 'Indirect Expenses'),
  ledger('CGST Output', 'Duties & Taxes'),
  ledger('SGST Output', 'Duties & Taxes'),
  ledger('IGST Output', 'Duties & Taxes'),
  ledger('CGST Input', 'Duties & Taxes'),
  ledger('SGST Input', 'Duties & Taxes'),

  { kind: 'unit', name: 'Qtl', data: (id) => ({ symbol: 'Qtl', name: 'Quintal', decimals: 2, baseUnitId: id('unit', 'Kg'), factor: '100' }) },
  { kind: 'unit', name: 'Set', data: () => ({ symbol: 'Set', name: 'Sets', decimals: 0 }) },
  { kind: 'stockGroup', name: 'Raw Material', data: () => ({ name: 'Raw Material' }) },
  { kind: 'stockGroup', name: 'Finished Goods', data: () => ({ name: 'Finished Goods' }) },
  { kind: 'stockGroup', name: 'Scrap', data: () => ({ name: 'Scrap' }) },
  { kind: 'warehouse', name: 'Finished Goods Store', data: () => ({ name: 'Finished Goods Store' }) },
  { kind: 'warehouse', name: 'Scrap Yard', data: () => ({ name: 'Scrap Yard' }) },

  { kind: 'stockItem', name: 'MS Sheet 2mm', data: (id) => ({ name: 'MS Sheet 2mm', code: 'RM-SH-2', alias: 'Mild steel sheet', groupId: id('stockGroup', 'Raw Material'), unitId: id('unit', 'Kg'), hsn: '7208', gstRateId: id('gstRate', '18'), itemType: 'raw' }), stockOpening: { warehouse: 'Main Location', qty: '2500', rate: '58' } },
  { kind: 'stockItem', name: 'MS Rod 12mm', data: (id) => ({ name: 'MS Rod 12mm', code: 'RM-RD-12', groupId: id('stockGroup', 'Raw Material'), unitId: id('unit', 'Kg'), hsn: '7214', gstRateId: id('gstRate', '18'), itemType: 'raw' }), stockOpening: { warehouse: 'Main Location', qty: '1800', rate: '62' } },
  { kind: 'stockItem', name: 'ABC Hex Bolt M8', data: (id) => ({ name: 'ABC Hex Bolt M8', code: 'FG-BL-M8', groupId: id('stockGroup', 'Finished Goods'), unitId: id('unit', 'Nos'), hsn: '7318', gstRateId: id('gstRate', '18'), itemType: 'finished' }), stockOpening: { warehouse: 'Finished Goods Store', qty: '5000', rate: '4.5' } },
  { kind: 'stockItem', name: 'Mounting Bracket', data: (id) => ({ name: 'Mounting Bracket', code: 'FG-BR-01', groupId: id('stockGroup', 'Finished Goods'), unitId: id('unit', 'Nos'), hsn: '7326', gstRateId: id('gstRate', '18'), itemType: 'finished' }), stockOpening: { warehouse: 'Finished Goods Store', qty: '800', rate: '38' } },
  { kind: 'stockItem', name: 'Fabricated Frame', data: (id) => ({ name: 'Fabricated Frame', code: 'FG-FR-01', groupId: id('stockGroup', 'Finished Goods'), unitId: id('unit', 'Nos'), hsn: '7308', gstRateId: id('gstRate', '18'), itemType: 'finished' }) },
  { kind: 'stockItem', name: 'MS Scrap', data: (id) => ({ name: 'MS Scrap', code: 'SC-MS', groupId: id('stockGroup', 'Scrap'), unitId: id('unit', 'Kg'), hsn: '7204', gstRateId: id('gstRate', '18'), itemType: 'raw' }) },
  { kind: 'stockItem', name: 'Machine Oil', data: (id) => ({ name: 'Machine Oil', code: 'TR-OIL', unitId: id('unit', 'Ltr'), hsn: '2710', gstRateId: id('gstRate', '18'), itemType: 'trading' }), stockOpening: { warehouse: 'Main Location', qty: '120', rate: '210' } },
];

/**
 * Ids of the things the seed creates come from the company; ids of what the demo creates are derived from their
 * names, so loading the demo twice into two fresh companies gives the same ids and reads the same.
 */
export async function loadDemoCompany(host: BooksHost): Promise<Result<Books>> {
  // The financial year we are in now, so a new voucher's default date (today) is inside it.
  const fyStart = indianFinancialYearOf(localDate(todayText())).start;
  const created = await host.create({
    name: 'Demo Manufacturing Pvt Ltd',
    fyStart,
    gstin: gstin('27AABCD1234E1Z'),
    address: 'Plot 22, MIDC Chakan, Pune, Maharashtra',
  });
  if (!created.ok) return created;
  const books = created.value;

  const m0 = books.masters;
  const seededId = (kind: MasterKind, name: string): string | undefined => {
    if (kind === 'unit') return m0.units.find((u) => u.symbol === name)?.id;
    if (kind === 'gstRate') return m0.gstRates.find((r) => r.ratePercent === name)?.id;
    return undefined;
  };
  const id = (kind: MasterKind, name: string) => seededId(kind, name) ?? deterministicUuid(`demo|${kind}|${name}`);
  const godown = (name: string): string => (name === 'Main Location' ? (m0.warehouses[0]?.id as string) : id('warehouse', name));
  const group = (name: string) => m0.groups.all.find((g) => g.name === name)?.id ?? '';

  // Every change is validated and committed on its own; the screens reload once, at the end.
  const failed = await books.bulk(async (): Promise<Result<never> | undefined> => {
  for (const step of STEPS) {
    const recordId = id(step.kind, step.name);
    const done = await books.execute({ op: 'create', kind: step.kind, id: recordId, data: step.data(id, group) });
    if (!done.ok) return fail(issue(IssueCode.SchemaInvalid, `Demo data: ${step.kind} "${step.name}" was refused — ${done.issues[0]?.message ?? ''}`));
    for (const o of step.partyOpenings ?? []) {
      const bill = o.bill ? [{ kind: 'new', ref: o.bill, dueDate: addDays(fyStart, 30), amount: `${o.amount}.00` }] : undefined;
      const posted = await books.postOpening(partyLedgerId(recordId, o.role), o.side, o.amount, bill);
      if (!posted.ok) return fail(issue(IssueCode.OpeningInvalid, `Demo data: opening balance for "${step.name}" was refused — ${posted.issues[0]?.message ?? ''}`));
    }
    if (step.stockOpening) {
      const warehouse = godown(step.stockOpening.warehouse);
      const posted = await books.postOpeningStock(recordId, warehouse, step.stockOpening.qty, step.stockOpening.rate);
      if (!posted.ok) return fail(issue(IssueCode.OpeningInvalid, `Demo data: opening stock for "${step.name}" was refused — ${posted.issues[0]?.message ?? ''}`));
    }
    if (step.opening) {
      const bill = step.opening.bill
        ? [{ kind: 'new', ref: step.opening.bill, dueDate: addDays(fyStart, 30), amount: `${step.opening.amount}.00` }]
        : undefined;
      const posted = await books.postOpening(recordId, step.opening.side, step.opening.amount, bill);
      if (!posted.ok) return fail(issue(IssueCode.OpeningInvalid, `Demo data: opening balance for "${step.name}" was refused — ${posted.issues[0]?.message ?? ''}`));
    }
  }

  // A few months of entries, so the Day Book and the ledgers have something to show (and bills to settle).
  const day = (n: number) => addDays(fyStart, n);
  const type = (kind: string) => books.masters.voucherTypes.find((t) => t.baseKind === kind)?.id as string;
  const lid = (name: string) => id('ledger', name);
  const plid = (name: string, role: PartyRole) => partyLedgerId(id('party', name), role);
  const cash = books.masters.ledgers.find((l) => l.name === 'Cash')?.id as string;
  const entries: { kind: string; date: string; body: Record<string, unknown> }[] = [
    { kind: 'receipt', date: day(4), body: { narration: 'Part payment against INV-001', accountLedgerId: lid('HDFC Bank Current A/c'), lines: [{ ledgerId: plid('ABC Industries', 'customer'), amount: '60000', allocations: [{ kind: 'against', ref: 'INV-001', amount: '60000' }] }] } },
    { kind: 'payment', date: day(9), body: { narration: 'April rent and power', accountLedgerId: lid('HDFC Bank Current A/c'), lines: [{ ledgerId: lid('Factory Rent'), amount: '25000' }, { ledgerId: lid('Electricity & Power'), amount: '8400' }] } },
    { kind: 'payment', date: day(14), body: { narration: 'On account of PO-2210', accountLedgerId: lid('HDFC Bank Current A/c'), lines: [{ ledgerId: plid('Steel Supplies Pvt Ltd', 'vendor'), amount: '100000', allocations: [{ kind: 'against', ref: 'PO-2210', amount: '100000' }] }] } },
    { kind: 'contra', date: day(20), body: { narration: 'Cash for the month', accountLedgerId: lid('HDFC Bank Current A/c'), lines: [{ ledgerId: cash, amount: '20000' }] } },
    { kind: 'journal', date: day(24), body: { narration: 'Freight bill from Bharat Chemicals', entries: [{ ledgerId: lid('Freight Outward'), side: 'debit', amount: '1500' }, { ledgerId: plid('Bharat Chemicals', 'vendor'), side: 'credit', amount: '1500', allocations: [{ kind: 'new', ref: 'BC-77', dueDate: day(54), amount: '1500' }] }] } },
    { kind: 'payment', date: day(28), body: { narration: 'Wages', accountLedgerId: lid('Petty Cash Box'), lines: [{ ledgerId: lid('Salaries & Wages'), amount: '12000' }] } },
    { kind: 'receipt', date: day(33), body: { narration: 'Cash sale settlement', accountLedgerId: lid('Petty Cash Box'), lines: [{ ledgerId: plid('Sharma Traders', 'customer'), amount: '10000', allocations: [{ kind: 'onAccount', amount: '10000' }] }] } },
  ];
  for (const e of entries) {
    const posted = await books.post({ id: deterministicUuid(`demo|voucher|${e.date}|${e.kind}`), voucherTypeId: type(e.kind), date: e.date, ...e.body });
    if (!posted.ok) return fail(issue(IssueCode.SchemaInvalid, `Demo data: a ${e.kind} voucher was refused — ${posted.issues[0]?.message ?? ''}`));
  }
  // Stock moves with no accounting effect: a transfer between godowns, and raw material turned into finished goods.
  const stockType = books.masters.voucherTypes.find((t) => t.baseKind === 'stockJournal')?.id as string;
  const stockEntries: { date: string; narration: string; entries: Record<string, unknown>[] }[] = [
    {
      date: day(12),
      narration: 'Bolts moved to the main godown for dispatch',
      entries: [
        { itemId: id('stockItem', 'ABC Hex Bolt M8'), warehouseId: godown('Finished Goods Store'), direction: 'out', qty: '500' },
        { itemId: id('stockItem', 'ABC Hex Bolt M8'), warehouseId: godown('Main Location'), direction: 'in', qty: '500', rate: '4.5' },
      ],
    },
    {
      date: day(18),
      narration: 'Frames fabricated from sheet and rod',
      entries: [
        { itemId: id('stockItem', 'MS Sheet 2mm'), warehouseId: godown('Main Location'), direction: 'out', qty: '300' },
        { itemId: id('stockItem', 'MS Rod 12mm'), warehouseId: godown('Main Location'), direction: 'out', qty: '100' },
        { itemId: id('stockItem', 'Fabricated Frame'), warehouseId: godown('Finished Goods Store'), direction: 'in', qty: '60', rate: '950' },
      ],
    },
  ];
  for (const e of stockEntries) {
    const posted = await books.post({ id: deterministicUuid(`demo|stock|${e.date}`), voucherTypeId: stockType, date: e.date, narration: e.narration, entries: e.entries });
    if (!posted.ok) return fail(issue(IssueCode.SchemaInvalid, `Demo data: a stock journal was refused — ${posted.issues[0]?.message ?? ''}`));
  }

  // Sales: three customer orders and two invoices against them, so every state of the Sales Order Register can be seen at once —
  // ABC's PO-4471 is open with one line delivered in full (plain), one partly (bold, 120/300) and one untouched (bold);
  // Sharma's order was delivered in full (closed, muted); Kumar's has not been touched and is past its due date.
  // (the snapshot the screens hold is refreshed once, at the end: read the parties as they are now)
  const now = await books.backend.load(books.companyId);
  const party = (name: string) => now.party(id('party', name) as never);
  const salesOf = (name: string) => {
    const p = party(name);
    return p ? { partyId: p.id, partyDetails: partyDetailsOfParty(p) } : undefined;
  };
  const item = (name: string) => id('stockItem', name);
  const orderType = type('salesOrder');
  const invoiceType = type('sales');
  const salesLedger = lid('Sales - Domestic');
  const orders: { key: string; date: string; party: string; reference: string; lines: { id: string; item: string; qty: string; rate: string; due: string }[] }[] = [
    {
      key: 'PO-4471',
      date: day(30),
      party: 'ABC Industries',
      reference: 'PO-4471',
      lines: [
        { id: 'l1', item: 'ABC Hex Bolt M8', qty: '2000', rate: '6.5', due: day(45) },
        { id: 'l2', item: 'Mounting Bracket', qty: '300', rate: '55', due: day(60) },
        { id: 'l3', item: 'Fabricated Frame', qty: '20', rate: '1400', due: day(75) },
      ],
    },
    { key: 'SH-88', date: day(35), party: 'Sharma Traders', reference: 'SH/PO/88', lines: [{ id: 'l1', item: 'Machine Oil', qty: '40', rate: '260', due: day(50) }] },
    { key: 'KEW-12', date: day(36), party: 'Kumar Engineering Works', reference: 'KEW-12', lines: [{ id: 'l1', item: 'ABC Hex Bolt M8', qty: '800', rate: '6.75', due: day(48) }] },
  ];
  const orderId = (key: string) => deterministicUuid(`demo|order|${key}`);
  for (const o of orders) {
    const who = salesOf(o.party);
    if (!who) return fail(issue(IssueCode.SchemaInvalid, `Demo data: the customer "${o.party}" is missing`));
    const posted = await books.post({
      id: orderId(o.key),
      voucherTypeId: orderType,
      date: o.date,
      ...who,
      reference: o.reference,
      lines: o.lines.map((l) => ({ id: l.id, itemId: item(l.item), qty: l.qty, rate: l.rate, dueDate: l.due })),
    });
    if (!posted.ok) return fail(issue(IssueCode.SchemaInvalid, `Demo data: the sales order ${o.key} was refused — ${posted.issues[0]?.message ?? ''}`));
  }
  const invoices: { key: string; date: string; party: string; lines: { item: string; godown: string; qty: string; rate: string; order: string; line: string }[] }[] = [
    {
      key: 'ABC-1',
      date: day(44),
      party: 'ABC Industries',
      lines: [
        { item: 'ABC Hex Bolt M8', godown: 'Finished Goods Store', qty: '2000', rate: '6.5', order: 'PO-4471', line: 'l1' },
        { item: 'Mounting Bracket', godown: 'Finished Goods Store', qty: '120', rate: '55', order: 'PO-4471', line: 'l2' },
      ],
    },
    { key: 'SH-1', date: day(48), party: 'Sharma Traders', lines: [{ item: 'Machine Oil', godown: 'Main Location', qty: '40', rate: '260', order: 'SH-88', line: 'l1' }] },
  ];
  for (const v of invoices) {
    const who = salesOf(v.party);
    if (!who) return fail(issue(IssueCode.SchemaInvalid, `Demo data: the customer "${v.party}" is missing`));
    const posted = await books.post({
      id: deterministicUuid(`demo|sales|${v.key}`),
      voucherTypeId: invoiceType,
      date: v.date,
      ...who,
      salesLedgerId: salesLedger,
      dueDate: dueDateFor(now, who.partyId, v.date),
      lines: v.lines.map((l) => ({ itemId: item(l.item), warehouseId: godown(l.godown), qty: l.qty, rate: l.rate, orderRef: { orderId: orderId(l.order), lineId: l.line } })),
    });
    if (!posted.ok) return fail(issue(IssueCode.SchemaInvalid, `Demo data: the sales invoice ${v.key} was refused — ${posted.issues[0]?.message ?? ''}`));
  }
  // Purchase: one open order to Steel Supplies for the raw material the factory runs on — a document, so it posts nothing (every money and stock
  // figure above stays as it was). Open it and press Alt+I to make the purchase invoice from what is pending on it.
  const supplier = salesOf('Steel Supplies Pvt Ltd');
  if (!supplier) return fail(issue(IssueCode.SchemaInvalid, 'Demo data: the supplier "Steel Supplies Pvt Ltd" is missing'));
  const purchaseOrder = await books.post({
    id: deterministicUuid('demo|purchaseOrder|SS-Q-31'),
    voucherTypeId: type('purchaseOrder'),
    date: day(38),
    ...supplier,
    reference: 'SS/Q/31',
    lines: [
      { id: 'l1', itemId: item('MS Sheet 2mm'), qty: '1000', rate: '59', dueDate: day(52) },
      { id: 'l2', itemId: item('MS Rod 12mm'), qty: '500', rate: '63.5', dueDate: day(66) },
    ],
  });
  if (!purchaseOrder.ok) return fail(issue(IssueCode.SchemaInvalid, `Demo data: the purchase order was refused — ${purchaseOrder.issues[0]?.message ?? ''}`));
  return undefined;
  });
  if (failed) return failed;
  return ok(books);
}
