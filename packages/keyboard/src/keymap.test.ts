import { describe, expect, it } from 'vitest';
import type { Chord } from './chord';
import { type BindingSpec, Keymap } from './keymap';

const c = (s: string) => s as Chord;
const defaults: BindingSpec[] = [
  { commandId: 'goto.open', chord: 'Alt+G' },
  { commandId: 'voucher.new.sales', chord: 'F8' },
  { commandId: 'voucher.switch.sales', chord: 'F8', scope: 'screen:voucher' },
  { commandId: 'app.back', chord: 'Esc' },
  { commandId: 'voucher.accept', chord: 'Ctrl+A', scope: 'screen:voucher' },
];

describe('Keymap.build / bindingsFor', () => {
  const { keymap, problems } = Keymap.build(defaults);

  it('builds without problems from valid defaults', () => {
    expect(problems).toEqual([]);
  });

  it('resolves an unscoped binding everywhere', () => {
    expect(keymap.bindingsFor(c('Alt+G'), []).map((b) => b.commandId)).toEqual(['goto.open']);
    expect(keymap.bindingsFor(c('Alt+G'), ['screen:menu', 'global']).map((b) => b.commandId)).toEqual(['goto.open']);
  });

  it('the same key means different things in different scopes — the scoped meaning comes FIRST', () => {
    expect(keymap.bindingsFor(c('F8'), ['screen:menu']).map((b) => b.commandId)).toEqual(['voucher.new.sales']);
    expect(keymap.bindingsFor(c('F8'), ['screen:voucher', 'global']).map((b) => b.commandId)).toEqual([
      'voucher.switch.sales', // inside a voucher: switch type
      'voucher.new.sales', // …and the global meaning remains as a fallback
    ]);
  });

  it('a scoped binding is invisible outside its scope', () => {
    expect(keymap.bindingsFor(c('Ctrl+A'), ['screen:menu'])).toEqual([]);
    expect(keymap.bindingsFor(c('Ctrl+A'), ['screen:voucher']).map((b) => b.commandId)).toEqual(['voucher.accept']);
  });

  it('orders nested scopes innermost first', () => {
    const { keymap: k } = Keymap.build([
      { commandId: 'outer', chord: 'F2', scope: 'screen:x' },
      { commandId: 'inner', chord: 'F2', scope: 'region:grid' },
    ]);
    expect(k.bindingsFor(c('F2'), ['region:grid', 'screen:x']).map((b) => b.commandId)).toEqual(['inner', 'outer']);
  });

  it('knows nothing about chords nobody bound', () => {
    expect(keymap.bindingsFor(c('F9'), ['screen:menu'])).toEqual([]);
  });

  it('answers the reverse question: which chords does a command have?', () => {
    expect(keymap.chordsFor('goto.open')).toEqual(['Alt+G']);
    expect(keymap.chordsFor('nothing')).toEqual([]);
    expect(keymap.scopeOf('voucher.accept')).toBe('screen:voucher');
    expect(keymap.scopeOf('goto.open')).toBeUndefined();
  });

  it('normalises chord text in defaults', () => {
    const { keymap: k } = Keymap.build([{ commandId: 'x', chord: 'alt+g' }]);
    expect(k.chordsFor('x')).toEqual(['Alt+G']);
  });
});

describe('overrides', () => {
  it('REPLACE a command’s defaults', () => {
    const { keymap } = Keymap.build(defaults, { 'goto.open': ['Alt+J'] });
    expect(keymap.chordsFor('goto.open')).toEqual(['Alt+J']);
    expect(keymap.bindingsFor(c('Alt+G'), [])).toEqual([]);
    expect(keymap.bindingsFor(c('Alt+J'), []).map((b) => [b.commandId, b.source])).toEqual([['goto.open', 'user']]);
    expect(keymap.defaultChordsFor('goto.open')).toEqual(['Alt+G']); // defaults remain knowable
  });

  it('an empty list unbinds the command', () => {
    const { keymap } = Keymap.build(defaults, { 'goto.open': [] });
    expect(keymap.chordsFor('goto.open')).toEqual([]);
    expect(keymap.bindingsFor(c('Alt+G'), [])).toEqual([]);
  });

  it('keep the scope of the command’s default binding', () => {
    const { keymap } = Keymap.build(defaults, { 'voucher.accept': ['Ctrl+S'] });
    expect(keymap.bindingsFor(c('Ctrl+S'), ['screen:voucher']).map((b) => b.commandId)).toEqual(['voucher.accept']);
    expect(keymap.bindingsFor(c('Ctrl+S'), ['screen:menu'])).toEqual([]);
  });

  it('can give a command with no default a shortcut', () => {
    const { keymap } = Keymap.build(defaults, { 'report.trialBalance': ['Alt+T'] });
    expect(keymap.chordsFor('report.trialBalance')).toEqual(['Alt+T']);
  });
});

describe('problems', () => {
  it('reports two commands on one chord in one scope, and the user’s choice wins', () => {
    const { keymap, problems } = Keymap.build(defaults, { 'voucher.new.sales': ['Alt+G'] });
    expect(problems).toEqual([{ kind: 'conflict', chord: 'Alt+G', scope: undefined, commands: ['goto.open', 'voucher.new.sales'], winner: 'voucher.new.sales' }]);
    expect(keymap.bindingsFor(c('Alt+G'), []).map((b) => b.commandId)).toEqual(['voucher.new.sales']);
  });

  it('between two defaults, the first declared wins', () => {
    const { keymap, problems } = Keymap.build([
      { commandId: 'a', chord: 'F3' },
      { commandId: 'b', chord: 'F3' },
    ]);
    expect(problems[0]).toMatchObject({ kind: 'conflict', winner: 'a' });
    expect(keymap.bindingsFor(c('F3'), []).map((b) => b.commandId)).toEqual(['a']);
  });

  it('same chord in DIFFERENT scopes is not a conflict — that is how F8 works', () => {
    expect(Keymap.build(defaults).problems).toEqual([]);
  });

  it('refuses garbage chords and plain typing keys, and says why', () => {
    const { keymap, problems } = Keymap.build([
      { commandId: 'a', chord: 'bogus' },
      { commandId: 'b', chord: 'x' },
      { commandId: 'c', chord: 'Shift+Q' },
      { commandId: 'd', chord: 'F4' },
    ]);
    const invalid = problems.filter((p) => p.kind === 'invalid-chord');
    expect(invalid.map((p) => p.commandId)).toEqual(['a', 'b', 'c']);
    expect(invalid[1]?.reason).toMatch(/typed/);
    expect(keymap.all().map((b) => b.commandId)).toEqual(['d']);
  });
});
