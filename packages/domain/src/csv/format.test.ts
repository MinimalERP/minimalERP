import { describe, expect, it } from 'vitest';
import { csvOf, parseCsv, parseCsvRecords } from './format';

describe('csvOf', () => {
  it('quotes only a cell that needs it, doubling any quote inside', () => {
    expect(csvOf([['a', 'b,c', 'has "quote"', 'plain']])).toBe('a,"b,c","has ""quote""",plain');
  });
  it('joins rows with a newline', () => {
    expect(csvOf([['a', 'b'], ['c', 'd']])).toBe('a,b\nc,d');
  });
});

describe('parseCsv', () => {
  it('splits plain rows on commas and newlines', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });
  it('does not produce an extra empty row for a trailing newline', () => {
    expect(parseCsv('a,b\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });
  it('reads a quoted field with an embedded comma and newline, and a doubled quote as a literal one', () => {
    expect(parseCsv('a,"b,c\nstill b","has ""quote"""\nd,e,f')).toEqual([
      ['a', 'b,c\nstill b', 'has "quote"'],
      ['d', 'e', 'f'],
    ]);
  });
  it('handles CRLF line endings the same as LF', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });
  it('round-trips through csvOf', () => {
    const rows = [['a', 'b,c', 'has "quote"\nand a newline'], ['1', '2', '3']];
    expect(parseCsv(csvOf(rows))).toEqual(rows);
  });
});

describe('parseCsvRecords', () => {
  it('keys each row by the header row, trimmed', () => {
    expect(parseCsvRecords(' Name , Qty \nBolt,5\nSheet,10')).toEqual([
      { Name: 'Bolt', Qty: '5' },
      { Name: 'Sheet', Qty: '10' },
    ]);
  });
  it('a short row reads "" for its missing columns', () => {
    expect(parseCsvRecords('a,b,c\n1')).toEqual([{ a: '1', b: '', c: '' }]);
  });
});
