import { describe, expect, it } from 'vitest';
import { editDistance, fuzzyMatch, highlightSegments, normalize } from './fuzzy';

const TITLES = [
  'Trial Balance', 'Day Book', 'Profit & Loss', 'Balance Sheet', 'Cash Book', 'Bank Book',
  'Create Ledger', 'Create Stock Item', 'New Sales Voucher', 'New Purchase Voucher', 'Stock Summary',
  'Outstanding Receivables', 'GST Reports', 'Keyboard Shortcuts',
];

/** The titles that match, best first. */
const rank = (query: string, titles = TITLES) =>
  titles
    .map((t) => ({ t, m: fuzzyMatch(query, t) }))
    .filter((x) => x.m)
    .sort((a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0))
    .map((x) => x.t);

describe('fuzzyMatch: what should find what', () => {
  it.each([
    // query,               expected top result
    ['trial balance', 'Trial Balance'],
    ['TRIAL BALANCE', 'Trial Balance'],
    ['trial', 'Trial Balance'],
    ['tri bal', 'Trial Balance'],
    ['trb', 'Trial Balance'], // scattered letters
    ['tb', 'Trial Balance'],
    ['trail balance', 'Trial Balance'], // a typo (transposed letters)
    ['triel balance', 'Trial Balance'],
    ['daybook', 'Day Book'], // missing space
    ['day', 'Day Book'],
    ['sales', 'New Sales Voucher'],
    ['new sal', 'New Sales Voucher'],
    ['purch', 'New Purchase Voucher'],
    ['cash', 'Cash Book'],
    ['stock sum', 'Stock Summary'],
    ['gst', 'GST Reports'],
    ['keyb', 'Keyboard Shortcuts'],
    ['create led', 'Create Ledger'],
    ['ledger', 'Create Ledger'],
    ['outstnding', 'Outstanding Receivables'], // dropped letter
  ])('%j finds %s first', (query, expected) => {
    expect(rank(query)[0]).toBe(expected);
  });

  it('finds nothing for nonsense', () => {
    expect(rank('zzzqqq')).toEqual([]);
    expect(rank('xylophone')).toEqual([]);
  });

  it('requires EVERY term to match, in any order', () => {
    expect(rank('book day')).toContain('Day Book');
    expect(rank('day zebra')).toEqual([]);
  });

  it('ranks a word-start match above a scattered-letter match', () => {
    const ordered = rank('bo', ['Balance Owing', 'Day Book']); // 'bo' starts the word Book, but is only scattered letters in Balance Owing
    expect(ordered).toEqual(['Day Book', 'Balance Owing']);
  });

  it('ranks a match at the START of the title above one in the middle', () => {
    expect(rank('book', ['Day Book', 'Book Keeping'])[0]).toBe('Book Keeping');
  });

  it('ranks an exact title as a perfect score', () => {
    expect(fuzzyMatch('day book', 'Day Book')?.score).toBeGreaterThan(0.9);
    expect(fuzzyMatch('Cash', 'Cash')?.score).toBe(1);
  });

  it('ignores case and accents', () => {
    expect(fuzzyMatch('cafe', 'Café Expenses')).toBeDefined();
    expect(fuzzyMatch('CAFÉ', 'cafe expenses')).toBeDefined();
    expect(normalize('Café')).toBe('cafe');
  });

  it('matches through weaker fields (keywords, category), but ranks them below a title match', () => {
    const viaKeyword = fuzzyMatch('ledger', 'Party Master', ['Create', 'ledger', 'account']);
    const viaTitle = fuzzyMatch('ledger', 'Create Ledger', ['Create']);
    expect(viaKeyword).toBeDefined();
    expect((viaTitle?.score ?? 0)).toBeGreaterThan(viaKeyword?.score ?? 1);
  });

  it('ignores punctuation-only terms, so typing a title that contains "&" still finds it', () => {
    expect(fuzzyMatch('profit & loss', 'Profit & Loss')?.score).toBeGreaterThan(0.8);
    expect(fuzzyMatch('profit & loss', 'Profit and Loss')).toBeDefined();
    expect(fuzzyMatch('&', 'Profit & Loss')).toBeUndefined(); // punctuation alone is not a query
    expect(fuzzyMatch('p&l', 'Profit & Loss', ['p&l'])).toBeDefined();
  });

  it('scattered letters are for abbreviations only — a long term does not match by accident', () => {
    expect(fuzzyMatch('create', 'Outstanding Receivables & Payables')).toBeUndefined();
    expect(fuzzyMatch('outstanding', 'Create Stock Item')).toBeUndefined();
    expect(fuzzyMatch('trb', 'Trial Balance')).toBeDefined(); // a real abbreviation still works
    expect(fuzzyMatch('rb', 'Trial Balance')).toBeUndefined(); // …but must start at the front of a word
  });

  it('returns nothing for an empty query', () => {
    expect(fuzzyMatch('', 'Day Book')).toBeUndefined();
    expect(fuzzyMatch('   ', 'Day Book')).toBeUndefined();
  });

  it('stays within 0..1', () => {
    for (const q of ['t', 'trial', 'trial balance', 'balance trial', 'a']) {
      for (const t of TITLES) {
        const s = fuzzyMatch(q, t)?.score;
        if (s !== undefined) expect(s).toBeGreaterThan(0);
        if (s !== undefined) expect(s).toBeLessThanOrEqual(1);
      }
    }
  });

  it('a single-letter query matches without exploding', () => {
    expect(rank('t').length).toBeGreaterThan(0);
  });
});

describe('fuzzyMatch: highlight ranges', () => {
  it('marks the matched prefix of a word', () => {
    expect(fuzzyMatch('trial', 'Trial Balance')?.ranges).toEqual([[0, 5]]);
  });

  it('marks each matched word', () => {
    expect(fuzzyMatch('tri bal', 'Trial Balance')?.ranges).toEqual([[0, 3], [6, 9]]);
  });

  it('marks scattered letters individually, merging neighbours', () => {
    expect(fuzzyMatch('trb', 'Trial Balance')?.ranges).toEqual([[0, 2], [6, 7]]);
  });

  it('gives no ranges when there is no clean location (e.g. matched through a keyword)', () => {
    expect(fuzzyMatch('ledger', 'Party Master', ['ledger'])?.ranges).toEqual([]);
  });

  it('every range lies inside the title', () => {
    for (const q of ['trb', 'day', 'sal vou', 'balance']) {
      for (const t of TITLES) {
        for (const [s, e] of fuzzyMatch(q, t)?.ranges ?? []) {
          expect(s).toBeGreaterThanOrEqual(0);
          expect(e).toBeLessThanOrEqual(t.length);
          expect(s).toBeLessThan(e);
        }
      }
    }
  });
});

describe('highlightSegments', () => {
  it('splits text around ranges', () => {
    expect(highlightSegments('Trial Balance', [[0, 3], [6, 9]])).toEqual([
      { text: 'Tri', match: true }, { text: 'al ', match: false }, { text: 'Bal', match: true }, { text: 'ance', match: false },
    ]);
  });

  it('returns the whole text when there is nothing to highlight', () => {
    expect(highlightSegments('Day Book', [])).toEqual([{ text: 'Day Book', match: false }]);
    expect(highlightSegments('Day Book')).toEqual([{ text: 'Day Book', match: false }]);
  });

  it('merges overlapping ranges', () => {
    expect(highlightSegments('abcdef', [[0, 3], [2, 5]])).toEqual([{ text: 'abcde', match: true }, { text: 'f', match: false }]);
  });

  it('covering everything yields one highlighted segment', () => {
    expect(highlightSegments('Cash', [[0, 4]])).toEqual([{ text: 'Cash', match: true }]);
  });
});

describe('editDistance', () => {
  it.each([
    ['', '', 0], ['abc', 'abc', 0], ['abc', 'abd', 1], ['abc', 'abcd', 1], ['abc', 'ab', 1],
    ['trial', 'trail', 1], // a transposition counts as ONE edit
    ['kitten', 'sitting', 3], ['', 'abc', 3], ['abc', '', 3],
  ])('%j vs %j = %d', (a, b, d) => {
    expect(editDistance(a, b)).toBe(d);
    expect(editDistance(b, a)).toBe(d);
  });
});
