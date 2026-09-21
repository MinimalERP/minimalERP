import { describe, expect, it } from 'vitest';
import { chooseLocalBooks, chooseOnlineBooks, prefersLocalBooks } from './mode';

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};

describe('which books this browser uses', () => {
  it('is the online books until someone chooses otherwise', () => {
    expect(prefersLocalBooks(memoryStorage())).toBe(false);
  });

  it('remembers the choice to keep books in this browser, and forgets it on signing in', () => {
    const s = memoryStorage();
    chooseLocalBooks(s);
    expect(prefersLocalBooks(s)).toBe(true);
    chooseOnlineBooks(s);
    expect(prefersLocalBooks(s)).toBe(false);
  });

  it('cannot be tricked by some other stored value', () => {
    const s = memoryStorage();
    s.setItem('minimalerp.mode', 'online');
    expect(prefersLocalBooks(s)).toBe(false);
  });

  it('copes with no storage, and with storage that throws (blocked, private windows): the answer is "online", nothing crashes', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    for (const s of [undefined, throwing]) {
      expect(prefersLocalBooks(s)).toBe(false);
      expect(() => chooseLocalBooks(s)).not.toThrow();
      expect(() => chooseOnlineBooks(s)).not.toThrow();
    }
  });
});
