import { describe, expect, it } from 'vitest';
import { readPurchaseOrder } from './purchaseOrder';

// The layout of Eclipse Combustion's (Honeywell SAP) purchase order as PDF text comes out of it — a page break inside the first line's
// block, a price per 1,000 — with made-up figures.
const po = (total: string) => `Sold To:
Eclipse Combustion Private Limited
Vendor Address:
OUR COMPANY
GSTIN : 27AAAAA0000A1Z5
Bill to address:
GSTIN: 27AAACE9659G1ZB
Eclipse Combustion Pvt Ltd,
Item Material/Description Quantity UoM Unit Price Net Amount TAX
10 10046885 2.00 EA 315.00 / EA 630.00 Y
BLCK,SHIM,MTG,ACT
Revision Level A
HSN/SAC Code : 84169000
Taxes and Duties
Purchase order
Number
4423700001
Version
0
Date
26-AUG-2026
Page 1 of 3
Purchase order
Number
4423700001
Central GST 9 %, State GST 9 %
Terms of delivery : EXW(Ex Works) /ex wroks
Honeywell Request Date: 26-NOV-2026
20 14191-9 1.00 EA 195,000.00 /1,000 EA 195.00 Y
ORIF PLT,GAS,14 MM
Revision Level AH
HSN/SAC Code : 84169000
Taxes and Duties
Central GST 9 %, State GST 9 %
Honeywell Request Date: 25-SEP-2026
Orifice Plate, Gas, 14 mm
_________________
Total net value excl. tax INR ${total}
Approved by: Buyer
PO Number: 4423700001 Page 3 of 3
GENERAL TERMS AND CONDITIONS OF PURCHASE`;

describe('readPurchaseOrder — Eclipse Combustion (Honeywell SAP)', () => {
  it('reads every line — code, description, HSN, qty, unit, rate per unit, amount and its due date — and the header', () => {
    expect(readPurchaseOrder(po('825.00'))).toEqual({
      partyName: 'Eclipse Combustion Pvt Ltd',
      partyGstin: '27AAACE9659G1ZB',
      poNumber: '4423700001',
      date: '2026-08-26',
      subtotal: '825.00',
      lines: [
        { code: '10046885', description: 'BLCK,SHIM,MTG,ACT', hsn: '84169000', qty: '2.00', unit: 'EA', rate: '315', amount: '630.00', dueDate: '2026-11-26' },
        { code: '14191-9', description: 'ORIF PLT,GAS,14 MM', hsn: '84169000', qty: '1.00', unit: 'EA', rate: '195', amount: '195.00', dueDate: '2026-09-25' },
      ],
      bills: [],
    });
  });

  it('reads nothing when the rows do not come to the printed total, or the layout is another', () => {
    expect(readPurchaseOrder(po('830.00'))).toBeUndefined();
    expect(readPurchaseOrder('PURCHASE ORDER from Acme Ltd, 10 Hex Bolt 100 Nos 4.50')).toBeUndefined();
  });

  // A modification / service charge line prints with no Material column at all — the row goes straight from the item number to the
  // quantity — so the row is one field shorter than an item line, and has no code, only its description.
  it('reads a line charge that has no material code — a modification or service charge, not a part', () => {
    const text = `Sold To:
Eclipse Combustion Private Limited
Vendor Address:
OUR COMPANY
GSTIN : 27AAAAA0000A1Z5
Bill to address:
GSTIN: 27AAACE9659G1ZB
Eclipse Combustion Pvt Ltd,
Item Material/Description Quantity UoM Unit Price Net Amount TAX
10 10046885 2.00 EA 315.00 / EA 630.00 Y
BLCK,SHIM,MTG,ACT
HSN/SAC Code : 84169000
Taxes and Duties
Purchase order
Number
4423897154
Version
0
Date
05-OCT-2026
Central GST 9 %, State GST 9 %
Honeywell Request Date: 26-NOV-2026
20 3.00 EA 2500.00 / EA 7500.00 Y
KS84008024-BIO 140H modification charges
HSN/SAC Code : 84879000
Honeywell Request Date: 29-OCT-2026
_________________
Total net value excl. tax INR 8130.00
Approved by: Buyer
PO Number: 4423897154 Page 1 of 1
GENERAL TERMS AND CONDITIONS OF PURCHASE`;
    expect(readPurchaseOrder(text)).toEqual({
      partyName: 'Eclipse Combustion Pvt Ltd',
      partyGstin: '27AAACE9659G1ZB',
      poNumber: '4423897154',
      date: '2026-10-05',
      subtotal: '8130.00',
      lines: [
        { code: '10046885', description: 'BLCK,SHIM,MTG,ACT', hsn: '84169000', qty: '2.00', unit: 'EA', rate: '315', amount: '630.00', dueDate: '2026-11-26' },
        { description: 'KS84008024-BIO 140H modification charges', hsn: '84879000', qty: '3.00', unit: 'EA', rate: '2500', amount: '7500.00', dueDate: '2026-10-29' },
      ],
      bills: [],
    });
  });
});
