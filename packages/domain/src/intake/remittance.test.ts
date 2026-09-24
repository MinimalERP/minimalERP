import { describe, expect, it } from 'vitest';
import { readRemittanceAdvice } from './remittance';

// The layout of Eclipse Combustion's remittance advice as PDF text comes out of it — words broken across lines — with made-up figures.
const ADVICE = `ECLIPSE COMBUSTION PVT
 L
TD
Dear Sir
,
W
e have processed your payment as given below
.
Date:
12 Aug,2026
Remittance
Advice:
Account Number  :
UTR Number         :
2000001111
ABCDN26700000001
2100000
Bank Key
Bank
Acc
****1234
Invoice / Reference
Gross
Amount
WHT

Amount
GST
 Hold
Amount
Net
Amount
26-27/011
1180.00
2.00
180.00
998.00
26-27/012
2,360.00
4.00
360.00
1996.00
T
otal:
3540.00
6.00
540.00
2994.00`;

describe('readRemittanceAdvice — Eclipse Combustion', () => {
  it('settles each invoice by Net + WHT, WHT as TDS; the receipt is the total Net', () => {
    const x = readRemittanceAdvice(ADVICE);
    expect(x).toMatchObject({
      partyName: 'Eclipse Combustion Pvt Ltd',
      date: '2026-08-12',
      amount: '2994.00',
      instrument: 'ABCDN26700000001',
      bankAccount: '1234',
      bills: [
        { ref: '26-27/011', amount: '1000.00', tds: '2.00' },
        { ref: '26-27/012', amount: '2000.00', tds: '4.00' },
      ],
    });
  });

  it('reads the same advice when the text comes out on one line', () => {
    expect(readRemittanceAdvice(ADVICE.replace(/\s+/g, ' '))?.bills).toHaveLength(2);
  });

  it('rows that do not come to the printed total are not guessed at', () => {
    expect(readRemittanceAdvice(ADVICE.replace('1996.00', '1990.00'))).toBeUndefined();
  });

  it('another payer’s advice is left to the reader', () => {
    expect(readRemittanceAdvice(ADVICE.replace('ECLIPSE COMBUSTION', 'SOMEONE ELSE'))).toBeUndefined();
  });
});
