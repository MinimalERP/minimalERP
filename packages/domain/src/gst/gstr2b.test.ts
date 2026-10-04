import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { money } from '../money';
import type { GstInvoice } from '../reports/gst';
import { type Gstr2bFile, gstRateOfFigures, itcFollowUpRows, itcFollowUpTotals, gstr2bFromJson, gstr2bPeriodLabel, gstr2bTotals, matchGstr2b, normaliseInvoiceNo } from './gstr2b';

/** The shape the GST portal's GSTR-2B JSON has (figures on the invoice, as its summary download writes them). */
const portal = {
  chksum: 'x',
  data: {
    gstin: '27ABUFM9776A1ZL',
    rtnprd: '062026',
    version: '1.0',
    docdata: {
      b2b: [
        {
          ctin: '27BKYPC9399H1Z5',
          trdnm: 'SADHI STEEL CENTRE',
          supprd: '042026',
          inv: [
            { inum: 'SSC/26-27/224', dt: '29-04-2026', val: 64098, txval: 54320, cgst: 4888.8, sgst: 4888.8, igst: 0, cess: 0, rev: 'N', itcavl: 'Y', typ: 'R', pos: '27' },
            { inum: 'SSC/26-27/301', dt: '12-05-2026', val: 1180, txval: 1000, cgst: 90, sgst: 90, igst: 0, rev: 'Y', itcavl: 'N' },
          ],
        },
        // the detailed download: rate by rate under `items`
        { ctin: '24AAACB1234C1Z9', trdnm: 'BHARAT CHEM', inv: [{ inum: '0045', dt: '03-06-2026', val: 5900, items: [{ rt: 18, txval: 3000, igst: 540 }, { rt: 18, txval: 2000, igst: 360 }] }] },
      ],
      cdnr: [{ ctin: '27BKYPC9399H1Z5', nt: [{ ntnum: '26', typ: 'C', txval: 75468.75 }] }],
    },
  },
};

const file = (): Gstr2bFile => {
  const r = gstr2bFromJson(portal);
  if (!r.ok) throw new Error(r.issues[0]?.message);
  return r.value;
};

const purchase = (over: Omit<Partial<GstInvoice>, 'voucherId'> & { voucherId: string; billNo: string; gstin: string }): GstInvoice =>
  ({
    number: `PUR/${over.voucherId}`,
    date: localDate('2026-05-02'),
    side: 'purchase',
    partyId: 'p1',
    party: 'Sadhi Steel Centre',
    taxable: money(5_432_000n),
    cgst: money(488_880n),
    sgst: money(488_880n),
    igst: money(0n),
    tax: money(977_760n),
    ...over,
  }) as unknown as GstInvoice;

const range = { from: localDate('2026-04-01'), to: localDate('2026-06-30') };

describe('reading a GSTR-2B file', () => {
  it('reads the B2B invoices to the paisa, whether the figures are on the invoice or under its items', () => {
    const f = file();
    expect(f).toMatchObject({ gstin: '27ABUFM9776A1ZL', period: '062026', skipped: { creditNotes: 1, amendments: 0, imports: 0 } });
    expect(f.invoices).toHaveLength(3);
    expect(f.invoices[0]).toMatchObject({ gstin: '27BKYPC9399H1Z5', supplier: 'SADHI STEEL CENTRE', number: 'SSC/26-27/224', date: '2026-04-29', taxable: 5_432_000n, cgst: 488_880n, sgst: 488_880n, igst: 0n, value: 6_409_800n, reverseCharge: false, itcAvailable: true });
    expect(f.invoices[1]).toMatchObject({ reverseCharge: true, itcAvailable: false });
    expect(f.invoices[2]).toMatchObject({ number: '0045', taxable: 500_000n, igst: 90_000n });
    expect(gstr2bPeriodLabel(f.period)).toBe('Jun 2026');
  });

  it('refuses a GSTR-1 file by name, and anything else', () => {
    const r1 = gstr2bFromJson({ gstin: '27ABUFM9776A1ZL', fp: '062026', b2b: [] });
    expect(r1.ok).toBe(false);
    expect(!r1.ok && r1.issues[0]?.message).toContain('GSTR-1');
    expect(gstr2bFromJson({ hello: 1 }).ok).toBe(false);
    expect(gstr2bFromJson('text').ok).toBe(false);
  });
});

describe('an invoice number, as two people write it', () => {
  it('is the same without the punctuation, the case and the zeros in front', () => {
    expect(normaliseInvoiceNo('INV/001')).toBe(normaliseInvoiceNo('inv-1'));
    expect(normaliseInvoiceNo('SSC/26-27/224')).toBe(normaliseInvoiceNo('ssc 26 27 0224'));
    expect(normaliseInvoiceNo('0045')).toBe('45');
    expect(normaliseInvoiceNo('100')).not.toBe(normaliseInvoiceNo('10'));
    expect(normaliseInvoiceNo('A0')).toBe('A0');
  });
});

describe('the purchases to follow up', () => {
  it('lists what no GSTR-2B has confirmed — missing or not checked — by supplier then date, and leaves out the matched, the unregistered and the untaxed', () => {
    const purchases = [
      purchase({ voucherId: 'm', billNo: 'A1', gstin: '27BKYPC9399H1Z5' }), // matched
      purchase({ voucherId: 'x', billNo: 'A2', gstin: '27BKYPC9399H1Z5', date: localDate('2026-05-09') }), // a statement did not have it
      purchase({ voucherId: 'u', billNo: 'A3', gstin: '27BKYPC9399H1Z5', date: localDate('2026-05-03') }), // never checked
      purchase({ voucherId: 'k', billNo: 'K1', gstin: '27AAACK1111K1Z2', party: 'Kumar Engg', tax: money(18_000n) }),
      purchase({ voucherId: 'n', billNo: 'N1', gstin: '' }), // an unregistered supplier
      purchase({ voucherId: 'r', billNo: 'R1', gstin: '27BKYPC9399H1Z5', tax: money(0n) }), // reverse charge: no GST on the voucher
    ];
    const tags = new Map([
      ['m', { period: '062026', status: 'matched' as const }],
      ['x', { period: '062026', status: 'missing' as const }],
    ]);
    const rows = itcFollowUpRows({ purchases, tags });
    expect(rows.map((r) => [r.supplier, r.billNo, r.status, r.period])).toEqual([
      ['Kumar Engg', 'K1', 'unchecked', undefined],
      ['Sadhi Steel Centre', 'A3', 'unchecked', undefined],
      ['Sadhi Steel Centre', 'A2', 'missing', '062026'],
    ]);
    expect(itcFollowUpTotals(rows)).toEqual({ count: 3, tax: 1_973_520n, missing: 977_760n, unchecked: 995_760n });
  });
});

describe('the file against the books', () => {
  it('finds each invoice by GSTIN and number: matched within a rupee, a mismatch when a figure differs, and what each side lacks', () => {
    const purchases = [
      // the same invoice, written our way, a few paise off, entered in May
      purchase({ voucherId: 'v1', billNo: 'ssc-26-27-0224', gstin: '27BKYPC9399H1Z5', cgst: money(488_900n), sgst: money(488_900n) }),
      // found, but the taxable value differs
      purchase({ voucherId: 'v2', billNo: '45', gstin: '24AAACB1234C1Z9', party: 'Bharat Chemicals', taxable: money(450_000n), cgst: money(0n), sgst: money(0n), igst: money(90_000n), tax: money(90_000n) }),
      // in the books, in the period, with GST — and not in the file
      purchase({ voucherId: 'v3', billNo: 'KK/9', gstin: '27AAACK1111K1Z2', party: 'Kumar Engg' }),
      // outside the period, and an unregistered supplier's: neither is expected on the GST site
      purchase({ voucherId: 'v4', billNo: 'OLD/1', gstin: '27AAACK1111K1Z2', date: localDate('2026-02-01') }),
      purchase({ voucherId: 'v5', billNo: 'X1', gstin: '' }),
    ];
    const rows = matchGstr2b({ file: file(), purchases, range });
    expect(rows.map((r) => [r.status, r.number, r.voucherId])).toEqual([
      ['mismatch', '0045', 'v2'],
      ['not-in-books', 'SSC/26-27/301', undefined],
      ['not-on-portal', 'KK/9', 'v3'],
      ['matched', 'SSC/26-27/224', 'v1'],
    ]);
    expect(rows[0]?.note).toBe('Taxable 5000.00 on the GST site, 4500.00 in the books');
    expect(rows[1]?.note).toBe('Reverse charge: the GST is paid by you, not on the voucher · The portal says ITC is not available');
    expect(rows[1]?.reverseCharge).toBe(true);
    const t = gstr2bTotals(rows);
    expect(t.matched).toEqual({ count: 1, tax: 977_760n });
    expect(t['not-in-books']).toEqual({ count: 1, tax: 18_000n });
    expect(t['not-on-portal'].count).toBe(1);
  });

  it('a purchase entered outside the period still matches; one tagged earlier is not "not on the GST site"; a tag is carried on its row', () => {
    const purchases = [
      purchase({ voucherId: 'v1', billNo: 'SSC/26-27/224', gstin: '27BKYPC9399H1Z5', date: localDate('2026-07-03') }),
      purchase({ voucherId: 'v3', billNo: 'KK/9', gstin: '27AAACK1111K1Z2' }),
    ];
    const rows = matchGstr2b({ file: file(), purchases, range, tagged: new Map([['v3', '052026'], ['v1', '062026']]) });
    expect(rows.filter((r) => r.status === 'not-on-portal')).toEqual([]);
    expect(rows.find((r) => r.voucherId === 'v1')).toMatchObject({ status: 'matched', tagged: '062026' });
  });

  it('a reverse-charge invoice matches a purchase entered without GST: the taxable value is what agrees', () => {
    const f: Gstr2bFile = { ...file(), invoices: [file().invoices[1]!] }; // SSC/26-27/301: taxable 1,000, reverse charge
    const without = purchase({ voucherId: 'r1', billNo: 'SSC/26-27/301', gstin: '27BKYPC9399H1Z5', taxable: money(100_000n), cgst: money(0n), sgst: money(0n), tax: money(0n) });
    expect(matchGstr2b({ file: f, purchases: [without], range })[0]).toMatchObject({ status: 'matched', voucherId: 'r1' });
    const wrong = purchase({ voucherId: 'r2', billNo: 'SSC/26-27/301', gstin: '27BKYPC9399H1Z5', taxable: money(90_000n), cgst: money(0n), sgst: money(0n), tax: money(0n) });
    expect(matchGstr2b({ file: f, purchases: [wrong], range })[0]).toMatchObject({ status: 'mismatch' });
  });

  it('the rate a tax implies: 5% as CGST + SGST, 18% as IGST, 0.25%; none when no rate fits or there is no tax', () => {
    expect(gstRateOfFigures({ taxable: money(24_500n), cgst: money(613n), sgst: money(612n), igst: money(0n) })).toBe('5');
    expect(gstRateOfFigures({ taxable: money(130_000n), cgst: money(0n), sgst: money(0n), igst: money(23_400n) })).toBe('18');
    expect(gstRateOfFigures({ taxable: money(10_000_000n), cgst: money(0n), sgst: money(0n), igst: money(25_000n) })).toBe('0.25');
    expect(gstRateOfFigures({ taxable: money(100_000n), cgst: money(0n), sgst: money(0n), igst: money(17_000n) })).toBeUndefined();
    expect(gstRateOfFigures({ taxable: money(100_000n), cgst: money(0n), sgst: money(0n), igst: money(0n) })).toBeUndefined();
  });

  it('two purchases with one number take one file invoice each, never the same one twice', () => {
    const f: Gstr2bFile = { ...file(), invoices: [file().invoices[0]!] };
    const purchases = [purchase({ voucherId: 'a', billNo: 'SSC/26-27/224', gstin: '27BKYPC9399H1Z5' }), purchase({ voucherId: 'b', billNo: 'SSC/26-27/224', gstin: '27BKYPC9399H1Z5' })];
    const rows = matchGstr2b({ file: f, purchases, range });
    expect(rows.map((r) => [r.status, r.voucherId])).toEqual([['not-on-portal', 'b'], ['matched', 'a']]);
  });
});
