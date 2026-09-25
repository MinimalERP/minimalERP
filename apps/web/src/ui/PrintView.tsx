import { formatAmount, formatDate } from '../vouchers/format';

/**
 * What a printed page shows, hidden on screen and revealed only by `@media print` (see `print.css`), one `.print-copy`
 * per label — Original / Duplicate / Triplicate / Extra Copy for a voucher, a single unlabelled page for a report.
 * Every figure here is one already computed on screen (the preview the voucher/report already shows): this never
 * recomputes GST, a total or a balance — it only lays out numbers the screen has already checked.
 */

export interface PrintAddress {
  readonly name?: string | undefined;
  readonly lines?: string | undefined;
  readonly stateCode?: string | undefined;
  readonly country?: string | undefined;
  readonly pincode?: string | undefined;
}

export interface PrintParty {
  readonly name: string;
  readonly gstin?: string | undefined;
  readonly billTo?: PrintAddress | undefined;
  /** Absent: same as billing. */
  readonly shipTo?: PrintAddress | undefined;
}

export interface PrintCompany {
  readonly name: string;
  readonly address?: string | undefined;
  readonly gstin?: string | undefined;
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
  readonly bankName?: string | undefined;
  readonly bankAccountNo?: string | undefined;
  readonly bankIfsc?: string | undefined;
  readonly bankBranch?: string | undefined;
  readonly invoiceNote?: string | undefined;
  readonly invoiceTerms?: string | undefined;
}

/** A simple double- or single-entry voucher: Payment, Receipt, Contra, Journal, Opening. */
export interface LedgerDoc {
  readonly kind: 'ledger';
  readonly docTitle: string;
  readonly number: string;
  readonly date: string;
  readonly lines: readonly { readonly ledger: string; readonly side: 'debit' | 'credit'; readonly amount: bigint }[];
  readonly narration?: string | undefined;
}

/** A Sales/Purchase Order or Invoice: bill-to/ship-to, an item table, GST, totals, bank details and a signature. */
export interface InvoiceDoc {
  readonly kind: 'invoice';
  readonly docTitle: string;
  readonly number: string;
  readonly date: string;
  /** What the number row is labelled — "No." unless the screen names something more specific ("Invoice No." for a Sales Invoice). */
  readonly numberLabel?: string | undefined;
  /** The customer's own reference (Sales) — shown as "PO No." only when present. */
  readonly poNo?: string | undefined;
  /** The E-way Bill number for this invoice's movement of goods (Sales) — shown only when present. */
  readonly ewayBillNo?: string | undefined;
  /** The state of the delivery address, as it prints ("Maharashtra (27)") — shown only when known. */
  readonly placeOfSupply?: string | undefined;
  readonly party: PrintParty;
  readonly lines: readonly {
    readonly desc: string;
    readonly hsn?: string | undefined;
    readonly qty: string;
    readonly rate: string;
    readonly amount: bigint;
    readonly gstRate?: string | undefined;
  }[];
  readonly subtotal: bigint;
  readonly gst?: { readonly cgst: bigint; readonly sgst: bigint; readonly igst: bigint } | undefined;
  /** The Round Off adjustment (signed: positive when rounded up) — shown only when nonzero. */
  readonly roundOff?: bigint | undefined;
  readonly grandTotal: bigint;
  readonly narration?: string | undefined;
}

/** A Stock Journal or opening stock: an internal movement, not a customer document — no GST, bank details or signature. */
export interface StockDoc {
  readonly kind: 'stock';
  readonly docTitle: string;
  readonly number: string;
  readonly date: string;
  readonly lines: readonly { readonly direction: 'in' | 'out'; readonly item: string; readonly warehouse: string; readonly qty: string; readonly value: bigint }[];
  readonly narration?: string | undefined;
}

/** A report: the same rows and columns the screen shows, in full — never only the on-screen grid's windowed slice. */
export interface ReportDoc {
  readonly kind: 'report';
  readonly title: string;
  readonly period: string;
  readonly filters: readonly string[];
  readonly columns: readonly { readonly label: string; readonly align?: 'left' | 'right' | undefined }[];
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: string;
}

/**
 * A dispatch docket, two pages: the consignment (the customer, the invoices it carries, packages, transporter, LR) and every item on those
 * invoices, like items added together. Built from invoices already posted — nothing of it is stored.
 */
export interface DocketDoc {
  readonly kind: 'docket';
  readonly number: string;
  readonly date: string;
  readonly party: PrintParty;
  readonly invoices: readonly { readonly number: string; readonly date: string; readonly poNo?: string | undefined; readonly amount: bigint }[];
  readonly packages: string;
  readonly transporter: string;
  readonly lrNo: string;
  readonly items: readonly { readonly desc: string; readonly hsn?: string | undefined; readonly qty: string }[];
  /** All the items' quantity, per unit ("120 Nos + 5 Kg"). */
  readonly totalQty: string;
}

export type PrintDoc = LedgerDoc | InvoiceDoc | StockDoc | ReportDoc | DocketDoc;

const words = (s: string | undefined): string[] | undefined => (s && s.trim() !== '' ? s.split('\n') : undefined);

function AddressBlock({ label, address, gstin }: { label: string; address: PrintAddress | undefined; gstin?: string | undefined }) {
  if (!address) return null;
  const bits = [address.lines, [address.stateCode, address.pincode].filter(Boolean).join(' – '), address.country].filter((s) => s && s.trim() !== '');
  return (
    <div>
      <div class="label">{label}</div>
      {address.name && <div class="pname">{address.name}</div>}
      {bits.map((b, i) => (
        <div key={i}>{b}</div>
      ))}
      {gstin && <div>GSTIN: {gstin}</div>}
    </div>
  );
}

function Narration({ text }: { text: string }) {
  return (
    <p class="inv-narration">
      <span class="label">Narration:</span> {text}
    </p>
  );
}

function CompanyHead({
  company,
  docTitle,
  copyLabel,
  numberLabel = 'No.',
  number,
  date,
  poNo,
  ewayBillNo,
}: {
  company: PrintCompany;
  docTitle: string;
  copyLabel: string | undefined;
  numberLabel?: string | undefined;
  number: string;
  date: string;
  poNo?: string | undefined;
  ewayBillNo?: string | undefined;
}) {
  return (
    <div class="inv-head">
      <div class="inv-company">
        <div class="name">{company.name}</div>
        {company.address && <div>{company.address}</div>}
        {company.gstin && <div>GSTIN: {company.gstin}</div>}
        {(company.phone || company.email) && (
          <div>
            {company.phone}
            {company.phone && company.email && ' · '}
            {company.email}
          </div>
        )}
      </div>
      <div class="inv-doc">
        <div class="title">{docTitle}</div>
        {copyLabel && <div class="copy-label">{copyLabel}</div>}
        <table>
          <tbody>
            <tr>
              <td>{numberLabel}</td>
              <td>{number}</td>
            </tr>
            <tr>
              <td>Date</td>
              <td>{formatDate(date)}</td>
            </tr>
            {poNo && (
              <tr>
                <td>PO No.</td>
                <td>{poNo}</td>
              </tr>
            )}
            {ewayBillNo && (
              <tr>
                <td>E-way Bill No.</td>
                <td>{ewayBillNo}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BankAndSign({ company }: { company: PrintCompany }) {
  const hasBank = company.bankName || company.bankAccountNo || company.bankIfsc || company.bankBranch;
  const terms = words(company.invoiceTerms);
  return (
    <>
      {(hasBank || company.invoiceNote || terms) && (
        <div class="inv-foot">
          <div class="bank">
            {hasBank && (
              <>
                <div class="label">Bank details</div>
                {company.bankName && <div>{company.bankName}</div>}
                {company.bankAccountNo && <div>A/c No. {company.bankAccountNo}</div>}
                {company.bankIfsc && <div>IFSC {company.bankIfsc}</div>}
                {company.bankBranch && <div>{company.bankBranch}</div>}
              </>
            )}
            {company.invoiceNote && <div class="thanks">{company.invoiceNote}</div>}
          </div>
          {terms && (
            <div class="terms">
              <div class="label">Terms</div>
              <ol>
                {terms.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
      <div class="inv-sign">
        <div>
          <div class="for-company">For {company.name}</div>
          <div class="sign-line">Authorised Signatory</div>
        </div>
      </div>
    </>
  );
}

function LedgerBody({ doc, company, copyLabel }: { doc: LedgerDoc; company: PrintCompany; copyLabel: string | undefined }) {
  return (
    <>
      <CompanyHead company={company} docTitle={doc.docTitle} copyLabel={copyLabel} number={doc.number} date={doc.date} />
      <table class="items">
        <thead>
          <tr>
            <th class="center sno">S.No.</th>
            <th>Particulars</th>
            <th class="center">Dr / Cr</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l, i) => (
            <tr key={i}>
              <td class="center sno">{i + 1}</td>
              <td>{l.ledger}</td>
              <td class="center">{l.side === 'debit' ? 'Dr' : 'Cr'}</td>
              <td class="num">{formatAmount(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {doc.narration && <Narration text={doc.narration} />}
      <BankAndSign company={company} />
    </>
  );
}

function InvoiceBody({ doc, company, copyLabel }: { doc: InvoiceDoc; company: PrintCompany; copyLabel: string | undefined }) {
  const sameAsBilling = !doc.party.shipTo;
  return (
    <>
      <CompanyHead company={company} docTitle={doc.docTitle} copyLabel={copyLabel} numberLabel={doc.numberLabel} number={doc.number} date={doc.date} poNo={doc.poNo} ewayBillNo={doc.ewayBillNo} />
      <div class="inv-parties">
        <AddressBlock label="Bill To" address={{ name: doc.party.name, ...doc.party.billTo }} gstin={doc.party.gstin} />
        <AddressBlock label="Ship To" address={sameAsBilling ? { name: doc.party.name, ...doc.party.billTo } : { name: doc.party.name, ...doc.party.shipTo }} />
      </div>
      {doc.placeOfSupply && (
        <div class="inv-pos">
          <span class="label">Place of Supply:</span> {doc.placeOfSupply}
        </div>
      )}
      <table class="items">
        <thead>
          <tr>
            <th class="center sno">S.No.</th>
            <th>Description</th>
            <th class="center">HSN</th>
            <th class="num">Qty</th>
            <th class="num">Rate</th>
            {doc.gst && <th class="num">GST%</th>}
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l, i) => (
            <tr key={i}>
              <td class="center sno">{i + 1}</td>
              <td>{l.desc}</td>
              <td class="center">{l.hsn}</td>
              <td class="num">{l.qty}</td>
              <td class="num">{l.rate}</td>
              {doc.gst && <td class="num">{l.gstRate ? `${l.gstRate}%` : ''}</td>}
              <td class="num">{formatAmount(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="inv-totals">
        <div class="amount-words">
          <div class="label">Amount in Words</div>
          {amountInWords(doc.grandTotal)}
        </div>
        <table>
          <tbody>
            <tr>
              <td>Subtotal</td>
              <td>{formatAmount(doc.subtotal)}</td>
            </tr>
            {doc.gst && doc.gst.cgst > 0n && (
              <tr>
                <td>CGST</td>
                <td>{formatAmount(doc.gst.cgst)}</td>
              </tr>
            )}
            {doc.gst && doc.gst.sgst > 0n && (
              <tr>
                <td>SGST</td>
                <td>{formatAmount(doc.gst.sgst)}</td>
              </tr>
            )}
            {doc.gst && doc.gst.igst > 0n && (
              <tr>
                <td>IGST</td>
                <td>{formatAmount(doc.gst.igst)}</td>
              </tr>
            )}
            {doc.roundOff !== undefined && doc.roundOff !== 0n && (
              <tr>
                <td>Round Off</td>
                <td>{doc.roundOff < 0n ? '(-) ' : ''}{formatAmount(doc.roundOff < 0n ? -doc.roundOff : doc.roundOff)}</td>
              </tr>
            )}
            <tr class="grand">
              <td>Grand Total</td>
              <td>₹ {formatAmount(doc.grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {doc.narration && <Narration text={doc.narration} />}
      <BankAndSign company={company} />
    </>
  );
}

function StockBody({ doc, company, copyLabel }: { doc: StockDoc; company: PrintCompany; copyLabel: string | undefined }) {
  return (
    <>
      <CompanyHead company={company} docTitle={doc.docTitle} copyLabel={copyLabel} number={doc.number} date={doc.date} />
      <table class="items">
        <thead>
          <tr>
            <th class="center sno">S.No.</th>
            <th>Item</th>
            <th>Godown</th>
            <th class="center">In / Out</th>
            <th class="num">Qty</th>
            <th class="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l, i) => (
            <tr key={i}>
              <td class="center sno">{i + 1}</td>
              <td>{l.item}</td>
              <td>{l.warehouse}</td>
              <td class="center">{l.direction === 'in' ? 'In' : 'Out'}</td>
              <td class="num">{l.qty}</td>
              <td class="num">{formatAmount(l.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {doc.narration && <Narration text={doc.narration} />}
    </>
  );
}

function Parties({ party }: { party: PrintParty }) {
  return (
    <div class="inv-parties">
      <AddressBlock label="Bill To" address={{ name: party.name, ...party.billTo }} gstin={party.gstin} />
      <AddressBlock label="Ship To" address={{ name: party.name, ...(party.shipTo ?? party.billTo) }} />
    </div>
  );
}

/** Dispatch docket, page one: who it goes to, the invoices it carries and how. */
function DocketPageOne({ doc, company }: { doc: DocketDoc; company: PrintCompany }) {
  const total = doc.invoices.reduce((s, i) => s + i.amount, 0n);
  return (
    <>
      <CompanyHead company={company} docTitle="DISPATCH DOCKET" copyLabel={undefined} numberLabel="Dispatch No." number={doc.number} date={doc.date} />
      <Parties party={doc.party} />
      <div class="docket-label">Invoices Included</div>
      <table class="items">
        <thead>
          <tr>
            <th class="center sno">S.No.</th>
            <th>Invoice No.</th>
            <th>Date</th>
            <th>PO No.</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.invoices.map((inv, i) => (
            <tr key={i}>
              <td class="center sno">{i + 1}</td>
              <td>{inv.number}</td>
              <td>{formatDate(inv.date)}</td>
              <td>{inv.poNo}</td>
              <td class="num">{formatAmount(inv.amount)}</td>
            </tr>
          ))}
          <tr class="total">
            <td />
            <td colSpan={3}>
              Total ({doc.invoices.length} invoice{doc.invoices.length === 1 ? '' : 's'})
            </td>
            <td class="num">₹ {formatAmount(total)}</td>
          </tr>
        </tbody>
      </table>
      <table class="docket-facts">
        <tbody>
          <tr>
            <td>Packages</td>
            <td>{doc.packages}</td>
          </tr>
          <tr>
            <td>Transporter</td>
            <td>{doc.transporter}</td>
          </tr>
          <tr>
            <td>LR No.</td>
            <td>{doc.lrNo}</td>
          </tr>
        </tbody>
      </table>
      <div class="inv-sign">
        <div>
          <div class="for-company">For {company.name}</div>
          <div class="sign-line">Authorised Signatory</div>
        </div>
      </div>
    </>
  );
}

/** Dispatch docket, page two: every item on those invoices, like items added together. */
function DocketPageTwo({ doc, company }: { doc: DocketDoc; company: PrintCompany }) {
  return (
    <>
      <CompanyHead company={company} docTitle="DISPATCH DOCKET" copyLabel="Item list" numberLabel="Dispatch No." number={doc.number} date={doc.date} />
      <table class="items">
        <thead>
          <tr>
            <th class="center sno">S.No.</th>
            <th>Item</th>
            <th class="center">HSN</th>
            <th class="num">Qty</th>
          </tr>
        </thead>
        <tbody>
          {doc.items.map((it, i) => (
            <tr key={i}>
              <td class="center sno">{i + 1}</td>
              <td>{it.desc}</td>
              <td class="center">{it.hsn}</td>
              <td class="num">{it.qty}</td>
            </tr>
          ))}
          <tr class="total">
            <td />
            <td colSpan={2}>
              Total ({doc.items.length} item{doc.items.length === 1 ? '' : 's'})
            </td>
            <td class="num">{doc.totalQty}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function ReportBody({ doc }: { doc: ReportDoc }) {
  return (
    <>
      <div class="rpt-head">
        <div class="name">{doc.title}</div>
        <div>{doc.period}</div>
        {doc.filters.map((f, i) => (
          <div key={i}>{f}</div>
        ))}
      </div>
      <table class="items">
        <thead>
          <tr>
            {doc.columns.map((c, i) => (
              <th key={i} class={c.align === 'right' ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {doc.rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j} class={doc.columns[j]?.align === 'right' ? 'num' : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p class="inv-narration">{doc.rowCount}</p>
    </>
  );
}

/** Indian numbering (thousand / lakh / crore) — the words come from the same figure that prints as a number. */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigitWords(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? ` ${ONES[o]}` : '');
}
function threeDigitWords(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  let s = h ? `${ONES[h]} Hundred` : '';
  if (r) s += (s ? ' ' : '') + twoDigitWords(r);
  return s;
}
function numberToWordsIndian(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  const parts: string[] = [];
  if (crore) parts.push(`${threeDigitWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigitWords(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigitWords(thousand)} Thousand`);
  if (n) parts.push(threeDigitWords(n));
  return parts.join(' ');
}
/** `grandTotal` is minor units (paise, per the app's own money convention). */
function amountInWords(grandTotal: bigint): string {
  const rupees = Number(grandTotal / 100n);
  const paise = Number(grandTotal % 100n);
  let s = `Rupees ${numberToWordsIndian(rupees)}`;
  if (paise > 0) s += ` and ${numberToWordsIndian(paise)} Paise`;
  return `${s} Only`;
}

/**
 * One hidden root, shown only while printing (`print.css`): one `.print-copy` per label for a voucher (Original,
 * Duplicate, …), or a single unlabelled one for a report. Mounting this and calling `window.print()` is the whole
 * mechanism — see `PrintCoordinator`. Several documents (vouchers chosen on a list) print one after another, each in all its copies.
 */
export function PrintView({ docs, company, copies }: { docs: readonly PrintDoc[]; company: PrintCompany; copies: readonly string[] }) {
  return (
    <div class="print-root" id="print-root">
      {docs.flatMap((doc, d) =>
        doc.kind === 'docket'
          ? [
              <div key={`${d}-docket-1`} class="paper print-copy bordered">
                <DocketPageOne doc={doc} company={company} />
              </div>,
              <div key={`${d}-docket-2`} class="paper print-copy bordered">
                <DocketPageTwo doc={doc} company={company} />
              </div>,
            ]
          : copies.map((label, i) => (
              <div key={`${d}-${label}-${i}`} class={doc.kind === 'report' ? 'paper print-copy' : 'paper print-copy bordered'}>
                {doc.kind === 'ledger' && <LedgerBody doc={doc} company={company} copyLabel={label} />}
                {doc.kind === 'invoice' && <InvoiceBody doc={doc} company={company} copyLabel={label} />}
                {doc.kind === 'stock' && <StockBody doc={doc} company={company} copyLabel={label} />}
                {doc.kind === 'report' && <ReportBody doc={doc} />}
              </div>
            )),
      )}
    </div>
  );
}
