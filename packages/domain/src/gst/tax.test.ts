import { describe, expect, it } from 'vitest';
import { formatMoney, money } from '../money';
import { canonicalPercent, computeGst, isIntraState, isPercentText, percentHundredths } from './tax';

const m = (text: string) => money(BigInt(Math.round(Number(text) * 100)));
const shown = (b: ReturnType<typeof computeGst>) => [formatMoney(b.taxable), formatMoney(b.cgst), formatMoney(b.sgst), formatMoney(b.igst), formatMoney(b.tax)];

describe('GST arithmetic', () => {
  it('within a state it is CGST + SGST, each half the rate', () => {
    expect(shown(computeGst([{ taxable: m('1000'), rate: '18' }], true))).toEqual(['1000.00', '90.00', '90.00', '0.00', '180.00']);
  });

  it('between states it is IGST, the whole rate', () => {
    expect(shown(computeGst([{ taxable: m('1000'), rate: '18' }], false))).toEqual(['1000.00', '0.00', '0.00', '180.00', '180.00']);
  });

  it('tax is worked out per rate on the sum of the taxable values at that rate, lowest rate first', () => {
    const b = computeGst(
      [
        { taxable: m('100'), rate: '5' },
        { taxable: m('200'), rate: '18' },
        { taxable: m('50.50'), rate: '5' },
        { taxable: m('80'), rate: '0' },
        { taxable: m('20'), rate: undefined },
      ],
      true,
    );
    expect(b.slabs.map((s) => [s.rate, formatMoney(s.taxable), formatMoney(s.cgst), formatMoney(s.sgst)])).toEqual([
      ['0', '100.00', '0.00', '0.00'], // the 0% line and the line with no rate are both nil-rated
      ['5', '150.50', '3.76', '3.76'], // 150.50 × 2.5% = 3.7625 → 3.76 each
      ['18', '200.00', '18.00', '18.00'],
    ]);
    expect(formatMoney(b.tax)).toBe('43.52');
    expect(formatMoney(b.taxable)).toBe('450.50');
  });

  it('rounds half-up to the paisa, each tax head on its own', () => {
    // 10.10 × 2.5% = 0.2525 → 0.25 each side; 10.10 × 5% = 0.505 → 0.51 as IGST
    expect(shown(computeGst([{ taxable: m('10.10'), rate: '5' }], true))).toEqual(['10.10', '0.25', '0.25', '0.00', '0.50']);
    expect(shown(computeGst([{ taxable: m('10.10'), rate: '5' }], false))).toEqual(['10.10', '0.00', '0.00', '0.51', '0.51']);
    // 0.01 × 2.5% is nothing; a paisa is not split
    expect(formatMoney(computeGst([{ taxable: m('0.01'), rate: '5' }], true).tax)).toBe('0.00');
  });

  it('handles fractional rates without a float: 0.25% and 1.5%', () => {
    expect(formatMoney(computeGst([{ taxable: m('1000'), rate: '0.25' }], false).igst)).toBe('2.50');
    expect(formatMoney(computeGst([{ taxable: m('1000'), rate: '1.5' }], false).igst)).toBe('15.00');
  });

  it('a big invoice is exact to the paisa', () => {
    const b = computeGst([{ taxable: m('9999999.99'), rate: '28' }], false);
    expect(formatMoney(b.igst)).toBe('2800000.00'); // 9,999,999.99 × 28% = 2,799,999.9972 → 2,800,000.00
  });

  it('an empty invoice has no tax', () => {
    expect(shown(computeGst([], true))).toEqual(['0.00', '0.00', '0.00', '0.00', '0.00']);
  });
});

describe('rates and states', () => {
  it('a rate is a percentage with up to two decimals, no more than 100', () => {
    for (const ok of ['0', '5', '18', '2.5', '0.25', '100']) expect(isPercentText(ok), ok).toBe(true);
    for (const bad of ['', '-5', '18.123', '101', 'abc', '5%']) expect(isPercentText(bad), bad).toBe(false);
    expect(percentHundredths('18')).toBe(1800n);
    expect(percentHundredths('2.5')).toBe(250n);
  });

  it('canonicalises so that rates compare as text', () => {
    expect([canonicalPercent('18.00'), canonicalPercent('2.50'), canonicalPercent('5'), canonicalPercent(''), canonicalPercent(undefined), canonicalPercent('0.25')]).toEqual(['18', '2.5', '5', '0', '0', '0.25']);
  });

  it('supply is within the state only when both states are known and equal', () => {
    expect(isIntraState('27', '27')).toBe(true);
    expect(isIntraState('27', '07')).toBe(false);
    expect(isIntraState(undefined, '27')).toBe(false);
    expect(isIntraState('27', undefined)).toBe(false);
  });
});
