import type { PrintLayouts } from '@minimalerp/ports';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { PrintAddress, PrintParty, PrintCompany, LedgerDoc, InvoiceDoc, StockDoc, ReportDoc, DocketDoc, PrintDoc } from './printDocs';
import { layoutFor, renderLayout } from './printTemplate';
import { amountInWords } from './words';
import { formatAmount, formatDate } from '../vouchers/format';

/**
 * What a printed page shows, hidden on screen and revealed only by `@media print` (see `print.css`), one `.print-copy`
 * per label — Original / Duplicate / Triplicate / Extra Copy for a voucher, a single unlabelled page for a report.
 * Every figure here is one already computed on screen (the preview the voucher/report already shows): this never
 * recomputes GST, a total or a balance — it only lays out numbers the screen has already checked.
 */

export type { PrintAddress, PrintParty, PrintCompany, LedgerDoc, InvoiceDoc, StockDoc, ReportDoc, DocketDoc, PrintDoc } from './printDocs';


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


/**
 * A company's own layout, already filled and cleaned (see `printTemplate.ts`), in a shadow root: its styles are its own and cannot reach
 * the app, and the app's cannot reach it. It sits inside the same framed `.print-copy` as the built-in layout.
 */
export function OwnLayout({ html }: { html: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    root.innerHTML = html;
  }, [html]);
  return <div ref={host} class="own-layout" data-testid="own-layout" />;
}

/**
 * One hidden root, shown only while printing (`print.css`): one `.print-copy` per label for a voucher (Original,
 * Duplicate, …), or a single unlabelled one for a report. Mounting this and calling `window.print()` is the whole
 * mechanism — see `PrintCoordinator`. Several documents (vouchers chosen on a list) print one after another, each in all its copies.
 */
export function PrintView({ docs, company, copies, layouts }: { docs: readonly PrintDoc[]; company: PrintCompany; copies: readonly string[]; layouts?: PrintLayouts | undefined }) {
  /** The company's own layout for an invoice or voucher, filled and cleaned — undefined for the built-in one (none set, or it cannot be read). */
  const own = (doc: PrintDoc, label: string): string | undefined => {
    if (doc.kind !== 'invoice' && doc.kind !== 'ledger') return undefined;
    const template = layoutFor(layouts, doc);
    const r = template ? renderLayout(template, doc, company, label, layouts?.images ?? {}) : undefined;
    return r?.ok ? r.html : undefined;
  };
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
          : copies.map((label, i) => {
              const html = own(doc, label);
              return (
                <div key={`${d}-${label}-${i}`} class={doc.kind === 'report' ? 'paper print-copy' : 'paper print-copy bordered'}>
                  {html !== undefined ? (
                    <OwnLayout html={html} />
                  ) : (
                    <>
                      {doc.kind === 'ledger' && <LedgerBody doc={doc} company={company} copyLabel={label} />}
                      {doc.kind === 'invoice' && <InvoiceBody doc={doc} company={company} copyLabel={label} />}
                      {doc.kind === 'stock' && <StockBody doc={doc} company={company} copyLabel={label} />}
                      {doc.kind === 'report' && <ReportBody doc={doc} />}
                    </>
                  )}
                </div>
              );
            }),
      )}
    </div>
  );
}
