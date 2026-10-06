import { describe, expect, it } from 'vitest';
import { UI_KEY, chosenUi, isPhone, pickUi, uiFromSearch } from './device';

const win = (search: string, phone: boolean) => ({
  location: { search },
  matchMedia: (q: string) => ({ matches: q.includes('max-width') ? phone : phone }),
});
const storage = (initial?: string) => {
  const data = new Map<string, string>(initial ? [[UI_KEY, initial]] : []);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe('which interface a device gets', () => {
  it('the address wins, then the saved choice, then the device, then desktop', () => {
    expect(pickUi({ fromAddress: 'desktop', saved: 'mobile', phone: true })).toBe('desktop');
    expect(pickUi({ fromAddress: 'mobile', saved: 'desktop', phone: false })).toBe('mobile');
    expect(pickUi({ saved: 'desktop', phone: true })).toBe('desktop');
    expect(pickUi({ saved: 'mobile', phone: false })).toBe('mobile');
    expect(pickUi({ phone: true })).toBe('mobile');
    expect(pickUi({ phone: false })).toBe('desktop');
  });

  it('reads ?ui= and nothing else', () => {
    expect(uiFromSearch('?ui=mobile')).toBe('mobile');
    expect(uiFromSearch('?x=1&ui=desktop')).toBe('desktop');
    expect(uiFromSearch('?ui=tablet')).toBeUndefined();
    expect(uiFromSearch('')).toBeUndefined();
  });

  it('a phone gets the mobile interface, a desktop the desktop app, with nothing chosen', () => {
    expect(chosenUi(win('', true), storage())).toBe('mobile');
    expect(chosenUi(win('', false), storage())).toBe('desktop');
    expect(isPhone(win('', true))).toBe(true);
  });

  it('a choice in the address is remembered for the next visit', () => {
    const s = storage();
    expect(chosenUi(win('?ui=desktop', true), s)).toBe('desktop');
    expect(s.data.get(UI_KEY)).toBe('desktop');
    expect(chosenUi(win('', true), s)).toBe('desktop'); // the phone keeps the desktop app it asked for
    expect(chosenUi(win('?ui=mobile', true), s)).toBe('mobile'); // until it asks to go back
    expect(chosenUi(win('', true), s)).toBe('mobile');
  });

  it('storage that throws or holds rubbish is ignored: the device decides', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(chosenUi(win('', true), broken)).toBe('mobile');
    expect(chosenUi(win('?ui=desktop', true), broken)).toBe('desktop');
    expect(chosenUi(win('', false), storage('sideways'))).toBe('desktop');
    expect(chosenUi(win('', true), undefined)).toBe('mobile');
  });
});
