import type { BaseKind, Money } from '@minimalerp/domain';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { type Books, type BooksHost, type CompanyChoice } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { useSubscriptions } from '../shell/hooks';
import type { Account, LocalBooks } from '../shell/services';
import { PrintView } from '../ui/PrintView';
import type { PrintCoordinator } from '../ui/printCoordinator';
import { printCompanyOf } from '../ui/printing';
import { formatAmount, formatDate, formatQuantity, todayText } from '../vouchers/format';
import { ANDROID_APK_URL, offerAndroidApp, openInApp } from '../ui/nativeApp';
import { type StockTab, TRANSACTION_GROUPS, type DocRow, inStockTab, docList, docView, goToHits, homeFigures, itemList, itemPage, listTitleOf, partyList, partyPage } from './data';
import { CreateScreen } from './CreateScreen';
import { switchUi } from './device';
import { Entry } from './EntryScreen';
import { ENTRY_KINDS, canAlter, entryTitle, invoiceFrom, isEntryKind, pendingOrderLines } from './entry';
import type { MobileNav, Page } from './nav';
import { PrintSheet } from './PrintSheet';
import { DayBook, OrderRegister, ReportsMenu } from './ReportsScreen';
import { ScanScreen } from './ScanScreen';
import { StockJournalScreen } from './StockJournalScreen';
import { refreshWaiting, scanWaiting } from './scan';
import { Empty, Frame, Group, Row, Search, matches, rupees } from './ui';

/**
 * The mobile interface: the desktop's Gateway → menu → list → record, drawn as plain rows for a thumb. Nothing here decides what a person
 * MAY do or what a figure IS: it reads `Books` through the desktop's own report functions (mobile/data.ts) and asks `Books` to act — the
 * server checks every permission and rule, exactly as it does for the desktop app.
 */

export interface MobileProps {
  readonly host: BooksHost;
  readonly nav: MobileNav;
  readonly print: PrintCoordinator;
  readonly account?: Account | undefined;
  readonly localBooks?: LocalBooks | undefined;
}

export function MobileApp({ host, nav, print, account, localBooks }: MobileProps) {
  useSubscriptions(host, nav, print);
  const books = host.current;
  return (
    <div class="m-app" data-testid="mobile-app">
      {books ? <Pages books={books} host={host} nav={nav} print={print} account={account} localBooks={localBooks} /> : <NoCompany host={host} account={account} localBooks={localBooks} />}
      {books && print.docs.length > 0 && print.copies && <PrintView docs={print.docs} company={printCompanyOf(books.masters)} copies={print.copies} layouts={books.printLayouts} />}
    </div>
  );
}

// ---- the pages ---------------------------------------------------------------------------------------------------------------

type PageProps = Omit<MobileProps, 'host'> & { readonly books: Books; readonly host: BooksHost };

function Pages(props: PageProps) {
  const { books, nav } = props;
  useSubscriptions(books);
  const top = nav.top;
  const today = todayText();
  switch (top.page) {
    case 'gateway':
      return <Gateway {...props} today={today} />;
    case 'transactions':
      return <Transactions nav={nav} />;
    case 'docs':
      return <Documents books={books} nav={nav} kind={top.kind} today={today} />;
    case 'doc':
      return <Document {...props} voucherId={top.voucherId} />;
    case 'parties':
      return <Parties books={books} nav={nav} today={today} />;
    case 'party':
      return <PartyScreen books={books} nav={nav} partyId={top.partyId} today={today} />;
    case 'items':
      return <Items books={books} nav={nav} today={today} />;
    case 'item':
      return <ItemScreen books={books} nav={nav} itemId={top.itemId} today={today} />;
    case 'outstanding':
      return <Outstanding books={books} nav={nav} side={top.side} today={today} />;
    case 'utilities':
      return <Utilities {...props} />;
    case 'scan':
      return <ScanScreen books={books} nav={nav} />;
    case 'stockJournal':
      return <StockJournalScreen books={books} nav={nav} />;
    case 'reports':
      return <ReportsMenu nav={nav} />;
    case 'orderRegister':
      return <OrderRegister books={books} nav={nav} side={top.side} today={today} />;
    case 'dayBook':
      return <DayBook books={books} nav={nav} today={today} />;
    case 'new':
      return <NewMenu nav={nav} />;
    case 'create':
      // saved: the new record's own page takes the form's place
      return <CreateScreen books={books} what={top.what} onClose={() => nav.back()} onSaved={(id) => nav.replace(top.what === 'item' ? { page: 'item', itemId: id } : { page: 'party', partyId: id })} />;
    case 'entry':
      // keyed: a different document is a different form, never the last one's state
      return <Entry key={`${top.kind}|${top.voucherId ?? ''}|${top.partyId ?? ''}|${top.fromOrder ?? ''}|${(top.fromOrderLines ?? []).join(',')}|${top.proposal?.id ?? ''}`} books={books} nav={nav} kind={top.kind} voucherId={top.voucherId} partyId={top.partyId} fromOrder={top.fromOrder} fromOrderLines={top.fromOrderLines} proposal={top.proposal} />;
  }
}

function Gateway({ books, nav, today }: PageProps & { today: string }) {
  const [text, setText] = useState('');
  // The Gateway is drawn at once: its figures are the ones already known for these books, or — the first time, and after something was
  // saved — they are worked out just after the page is on screen, so a tap is never kept waiting behind them.
  const [, drawn] = useState(0);
  const home = homeFigures.peek(books, today);
  useEffect(() => {
    if (homeFigures.peek(books, today) !== undefined) return;
    const t = setTimeout(() => {
      homeFigures(books, today);
      drawn((n) => n + 1);
    }, 30);
    return () => clearTimeout(t);
  }, [books.vouchers, books.lines, books.masters, today]);
  const figure = (m: bigint | undefined): string => (m === undefined ? '…' : rupees(m));
  // how many scanned documents wait: what was last known, asked again in the background (never in the way of drawing the Gateway)
  const waiting = scanWaiting(books);
  useEffect(() => {
    let live = true;
    void refreshWaiting(books).then((n) => live && n !== waiting && drawn((x) => x + 1));
    return () => {
      live = false;
    };
  }, [books]);
  const hits = useMemo(() => goToHits(books, text), [books.vouchers, books.masters, text]);
  const open = (page: Page) => () => nav.open(page);
  return (
    <Frame nav={nav} title={books.masters.company.name}>
      <Search value={text} onInput={setText} label="Go to: party, item or voucher no." />
      {text.trim().length >= 2 ? (
        <Group title="Found">
          {hits.length === 0 ? <Empty>No match.</Empty> : hits.map((h) => <Row key={h.key} title={h.title} sub={h.sub} onOpen={open(h.open)} />)}
        </Group>
      ) : (
        <>
          <Group title="Today">
            <Row title="Sales today" value={figure(home?.salesToday)} sub={home ? `This month ${rupees(home.salesThisMonth)}` : undefined} testId="home-sales" />
            <Row title="Receivable" value={figure(home?.receivable)} note={home && home.receivableOverdue > 0n ? `${rupees(home.receivableOverdue)} overdue` : undefined} tone={home && home.receivableOverdue > 0n ? 'bad' : undefined} onOpen={open({ page: 'outstanding', side: 'receivable' })} testId="home-receivable" />
            <Row title="Payable" value={figure(home?.payable)} onOpen={open({ page: 'outstanding', side: 'payable' })} testId="home-payable" />
          </Group>
          <Group title="Gateway">
            <Row title="Scan" sub="Photo or file of a bill or a PO, to be read" value={waiting ? String(waiting) : undefined} note={waiting ? 'waiting' : undefined} onOpen={open({ page: 'scan' })} testId="gateway-scan" />
            <Row title="New" sub="Invoice, order, quotation, challan, purchase bill" onOpen={open({ page: 'new' })} testId="gateway-new" />
            <Row title="Transactions" sub="Sales, purchases, receipts, payments" onOpen={open({ page: 'transactions' })} />
            <Row title="Parties" sub="Customers and suppliers, their bills" onOpen={open({ page: 'parties' })} />
            <Row title="Stock" sub="What is in the godowns" onOpen={open({ page: 'items' })} />
            <Row title="Reports" sub="Order registers, outstanding, day book" onOpen={open({ page: 'reports' })} testId="gateway-reports" />
            <Row title="Utilities" sub="Company, desktop version, sign out" onOpen={open({ page: 'utilities' })} />
          </Group>
          {home && home.dueLines.length > 0 && (
            <Group title="Orders to deliver">
              {home.dueLines.map((l, i) => (
                <Row key={i} title={l.item} sub={l.party} value={l.pending} note={`${l.overdue ? 'was due' : 'due'} ${formatDate(l.dueDate)}`} tone={l.overdue ? 'bad' : undefined} />
              ))}
            </Group>
          )}
        </>
      )}
    </Frame>
  );
}

/** What can be made on the phone. */
function NewMenu({ nav }: { nav: MobileNav }) {
  return (
    <Frame nav={nav} title="New">
      {ENTRY_KINDS.map((k) => (
        <Row key={k.kind} title={k.title} sub={k.hint} onOpen={() => nav.open({ page: 'entry', kind: k.kind })} testId={`new-${k.kind}`} />
      ))}
      <Row title="Stock Journal" sub="Move stock between godowns, convert or adjust it" onOpen={() => nav.open({ page: 'stockJournal' })} testId="new-stockJournal" />
      <p class="m-note">Receipts, payments and the rest are entered in the desktop version.</p>
    </Frame>
  );
}

function Transactions({ nav }: { nav: MobileNav }) {
  return (
    <Frame nav={nav} title="Transactions">
      {TRANSACTION_GROUPS.map((g) => (
        <Group key={g.group} title={g.group}>
          {g.lists.map((l) => (
            <Row key={l.kind} title={l.title} onOpen={() => nav.open({ page: 'docs', kind: l.kind })} />
          ))}
        </Group>
      ))}
    </Frame>
  );
}

const DocRows = ({ rows, nav, showType }: { rows: readonly DocRow[]; nav: MobileNav; showType?: boolean }) => (
  <>
    {rows.map((r) => (
      <Row
        key={r.voucherId}
        title={[r.number, r.reference || r.billNo || undefined, r.cancelled ? 'cancelled' : undefined].filter(Boolean).join(' · ')}
        sub={[formatDate(r.date), showType ? r.typeName : undefined, r.particulars].filter(Boolean).join(' · ')}
        value={r.amount === 0n ? undefined : rupees(r.amount)}
        note={r.status || undefined}
        tone={r.cancelled ? 'muted' : r.status === 'Overdue' ? 'bad' : undefined}
        onOpen={() => nav.open({ page: 'doc', voucherId: r.voucherId })}
        testId="doc-row"
      />
    ))}
  </>
);

/** How many rows a long list draws before "Show more": a phone does not need two thousand rows at once. */
const PAGE = 60;

function Documents({ books, nav, kind, today }: { books: Books; nav: MobileNav; kind: BaseKind; today: string }) {
  const [text, setText] = useState('');
  const [shown, setShown] = useState(PAGE);
  const all = useMemo(() => docList(books, kind, today), [books.vouchers, books.lines, books.masters, kind, today]);
  const rows = all.filter((r) => matches(text, r.number, r.particulars, r.reference, r.billNo, r.status));
  return (
    <Frame
      nav={nav}
      title={listTitleOf(kind)}
      foot={
        isEntryKind(kind) ? (
          <button type="button" class="m-button m-primary" data-testid="list-new" onClick={() => nav.open({ page: 'entry', kind })}>
            + New {entryTitle(kind)}
          </button>
        ) : kind === 'stockJournal' ? (
          <button type="button" class="m-button m-primary" data-testid="list-new" onClick={() => nav.open({ page: 'stockJournal' })}>
            + New Stock Journal
          </button>
        ) : undefined
      }
    >
      <Search value={text} onInput={setText} label="Filter: number, party, status" />
      {rows.length === 0 ? <Empty>{all.length === 0 ? 'None yet.' : 'No match.'}</Empty> : <DocRows rows={rows.slice(0, shown)} nav={nav} />}
      {rows.length > shown && (
        <button type="button" class="m-more" onClick={() => setShown(shown + PAGE)}>
          Show more ({rows.length - shown} more)
        </button>
      )}
    </Frame>
  );
}

function Document({ books, nav, print, voucherId }: PageProps & { voucherId: string }) {
  const view = useMemo(() => docView(books, voucherId), [books.vouchers, books.lines, books.masters, voucherId]);
  const [picked, setPicked] = useState<readonly string[]>([]);
  /** The sheet that asks which copies, and whether to print, share or save them. */
  const [printing, setPrinting] = useState(false);
  if (!view) {
    return (
      <Frame nav={nav} title="Voucher">
        <Empty>That voucher does not exist.</Empty>
      </Frame>
    );
  }
  const { voucher, item, bill } = view;
  const cancelled = voucher.status === 'cancelled';
  // An open Sales Order: a long press on a line that still has something to invoice chooses it (then a tap adds or drops another), and
  // "Invoice pending" becomes "Invoice selected" — an invoice for those lines only.
  const pending = pendingOrderLines(books, voucher);
  const chosen = picked.filter((id) => pending.has(id));
  const toggle = (id: string) => setPicked(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const openPrinting = () => {
    setPrinting(true);
    nav.openLayer(() => setPrinting(false));
  };
  return (
    <Frame nav={nav} title={`${view.typeName} ${voucher.number}`}>
      <Group title={formatDate(voucher.date)}>
        {cancelled && <Row title="Cancelled" sub="It keeps its number but is out of the books" tone="muted" />}
        {item ? (
          <>
            <Row title={item.form.partyLabel || 'No party'} sub={[item.form.partyDetails?.gstin, item.form.reference ? `Ref ${item.form.reference}` : undefined, item.form.billNo ? `Inv ${item.form.billNo}` : undefined].filter(Boolean).join(' · ')} onOpen={item.form.partyId ? () => nav.open({ page: 'party', partyId: item.form.partyId }) : undefined} testId="doc-party" />
          </>
        ) : null}
      </Group>
      {item ? (
        <>
          <Group title="Items">
            {item.form.lines.map((l, i) => {
              const amount = item.preview.amounts.get(i);
              if (amount === undefined) return null;
              const open = pending.get(l.key);
              const unit = books.masters.stockItem(l.itemId as never);
              const decimals = (unit ? books.masters.unit(unit.unitId)?.decimals : 0) ?? 0;
              const sub = `${l.qty} × ${l.rate}${l.gstRate ? ` · GST ${l.gstRate}%` : ''}${open ? ` · ${formatQuantity(open.pending as never, decimals)} of ${formatQuantity(open.ordered as never, decimals)} pending` : ''}`;
              return open ? (
                <Row key={l.key} title={l.itemLabel} sub={sub} value={formatAmount(amount)} selected={chosen.includes(l.key)} onHold={() => toggle(l.key)} onOpen={chosen.length > 0 ? () => toggle(l.key) : undefined} testId="doc-line" />
              ) : (
                <Row key={l.key} title={l.itemLabel} sub={sub} value={formatAmount(amount)} testId="doc-line" />
              );
            })}
            {pending.size > 1 ? (
              <p class="m-note" data-testid="doc-hold-hint">
                {chosen.length > 0 ? `${chosen.length} of ${pending.size} pending lines chosen. Tap a line to add or drop it.` : 'Hold a line to invoice only some of them.'}{' '}
                {chosen.length > 0 ? (
                  <button type="button" class="m-link" onClick={() => setPicked([])}>
                    Clear
                  </button>
                ) : null}
              </p>
            ) : null}
          </Group>
          <Group title="Total">
            {item.preview.gst ? (
              <>
                <Row title="Taxable value" value={formatAmount(item.preview.total)} />
                {item.preview.gst.igst > 0n ? <Row title="IGST" value={formatAmount(item.preview.gst.igst)} /> : null}
                {item.preview.gst.cgst > 0n ? <Row title="CGST" value={formatAmount(item.preview.gst.cgst)} /> : null}
                {item.preview.gst.sgst > 0n ? <Row title="SGST" value={formatAmount(item.preview.gst.sgst)} /> : null}
              </>
            ) : null}
            {item.preview.roundOff !== 0n ? <Row title="Round off" value={`${item.preview.roundOff < 0n ? '−' : ''}${formatAmount(item.preview.roundOff < 0n ? -item.preview.roundOff : item.preview.roundOff)}`} /> : null}
            <Row title="Total" value={rupees(item.preview.grand)} testId="doc-total" />
            {bill && !cancelled ? <Row title={bill.pending > 0n ? 'Pending' : 'Settled'} value={rupees(bill.pending)} sub={bill.settled > 0n ? `${rupees(bill.settled)} settled` : undefined} tone={bill.pending > 0n ? undefined : 'muted'} testId="doc-pending" /> : null}
          </Group>
        </>
      ) : view.stock ? (
        <Group title="Stock moved">
          {view.stock.map((l, i) => (
            <Row key={i} title={`${l.direction === 'in' ? 'In' : 'Out'} · ${l.itemLabel}`} sub={`${l.direction === 'in' ? 'into' : 'from'} ${l.warehouseLabel}${l.direction === 'in' && l.rate ? ` · at ${l.rate}` : ''}`} value={l.qty} onOpen={() => nav.open({ page: 'item', itemId: l.itemId })} testId="doc-stock-line" />
          ))}
        </Group>
      ) : (
        <Group title="Entries">
          {view.journal.length === 0 ? <Empty>Nothing posted.</Empty> : view.journal.map((l, i) => <Row key={i} title={l.ledger} value={`${formatAmount(l.amount)} ${l.side === 'debit' ? 'Dr' : 'Cr'}`} />)}
        </Group>
      )}
      {(voucher.content as { narration?: string }).narration ? <p class="m-note">{(voucher.content as { narration?: string }).narration}</p> : null}
      {item && !cancelled ? (
        <div class="m-actions m-wrap">
          <button type="button" class="m-button" data-testid="doc-print" onClick={openPrinting}>
            Print / PDF
          </button>
          {isEntryKind(view.baseKind) && canAlter(books, voucher) ? (
            <button type="button" class="m-button" data-testid="doc-edit" onClick={() => nav.open({ page: 'entry', kind: view.baseKind as never, voucherId: voucher.id })}>
              Edit
            </button>
          ) : null}
          {invoiceFrom(books, voucher) ? (
            <button type="button" class="m-button m-primary" data-testid="doc-invoice" onClick={() => nav.open({ page: 'entry', kind: view.baseKind === 'purchaseOrder' ? 'purchase' : 'sales', fromOrder: voucher.id, ...(chosen.length > 0 ? { fromOrderLines: chosen } : {}) })}>
              {chosen.length > 0 ? `${view.baseKind === 'purchaseOrder' ? 'Bill' : 'Invoice'} selected (${chosen.length})` : invoiceFrom(books, voucher)}
            </button>
          ) : null}
        </div>
      ) : null}
      {printing ? <PrintSheet books={books} nav={nav} print={print} voucher={voucher} /> : null}
    </Frame>
  );
}

function Parties({ books, nav, today }: { books: Books; nav: MobileNav; today: string }) {
  const [text, setText] = useState('');
  const all = useMemo(() => partyList(books, today), [books.vouchers, books.lines, books.masters, today]);
  const rows = all.filter((r) => matches(text, r.name));
  return (
    <Frame
      nav={nav}
      title="Parties"
      foot={
        <button type="button" class="m-button m-primary" data-testid="list-new-customer" onClick={() => nav.open({ page: 'create', what: 'customer' })}>
          + New customer
        </button>
      }
    >
      <Search value={text} onInput={setText} label="Filter by name" />
      {rows.length === 0 ? (
        <Empty>{all.length === 0 ? 'No parties yet.' : 'No match.'}</Empty>
      ) : (
        rows.map((r) => {
          const net = r.receivable - r.payable;
          return <Row key={r.partyId} title={r.name} sub={r.roles} value={net === 0n ? undefined : `${rupees(net < 0n ? -net : net)}`} note={net === 0n ? undefined : net > 0n ? 'owes us' : 'we owe'} tone={r.overdueDays > 0 ? 'bad' : undefined} onOpen={() => nav.open({ page: 'party', partyId: r.partyId })} testId="party-row" />;
        })
      )}
    </Frame>
  );
}

function BillRows({ bills, nav }: { bills: readonly { voucherId: string; ref: string; dueDate: string; pending: Money; daysOverdue: number; key: string }[]; nav: MobileNav }) {
  if (bills.length === 0) return <Empty>No open bills.</Empty>;
  return (
    <>
      {bills.map((b) => (
        <Row key={b.key} title={b.ref} sub={`due ${formatDate(b.dueDate)}`} value={rupees(b.pending)} note={b.daysOverdue > 0 ? `${b.daysOverdue} days overdue` : undefined} tone={b.daysOverdue > 0 ? 'bad' : undefined} onOpen={() => nav.open({ page: 'doc', voucherId: b.voucherId })} testId="bill-row" />
      ))}
    </>
  );
}

function PartyScreen({ books, nav, partyId, today }: { books: Books; nav: MobileNav; partyId: string; today: string }) {
  const p = useMemo(() => partyPage(books, partyId, today), [books.vouchers, books.lines, books.masters, partyId, today]);
  if (!p) {
    return (
      <Frame nav={nav} title="Party">
        <Empty>That party does not exist.</Empty>
      </Frame>
    );
  }
  const { party } = p;
  const digits = (party.phone ?? '').replace(/\D/g, '');
  return (
    <Frame nav={nav} title={party.name}>
      <div class="m-actions">
        <>
          {digits ? (
            <a class="m-button" href={`tel:${digits}`}>
              Call
            </a>
          ) : null}
          {/* WhatsApp itself, not a chat on the party's number: the person picks the contact there (a master's number is often a landline) */}
          <a class="m-button" href="https://wa.me/" target="_blank" rel="noreferrer" data-testid="party-whatsapp">
            WhatsApp
          </a>
          {party.email ? (
            <a class="m-button" href={`mailto:${party.email}`}>
              Email
            </a>
          ) : null}
        </>
      </div>
      {p.receivable ? (
        <div class="m-actions">
          <button type="button" class="m-button m-primary" data-testid="party-invoice" onClick={() => nav.open({ page: 'entry', kind: 'sales', partyId: party.id })}>
            + New invoice
          </button>
          <button type="button" class="m-button" data-testid="party-order" onClick={() => nav.open({ page: 'entry', kind: 'salesOrder', partyId: party.id })}>
            + New order
          </button>
        </div>
      ) : null}
      {p.receivable ? (
        <Group title="Owes us">
          <Row title="Balance" value={rupees(p.receivable.balance)} testId="party-receivable" />
          <BillRows bills={p.receivable.bills} nav={nav} />
        </Group>
      ) : null}
      {p.payable ? (
        <div class="m-actions">
          <button type="button" class="m-button m-primary" data-testid="party-bill" onClick={() => nav.open({ page: 'entry', kind: 'purchase', partyId: party.id })}>
            + New purchase bill
          </button>
        </div>
      ) : null}
      {p.payable ? (
        <Group title="We owe">
          <Row title="Balance" value={rupees(p.payable.balance)} testId="party-payable" />
          <BillRows bills={p.payable.bills} nav={nav} />
        </Group>
      ) : null}
      <Group title="Documents">{p.documents.length === 0 ? <Empty>None yet.</Empty> : <DocRows rows={p.documents} nav={nav} showType />}</Group>
      {[party.gstin ? `GSTIN ${party.gstin}` : '', party.address ?? ''].filter(Boolean).length > 0 ? <p class="m-note">{[party.gstin ? `GSTIN ${party.gstin}` : '', party.address ?? ''].filter(Boolean).join(' · ')}</p> : null}
    </Frame>
  );
}

function Outstanding({ books, nav, side, today }: { books: Books; nav: MobileNav; side: 'receivable' | 'payable'; today: string }) {
  const rows = useMemo(() => partyList(books, today), [books.vouchers, books.lines, books.masters, today]);
  const owing = rows.map((r) => ({ r, amount: side === 'receivable' ? r.receivable : r.payable })).filter((x) => x.amount !== 0n).sort((a, b) => (a.amount < b.amount ? 1 : -1));
  return (
    <Frame nav={nav} title={side === 'receivable' ? 'Receivable' : 'Payable'}>
      {owing.length === 0 ? (
        <Empty>Nothing outstanding.</Empty>
      ) : (
        owing.map(({ r, amount }) => <Row key={r.partyId} title={r.name} value={rupees(amount)} note={side === 'receivable' && r.overdueDays > 0 ? `${r.overdueDays} days overdue` : undefined} tone={side === 'receivable' && r.overdueDays > 0 ? 'bad' : undefined} onOpen={() => nav.open({ page: 'party', partyId: r.partyId })} testId="outstanding-row" />)
      )}
    </Frame>
  );
}

function Items({ books, nav, today }: { books: Books; nav: MobileNav; today: string }) {
  const [text, setText] = useState('');
  const [tab, setTab] = useState<StockTab>('all');
  const all = useMemo(() => itemList(books, today), [books.stock, books.orders, books.masters, today]);
  const rows = all.filter((r) => inStockTab(r, tab) && matches(text, r.name, r.group));
  const count = (t: StockTab) => all.filter((r) => inStockTab(r, t)).length;
  const q = (r: (typeof all)[number], n: bigint) => `${formatQuantity(n as never, r.decimals)} ${r.unit}`.trim();
  return (
    <Frame
      nav={nav}
      title="Stock"
      foot={
        <button type="button" class="m-button m-primary" data-testid="list-new-item" onClick={() => nav.open({ page: 'create', what: 'item' })}>
          + New item
        </button>
      }
    >
      <Search value={text} onInput={setText} label="Filter by item" />
      <div class="m-field m-field-bare">
        <span class="m-seg" role="group" aria-label="Which items">
          {(
            [
              ['all', 'All'],
              ['committed', 'Committed'],
              ['onOrder', 'On order'],
            ] as const
          ).map(([t, label]) => (
            <button key={t} type="button" class={tab === t ? 'm-seg-on' : ''} aria-pressed={tab === t} data-testid={`stock-tab-${t}`} onClick={() => setTab(t)}>
              {label} ({count(t)})
            </button>
          ))}
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty>{all.length === 0 ? 'No stock items yet.' : text.trim() !== '' ? 'No match.' : tab === 'committed' ? 'Nothing is waiting on a sales order.' : tab === 'onOrder' ? 'Nothing is on order from suppliers.' : 'No match.'}</Empty>
      ) : tab !== 'all' ? (
        // what the tab is about is the figure: how much is spoken for (and what that leaves free), or how much is still to come
        rows.map((r) => (
          <Row
            key={r.itemId}
            title={r.name}
            sub={`${q(r, r.closing.qty)} in stock${tab === 'committed' ? ` · ${q(r, r.available)} free` : ''}`}
            value={q(r, tab === 'committed' ? r.committed : r.onOrder)}
            note={tab === 'committed' ? 'on sales orders' : 'to come'}
            tone={tab === 'committed' && r.available < 0n ? 'bad' : undefined}
            onOpen={() => nav.open({ page: 'item', itemId: r.itemId })}
            testId="item-row"
          />
        ))
      ) : (
        rows.map((r) => <Row key={r.itemId} title={r.name} sub={r.group || undefined} value={`${formatQuantity(r.closing.qty, r.decimals)} ${r.unit}`.trim()} note={r.committed > 0n ? `${formatQuantity(r.available as never, r.decimals)} free` : undefined} tone={r.available < 0n ? 'bad' : undefined} onOpen={() => nav.open({ page: 'item', itemId: r.itemId })} testId="item-row" />)
      )}
    </Frame>
  );
}

function ItemScreen({ books, nav, itemId, today }: { books: Books; nav: MobileNav; itemId: string; today: string }) {
  const p = useMemo(() => itemPage(books, itemId, today), [books.stock, books.orders, books.masters, books.vouchers, itemId, today]);
  if (!p) {
    return (
      <Frame nav={nav} title="Stock item">
        <Empty>That item does not exist.</Empty>
      </Frame>
    );
  }
  const q = (n: bigint) => `${formatQuantity(n as never, p.row.decimals)} ${p.row.unit}`.trim();
  return (
    <Frame nav={nav} title={p.row.name}>
      {p.service ? <p class="m-note">A service: it is billed on an invoice and holds no stock.</p> : null}
      <Group title="Stock">
        <Row title="In stock" value={q(p.row.closing.qty)} sub={p.row.closing.value > 0n ? `worth ${rupees(p.row.closing.value)}` : undefined} testId="item-stock" />
        {p.row.committed > 0n ? <Row title="On sales orders" value={q(p.row.committed)} note={`${q(p.row.available)} free`} tone={p.row.available < 0n ? 'bad' : undefined} /> : null}
        {p.row.onOrder > 0n ? <Row title="On purchase orders" value={q(p.row.onOrder)} /> : null}
        {p.godowns.length > 1 || (p.godowns.length === 1 && books.masters.warehouses.length > 1) ? p.godowns.map((g) => <Row key={g.name} title={g.name} value={q(g.qty)} tone="muted" />) : null}
      </Group>
      <Group title="Latest movements">
        {p.movements.length === 0 ? <Empty>None this year.</Empty> : p.movements.map((m, i) => <Row key={i} title={m.number} sub={formatDate(m.date)} value={`${m.direction === 'in' ? '+' : '−'}${q(m.qty)}`} note={`${q(m.balance)} after`} onOpen={() => nav.open({ page: 'doc', voucherId: m.voucherId })} />)}
      </Group>
      {p.hsn ? <p class="m-note">HSN {p.hsn}</p> : null}
    </Frame>
  );
}

function Utilities({ books, host, nav, account, localBooks }: PageProps) {
  const [companies, setCompanies] = useState<readonly CompanyChoice[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (host.canSwitch) void host.companies().then(setCompanies, () => setCompanies([]));
  }, [host, books]);
  const others = companies.filter((c) => c.id !== books.masters.company.id);
  const switchTo = (id: CompanyChoice['id']) => {
    setBusy(true);
    void host.switchTo(id).then(
      () => nav.reset(),
      () => setBusy(false),
    );
  };
  return (
    <Frame nav={nav} title="Utilities">
      <Group title="Company">
        <Row title={books.masters.company.name} sub="Open now" />
        {others.map((c) => (
          <Row key={c.id} title={c.name} sub={busy ? 'Opening…' : 'Switch to this company'} onOpen={busy ? undefined : () => switchTo(c.id)} testId="company-row" />
        ))}
      </Group>
      <Group title="This device">
        <Row title="Desktop version" sub="The full keyboard app, with every voucher and report" onOpen={() => switchUi('desktop')} testId="to-desktop" />
        {account ? <Row title="Sign out" sub={account.email} onOpen={() => void account.signOut()} /> : null}
        {localBooks ? <Row title="Sign in" sub="These books are kept in this browser" onOpen={() => localBooks.signIn()} /> : null}
        {offerAndroidApp() ? <Row title="Get the Android app" sub="Share bills into Scan, send PDFs, print" onOpen={() => void (openInApp(ANDROID_APK_URL) || window.open(ANDROID_APK_URL, '_blank', 'noopener'))} testId="get-app" /> : null}
      </Group>
    </Frame>
  );
}

/** No company is open: the mobile interface looks things up, it does not set a business up. */
function NoCompany({ host, account, localBooks }: { host: BooksHost; account?: Account | undefined; localBooks?: LocalBooks | undefined }) {
  const [message, setMessage] = useState('');
  const demo = () => void loadDemoCompany(host).then((r) => (r.ok ? undefined : setMessage(r.issues[0]?.message ?? 'The demo company could not be loaded')));
  return (
    <>
      <header class="m-bar">
        <span class="m-back m-back-none" />
        <h1 class="m-title">MinimalERP</h1>
      </header>
      <main class="m-main">
        <Empty>No company is open yet. A company is created in the desktop version.</Empty>
        {message ? <p class="m-note bad">{message}</p> : null}
        <Group title="Start">
          <Row title="Desktop version" sub="Create your company there" onOpen={() => switchUi('desktop')} testId="to-desktop" />
          {host.canCreate && host.canLoadDemo ? <Row title="Load Demo Company" sub="A sample business to look around" onOpen={demo} testId="load-demo" /> : null}
          {account ? <Row title="Sign out" sub={account.email} onOpen={() => void account.signOut()} /> : null}
          {localBooks ? <Row title="Sign in" sub="Open your online books" onOpen={() => localBooks.signIn()} /> : null}
        </Group>
      </main>
    </>
  );
}
