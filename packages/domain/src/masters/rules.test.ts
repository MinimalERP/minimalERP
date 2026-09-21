import { describe, expect, it } from 'vitest';
import {
  canonicalId,
  emailProblem,
  gstinCheckChar,
  gstinProblem,
  hsnProblem,
  isDecimalText,
  nameKey,
  normalizeName,
  panOfGstin,
  panProblem,
  phoneProblem,
  stateOfGstin,
} from './rules';

describe('GSTIN', () => {
  it('accepts a real, correctly checksummed GSTIN', () => {
    expect(gstinProblem('27AAPFU0939F1ZV')).toBeUndefined(); // a widely published Maharashtra sample
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V');
  });

  it('computes the check character for any valid 14-character prefix', () => {
    for (const prefix of ['29AABCT1332L1Z', '07AAACR5055K1Z', '33AAACG0569P1Z', '24AAACC1206D1Z']) {
      const gstin = prefix + gstinCheckChar(prefix);
      expect(gstinProblem(gstin), gstin).toBeUndefined();
    }
  });

  it('rejects a wrong check digit — even off by one character', () => {
    const good = '27AAPFU0939F1ZV';
    expect(gstinProblem(good.slice(0, 14) + 'W')).toMatch(/check digit/);
    expect(gstinProblem('27AAPFU0939F1ZA')).toMatch(/check digit/);
  });

  it('rejects a single mistyped character anywhere in the body (the checksum catches typos)', () => {
    const good = '27AAPFU0939F1ZV';
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let caught = 0;
    let tried = 0;
    for (let i = 2; i < 14; i++) {
      for (const ch of alphabet) {
        if (ch === good[i]) continue;
        const bad = good.slice(0, i) + ch + good.slice(i + 1);
        if (gstinProblem(bad) === undefined) continue; // shape-valid AND checksum-valid by coincidence
        caught++;
        tried++;
      }
    }
    expect(caught).toBe(tried);
    expect(caught).toBeGreaterThan(300);
  });

  it.each(['', '27AAPFU0939F1Z', '27AAPFU0939F1ZVV', '27aapfu0939f1zv', '27AAPFU0939F1XV', 'ABAAPFU0939F1ZV'])('rejects malformed %j', (g) => {
    expect(gstinProblem(g)).toBeDefined();
  });

  it.each(['00', '39', '40', '98'])('rejects the impossible state code %s', (code) => {
    const prefix = `${code}AAPFU0939F1Z`;
    expect(gstinProblem(prefix + gstinCheckChar(prefix))).toMatch(/state code/);
  });

  it('extracts the PAN and state', () => {
    expect(panOfGstin('27AAPFU0939F1ZV')).toBe('AAPFU0939F');
    expect(stateOfGstin('27AAPFU0939F1ZV')).toBe('27');
  });
});

describe('PAN, HSN, phone, email', () => {
  it.each(['ABCDE1234F', 'AAPFU0939F'])('PAN %s is fine', (p) => expect(panProblem(p)).toBeUndefined());
  it.each(['', 'ABCDE1234', 'abcde1234f', 'ABCD12345F', '1234567890'])('PAN %j is not', (p) => expect(panProblem(p)).toBeDefined());

  it.each(['1234', '123456', '12345678'])('HSN/SAC %s is fine', (h) => expect(hsnProblem(h)).toBeUndefined());
  it.each(['', '123', '12345', '1234567', '123456789', '12AB'])('HSN/SAC %j is not', (h) => expect(hsnProblem(h)).toBeDefined());

  it.each(['9876543210', '+91 98765 43210', '98765-43210', '+919876543210', '022 2345 6789'.replace(/ /g, '')])('phone %s is fine', (p) =>
    expect(phoneProblem(p)).toBeUndefined(),
  );
  it.each(['12345', '0000000000', 'abc', '98765432'])('phone %j is not', (p) => expect(phoneProblem(p)).toBeDefined());

  it.each(['a@b.co', 'first.last@company.in'])('email %s is fine', (e) => expect(emailProblem(e)).toBeUndefined());
  it.each(['', 'a@b', '@b.com', 'a b@c.com', 'plain'])('email %j is not', (e) => expect(emailProblem(e)).toBeDefined());
});

describe('names and identifiers', () => {
  it('normalises whitespace', () => {
    expect(normalizeName('  ABC   Industries \n')).toBe('ABC Industries');
  });

  it('compares names case- and spacing-insensitively', () => {
    expect(nameKey('ABC  Industries')).toBe(nameKey(' abc industries '));
    expect(nameKey('ABC Industries')).not.toBe(nameKey('ABC Industry'));
  });

  it('canonicalises identifiers a person typed', () => {
    expect(canonicalId(' 27aapfu 0939f1zv ')).toBe('27AAPFU0939F1ZV');
  });

  it('recognises decimal text', () => {
    for (const ok of ['0', '18', '12.5', '0.05', '100']) expect(isDecimalText(ok), ok).toBe(true);
    for (const bad of ['', '-1', '1,5', '1.23456', '.5', 'abc', '1e3']) expect(isDecimalText(bad), bad).toBe(false);
  });
});
