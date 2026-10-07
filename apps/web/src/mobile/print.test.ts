import { describe, expect, it } from 'vitest';
import { COPY_LABELS } from '../ui/printCoordinator';
import { COPY_CHOICES, bytesOfBase64, copiesSummary, copyLabelsOf, pdfNameOf, rememberCopies, rememberedCopies, shareWayOf } from './print';

function memory(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const kept = new Map<string, string>();
  return { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) };
}

describe('printing from the phone: which copies', () => {
  it('offers the desktop’s own choices, each printing the desktop’s labels', () => {
    expect(COPY_CHOICES.map((c) => c.value)).toEqual(['1', '2', '3', '4', 'duplicate', 'triplicate', 'extra']);
    for (const c of COPY_CHOICES) expect(copyLabelsOf(c.value)).toBe(COPY_LABELS[c.value]);
    expect(copyLabelsOf('3')).toEqual(['ORIGINAL', 'DUPLICATE', 'TRIPLICATE']);
    expect(copyLabelsOf('triplicate')).toEqual(['TRIPLICATE']);
    expect(copyLabelsOf('nonsense')).toEqual(['ORIGINAL']);
    expect(copiesSummary('2')).toBe('Original, Duplicate');
  });

  it('starts at one Original, then at what this phone printed last; a value it does not know is ignored', () => {
    const storage = memory();
    expect(rememberedCopies(storage)).toBe('1');
    rememberCopies(storage, '3');
    expect(rememberedCopies(storage)).toBe('3');
    rememberCopies(storage, 'seventeen');
    expect(rememberedCopies(storage)).toBe('3');
    storage.setItem('minimalerp.mobile.copies', 'seventeen');
    expect(rememberedCopies(storage)).toBe('1');
    // storage switched off: still one Original, and nothing throws
    expect(rememberedCopies(undefined)).toBe('1');
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(rememberedCopies(broken)).toBe('1');
    expect(() => rememberCopies(broken, '2')).not.toThrow();
  });

  it('names the PDF after the voucher, and knows how this device can send it', () => {
    expect(pdfNameOf('INV/26-27/0001')).toBe('INV-26-27-0001.pdf');
    expect(shareWayOf({ inApp: true, appShares: true, browserShares: false })).toBe('app');
    expect(shareWayOf({ inApp: true, appShares: false, browserShares: true })).toBe('update'); // an app build from before sharing
    expect(shareWayOf({ inApp: false, appShares: false, browserShares: true })).toBe('browser');
    expect(shareWayOf({ inApp: false, appShares: false, browserShares: false })).toBeUndefined();
    expect([...bytesOfBase64(btoa('%PDF'))]).toEqual([37, 80, 68, 70]);
  });
});
