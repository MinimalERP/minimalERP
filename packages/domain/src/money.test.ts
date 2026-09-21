import { describe, expect, it } from 'vitest';
import { allocateMoney, formatMoney, isZeroMoney, money, parseMoney, sumMoney } from './money';

describe('parseMoney', () => {
  it.each([
    ['1234.56', 123456n],
    ['1234', 123400n],
    ['0.5', 50n],
    ['0.05', 5n],
    ['0', 0n],
    ['-0.05', -5n],
    ['-12', -1200n],
  ])('parses %s', (text, minor) => {
    expect(parseMoney(text)).toBe(minor);
  });

  it.each(['', ' 1', '1 ', '1,000', '1.234', '.5', '5.', '1e3', '--1', '+1', 'abc', '1.2.3'])(
    'rejects %j',
    (text) => {
      expect(parseMoney(text)).toBeUndefined();
    },
  );

  it('handles amounts far beyond Number.MAX_SAFE_INTEGER without losing a paisa', () => {
    expect(parseMoney('90071992547409930.01')).toBe(9007199254740993001n);
  });
});

describe('formatMoney', () => {
  it.each([
    [0n, '0.00'],
    [5n, '0.05'],
    [100n, '1.00'],
    [123456n, '1234.56'],
    [-12345n, '-123.45'],
    [-5n, '-0.05'],
  ])('formats %s as %s', (minor, text) => {
    expect(formatMoney(money(minor))).toBe(text);
  });

  it('round-trips through parse', () => {
    for (const minor of [0n, 1n, 99n, 100n, 101n, 123456789n, -1n, -99999n]) {
      expect(parseMoney(formatMoney(money(minor)))).toBe(minor);
    }
  });
});

describe('sumMoney / isZeroMoney', () => {
  it('sums exactly', () => {
    expect(sumMoney([money(10n), money(20n), money(-5n)])).toBe(25n);
    expect(sumMoney([])).toBe(0n);
  });
  it('detects zero', () => {
    expect(isZeroMoney(money(0n))).toBe(true);
    expect(isZeroMoney(money(1n))).toBe(false);
  });
});

describe('allocateMoney (largest remainder)', () => {
  it('splits ₹1.00 three ways without losing a paisa', () => {
    expect(allocateMoney(money(100n), [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
  });

  it('is proportional to weights', () => {
    expect(allocateMoney(money(1000n), [1n, 3n])).toEqual([250n, 750n]);
  });

  it('gives leftover units to the largest remainders, earlier index winning ties', () => {
    // 10 split [1,1,1,1,1,1,1] (7 ways): base 1 each = 7, leftover 3 → first three indices.
    expect(allocateMoney(money(10n), [1n, 1n, 1n, 1n, 1n, 1n, 1n])).toEqual([2n, 2n, 2n, 1n, 1n, 1n, 1n]);
  });

  it('allocates negative totals symmetrically', () => {
    expect(allocateMoney(money(-100n), [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
  });

  it('gives zero-weight parts nothing', () => {
    expect(allocateMoney(money(100n), [0n, 1n])).toEqual([0n, 100n]);
  });

  it('rejects empty, negative and all-zero weights', () => {
    expect(() => allocateMoney(money(1n), [])).toThrow(RangeError);
    expect(() => allocateMoney(money(1n), [-1n, 2n])).toThrow(RangeError);
    expect(() => allocateMoney(money(1n), [0n, 0n])).toThrow(RangeError);
  });
});
