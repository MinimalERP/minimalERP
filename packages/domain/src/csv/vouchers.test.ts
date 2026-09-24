import { describe, expect, it } from 'vitest';
import { parseVouchersCsv, serializeVouchersCsv, type VoucherEntry, vouchersCsvTemplate } from './vouchers';

const header =
  'docRef,kind,partyName,partyGstin,partyAddress,date,poNumber,invoiceNumber,dueDate,subtotal,grandTotal,description,code,hsn,qty,unit,rate,amount,gstRate,lineDueDate';

describe('parseVouchersCsv', () => {
  it('groups rows by docRef into one Extraction per document, in file order', () => {
    const csv = [
      header,
      'INV-1,sales,Acme Ltd,27AAACE9659G1ZB,,2026-04-03,PO-1,,2026-05-18,2160.00,2549.00,ORIF bracket,KS354,84879000,12,Nos,180,,18,',
      'INV-1,sales,Acme Ltd,27AAACE9659G1ZB,,2026-04-03,PO-1,,2026-05-18,2160.00,2549.00,Set screw,MX407,73181500,250,Nos,22.5,,18,',
      'INV-2,sales,Beta Ltd,,,2026-04-05,,,,500,500,Freight,,,1,,500,,,',
    ].join('\n');
    const entries = parseVouchersCsv(csv);
    expect(entries.map((e) => e.docRef)).toEqual(['INV-1', 'INV-2']);
    expect(entries[0]?.kind).toBe('sales');
    expect(entries[0]?.extraction.partyName).toBe('Acme Ltd');
    expect(entries[0]?.extraction.lines).toHaveLength(2);
    expect(entries[0]?.extraction.lines[0]).toMatchObject({ description: 'ORIF bracket', code: 'KS354', qty: '12', rate: '180', gstRate: '18' });
    expect(entries[1]?.extraction.lines).toHaveLength(1);
  });

  it('drops a row with no docRef, or an unrecognised kind', () => {
    const csv = [header, ',sales,Acme,,,,,,,,,,,,,,,,,', 'INV-9,receipt,Acme,,,,,,,,,,,,,,,,,'].join('\n');
    expect(parseVouchersCsv(csv)).toEqual([]);
  });
});

describe('serializeVouchersCsv round-trip', () => {
  it('reads back the same docRef, kind and line count it wrote', () => {
    const entries: VoucherEntry[] = [
      {
        docRef: 'INV-1',
        kind: 'sales',
        extraction: {
          partyName: 'Acme Ltd',
          partyGstin: '27AAACE9659G1ZB',
          date: '2026-04-03',
          lines: [
            { description: 'ORIF bracket', code: 'KS354', hsn: '84879000', qty: '12', unit: 'Nos', rate: '180', gstRate: '18' },
            { description: 'Set screw', code: 'MX407', hsn: '73181500', qty: '250', unit: 'Nos', rate: '22.5', gstRate: '18' },
          ],
          subtotal: '2160.00',
          grandTotal: '2549.00',
          bills: [],
        },
      },
    ];
    const csv = serializeVouchersCsv(entries);
    const back = parseVouchersCsv(csv);
    expect(back).toHaveLength(1);
    expect(back[0]?.docRef).toBe('INV-1');
    expect(back[0]?.kind).toBe('sales');
    expect(back[0]?.extraction.lines).toHaveLength(2);
    expect(back[0]?.extraction).toMatchObject({ partyName: 'Acme Ltd', partyGstin: '27AAACE9659G1ZB', subtotal: '2160.00', grandTotal: '2549.00' });
  });
});

describe('vouchersCsvTemplate', () => {
  it('parses to a two-line Sales Invoice and a one-line Sales Order', () => {
    const entries = parseVouchersCsv(vouchersCsvTemplate());
    expect(entries.map((e) => [e.docRef, e.kind, e.extraction.lines.length])).toEqual([
      ['SAMPLE-1', 'sales', 2],
      ['SAMPLE-2', 'salesOrder', 1],
    ]);
  });
});
