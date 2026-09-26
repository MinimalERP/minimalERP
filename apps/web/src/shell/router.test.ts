import { ScreenStack } from '@minimalerp/command';
import { describe, expect, it, vi } from 'vitest';
import { GATEWAY, type BackWindow, type RouterWindow, type ScreenRef, bindBackButton, bindRouter, hashToRef, refToHash, sameScreen } from './router';

const REFS: ScreenRef[] = [
  GATEWAY,
  { type: 'menu', id: 'masters' },
  { type: 'planned', id: 'report.trialBalance' },
  { type: 'planned', id: 'weird id/with?chars&more' },
  { type: 'settings-keyboard' },
];

describe('refToHash / hashToRef', () => {
  it.each(REFS.map((r) => [refToHash(r), r] as const))('%s round-trips', (hash, ref) => {
    expect(hashToRef(hash)).toEqual(ref);
  });

  it('writes readable addresses', () => {
    expect(refToHash(GATEWAY)).toBe('#/gateway');
    expect(refToHash({ type: 'menu', id: 'masters' })).toBe('#/menu/masters');
    expect(refToHash({ type: 'planned', id: 'report.trialBalance' })).toBe('#/planned/report.trialBalance');
    expect(refToHash({ type: 'settings-keyboard' })).toBe('#/settings/keyboard');
  });

  it('a voucher list has its own address, by voucher kind', () => {
    expect(refToHash({ type: 'report', report: 'vouchers', kind: 'sales' })).toBe('#/report/vouchers/sales');
    expect(hashToRef('#/report/vouchers/salesOrder')).toEqual({ type: 'report', report: 'vouchers', kind: 'salesOrder' });
    expect(hashToRef('#/report/vouchers')).toBeUndefined(); // a list needs its kind
  });

  it('the purchase order register has an address, for everything or for one item', () => {
    expect(refToHash({ type: 'report', report: 'purchase-orders' })).toBe('#/report/purchase-orders');
    expect(hashToRef('#/report/purchase-orders')).toEqual({ type: 'report', report: 'purchase-orders' });
    expect(refToHash({ type: 'report', report: 'purchase-orders', itemId: 'i 1' })).toBe('#/report/purchase-orders/i%201');
    expect(hashToRef('#/report/purchase-orders/i%201')).toEqual({ type: 'report', report: 'purchase-orders', itemId: 'i 1' });
    expect(refToHash({ type: 'report', report: 'vouchers', kind: 'purchaseOrder' })).toBe('#/report/vouchers/purchaseOrder');
    expect(hashToRef('#/report/vouchers/purchase')).toEqual({ type: 'report', report: 'vouchers', kind: 'purchase' });
  });

  it('the books have addresses: statements, groups of the Trial Balance, the cash and bank books, outstanding by side and party', () => {
    const cases = [
      [{ type: 'report', report: 'trial-balance' }, '#/report/trial-balance'],
      [{ type: 'report', report: 'trial-balance', groupId: 'g 1' }, '#/report/trial-balance/g%201'],
      [{ type: 'report', report: 'profit-loss' }, '#/report/profit-loss'],
      [{ type: 'report', report: 'balance-sheet' }, '#/report/balance-sheet'],
      [{ type: 'report', report: 'book', kind: 'cash' }, '#/report/book/cash'],
      [{ type: 'report', report: 'outstanding', kind: 'receivable' }, '#/report/outstanding/receivable'],
      [{ type: 'report', report: 'outstanding', kind: 'payable', ledgerId: 'l1' }, '#/report/outstanding/payable/l1'],
    ] as const;
    for (const [ref, hash] of cases) {
      expect(refToHash(ref as never)).toBe(hash);
      expect(hashToRef(hash)).toEqual(ref);
    }
    expect(hashToRef('#/report/book')).toBeUndefined(); // a book needs cash or bank
    expect(hashToRef('#/report/book/other')).toBeUndefined();
    expect(hashToRef('#/report/outstanding')).toBeUndefined(); // and outstanding a side
    expect(hashToRef('#/report/outstanding/sideways')).toBeUndefined();
  });

  it('the GST reports have addresses, with the month in the address when one is chosen', () => {
    const cases = [
      [{ type: 'report', report: 'gstr1' }, '#/report/gstr1'],
      [{ type: 'report', report: 'gstr1', kind: '2026-04' }, '#/report/gstr1/2026-04'],
      [{ type: 'report', report: 'gstr3b', kind: '2027-01' }, '#/report/gstr3b/2027-01'],
      [{ type: 'report', report: 'gst-purchases', kind: '2026-09' }, '#/report/gst-purchases/2026-09'],
    ] as const;
    for (const [ref, hash] of cases) {
      expect(refToHash(ref as never)).toBe(hash);
      expect(hashToRef(hash)).toEqual(ref);
    }
    expect(hashToRef('#/report/gstr3b')).toEqual({ type: 'report', report: 'gstr3b' });
    expect(hashToRef('#/report/gstr1/2026-13')).toBeUndefined(); // not a month
    expect(hashToRef('#/report/gstr1/soon')).toBeUndefined();
  });

  it.each(['', '#', '#/', '/', '#/gateway'])('%j means the Gateway', (h) => {
    expect(hashToRef(h)).toEqual(GATEWAY);
  });

  it.each(['#/nonsense', '#/menu/', '#/planned', '#/settings/other', '#/menu/%E0%A4%A'])('%j is not a screen', (h) => {
    expect(hashToRef(h)).toBeUndefined();
  });

  it('compares screens by address', () => {
    expect(sameScreen({ type: 'menu', id: 'a' }, { type: 'menu', id: 'a' })).toBe(true);
    expect(sameScreen({ type: 'menu', id: 'a' }, { type: 'planned', id: 'a' })).toBe(false);
  });
});

function fakeWindow(initialHash = '') {
  let hash = initialHash;
  let onHash: (() => void) | undefined;
  const replaceState = vi.fn((_d: unknown, _u: string, url?: string | null) => {
    if (typeof url === 'string') hash = url;
  });
  const win: RouterWindow = {
    location: { get hash() { return hash; }, set hash(v: string) { hash = v; } },
    history: { replaceState },
    addEventListener: (_t, l) => { onHash = l; },
    removeEventListener: () => { onHash = undefined; },
  };
  return { win, replaceState, editAddress: (h: string) => { hash = h; onHash?.(); }, hasListener: () => onHash !== undefined };
}

describe('bindRouter', () => {
  it('starts at the Gateway with a clean address', () => {
    const w = fakeWindow();
    const screens = new ScreenStack<ScreenRef>(GATEWAY);
    bindRouter(screens, w.win);
    expect(w.win.location.hash).toBe('#/gateway');
    expect(screens.depth).toBe(1);
  });

  it('opening a screen from an address puts the Gateway beneath it, so Esc has somewhere to go', () => {
    const w = fakeWindow('#/planned/report.trialBalance');
    const screens = new ScreenStack<ScreenRef>(GATEWAY);
    bindRouter(screens, w.win);
    expect(screens.all.map((f) => f.screen)).toEqual([GATEWAY, { type: 'planned', id: 'report.trialBalance' }]);
    expect(screens.pop()).toBe(true);
    expect(w.win.location.hash).toBe('#/gateway');
  });

  it('an unrecognised address is ignored, and replaced with the real one', () => {
    const w = fakeWindow('#/garbage');
    const screens = new ScreenStack<ScreenRef>(GATEWAY);
    bindRouter(screens, w.win);
    expect(screens.depth).toBe(1);
    expect(w.win.location.hash).toBe('#/gateway');
  });

  it('the address follows the top screen as the user navigates', () => {
    const w = fakeWindow();
    const screens = new ScreenStack<ScreenRef>(GATEWAY);
    bindRouter(screens, w.win);
    screens.push({ type: 'menu', id: 'masters' });
    expect(w.win.location.hash).toBe('#/menu/masters');
    screens.push({ type: 'settings-keyboard' });
    expect(w.win.location.hash).toBe('#/settings/keyboard');
    screens.pop();
    expect(w.win.location.hash).toBe('#/menu/masters');
  });

  it('never adds browser history entries (Esc is "back"); it only rewrites the current one', () => {
    const w = fakeWindow();
    const screens = new ScreenStack<ScreenRef>(GATEWAY);
    bindRouter(screens, w.win);
    screens.push({ type: 'menu', id: 'a' });
    screens.push({ type: 'menu', id: 'b' });
    expect(w.replaceState).toHaveBeenCalled();
  });

  it('does not rewrite an address that is already right', () => {
    const w = fakeWindow('#/gateway');
    const screens = new ScreenStack<ScreenRef>(GATEWAY);
    bindRouter(screens, w.win);
    expect(w.replaceState).not.toHaveBeenCalled();
  });

  it('follows the address when it is edited by hand', () => {
    const w = fakeWindow();
    const screens = new ScreenStack<ScreenRef>(GATEWAY);
    bindRouter(screens, w.win);
    w.editAddress('#/menu/reports');
    expect(screens.top.screen).toEqual({ type: 'menu', id: 'reports' });
    expect(screens.depth).toBe(2);
    w.editAddress('#/gateway');
    expect(screens.depth).toBe(1);
  });

  it('ignores an address change it caused itself (no feedback loop)', () => {
    const w = fakeWindow();
    const screens = new ScreenStack<ScreenRef>(GATEWAY);
    bindRouter(screens, w.win);
    screens.push({ type: 'menu', id: 'masters' });
    const before = screens.top.id;
    w.editAddress('#/menu/masters'); // same as the top: nothing to do
    expect(screens.top.id).toBe(before);
  });

  it('stops listening when unbound', () => {
    const w = fakeWindow();
    const unbind = bindRouter(new ScreenStack<ScreenRef>(GATEWAY), w.win);
    expect(w.hasListener()).toBe(true);
    unbind();
    expect(w.hasListener()).toBe(false);
  });
});

describe('master addresses', () => {
  it.each([
    [{ type: 'company-new' }, '#/company/new'],
    [{ type: 'company-reset' }, '#/company/reset'],
    [{ type: 'master-list', kind: 'ledger' }, '#/masters/ledger'],
    [{ type: 'master', kind: 'party', mode: 'create' }, '#/master/party/create'],
    [{ type: 'master', kind: 'stockItem', mode: 'alter', id: 'a b/c' }, '#/master/stockItem/alter/a%20b%2Fc'],
    [{ type: 'master', kind: 'ledger', mode: 'display', id: 'abc' }, '#/master/ledger/display/abc'],
  ] as const)('%j <-> %s', (ref, hash) => {
    expect(refToHash(ref as never)).toBe(hash);
    expect(hashToRef(hash)).toEqual(ref);
  });

  it('what is not part of the address (a pre-filled name, "hand the result back") is not in it', () => {
    expect(refToHash({ type: 'master', kind: 'unit', mode: 'create', seed: { symbol: 'Kg' }, inline: true })).toBe('#/master/unit/create');
  });

  it.each(['#/master/spaceship/create', '#/master/ledger/alter', '#/master/ledger/bogus/1', '#/masters/spaceship', '#/master/ledger/alter/%E0%A4%A'])(
    'refuses the nonsense address %s',
    (hash) => expect(hashToRef(hash)).toBeUndefined(),
  );
});

/** A browser history of entries with the address on the top one; Back pops it and tells the listener (as popstate does). */
function fakeHistory(hash = '#/gateway') {
  const entries = [hash];
  let onPop: (() => void) | undefined;
  let left = false;
  const win: BackWindow = {
    location: { get hash() { return entries.at(-1) as string; }, set hash(v: string) { entries[entries.length - 1] = v; } },
    history: {
      pushState: (_d, _u, url) => void entries.push(url ?? (entries.at(-1) as string)),
      replaceState: (_d, _u, url) => void (entries[entries.length - 1] = url ?? (entries.at(-1) as string)),
      back: () => {
        if (entries.length === 1) left = true;
        else entries.pop();
        onPop?.();
      },
    },
    addEventListener: (_t, l) => { onPop = l; },
    removeEventListener: () => { onPop = undefined; },
  };
  return { win, entries, back: () => win.history.back(), left: () => left };
}

describe('bindBackButton — the phone\'s Back is Esc inside the app; only the Gateway lets it leave', () => {
  const setup = () => {
    const screens = new ScreenStack<ScreenRef>(GATEWAY);
    const h = fakeHistory();
    let modal = false;
    const esc = vi.fn(() => void screens.pop()); // what Esc does on a plain screen: back one
    bindBackButton(screens, () => modal, () => () => {}, h.win, esc);
    return { screens, h, esc, setModal: (m: boolean) => (modal = m) };
  };

  it('on the Gateway nothing is added: Back leaves', () => {
    const { h, esc } = setup();
    expect(h.entries).toHaveLength(1);
    h.back();
    expect(h.left()).toBe(true);
    expect(esc).not.toHaveBeenCalled();
  });

  it('from a screen, Back presses Esc and stays; from the Gateway reached that way, the next Back leaves', () => {
    const { screens, h, esc } = setup();
    screens.push({ type: 'menu', id: 'masters' });
    screens.push({ type: 'planned', id: 'report.trialBalance' });
    h.back();
    expect(esc).toHaveBeenCalledTimes(1);
    expect(h.left()).toBe(false);
    expect(screens.top.screen).toEqual({ type: 'menu', id: 'masters' });
    h.back();
    expect(esc).toHaveBeenCalledTimes(2);
    expect(screens.depth).toBe(1);
    h.back();
    expect(h.left()).toBe(true);
    expect(esc).toHaveBeenCalledTimes(2);
  });

  it('Esc pressed by hand back to the Gateway takes the spare entry away too, so Back there leaves at once', () => {
    const { screens, h } = setup();
    screens.push({ type: 'menu', id: 'masters' });
    expect(h.entries).toHaveLength(2);
    screens.pop();
    expect(h.entries).toHaveLength(1);
    h.back();
    expect(h.left()).toBe(true);
  });

  it('when Esc does not leave the screen (it stepped back a field), Back keeps working', () => {
    const { screens, h, esc } = setup();
    screens.push({ type: 'menu', id: 'masters' });
    esc.mockImplementationOnce(() => {});
    h.back();
    expect(screens.depth).toBe(2);
    expect(h.entries).toHaveLength(2); // a new spare is laid
    h.back();
    expect(screens.depth).toBe(1);
  });
});

describe('bindBackButton with a warning on the Gateway (phones)', () => {
  it('the first Back only warns; a second within the time leaves; after the time, a Back warns again', () => {
    vi.useFakeTimers();
    try {
      const screens = new ScreenStack<ScreenRef>(GATEWAY);
      const h = fakeHistory();
      const say = vi.fn();
      const esc = vi.fn(() => void screens.pop());
      bindBackButton(screens, () => false, () => () => {}, h.win, esc, { say, ms: 2000 });
      h.back();
      expect(say).toHaveBeenCalledTimes(1);
      expect(h.left()).toBe(false);
      vi.advanceTimersByTime(2500);
      h.back();
      expect(say).toHaveBeenCalledTimes(2);
      expect(h.left()).toBe(false);
      h.back();
      expect(h.left()).toBe(true);
      expect(esc).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('inside the app Back is still Esc, and coming home keeps the Gateway guarded', () => {
    const screens = new ScreenStack<ScreenRef>(GATEWAY);
    const h = fakeHistory();
    const say = vi.fn();
    const esc = vi.fn(() => void screens.pop());
    bindBackButton(screens, () => false, () => () => {}, h.win, esc, { say, ms: 2000 });
    screens.push({ type: 'menu', id: 'masters' });
    h.back();
    expect(esc).toHaveBeenCalledTimes(1);
    expect(screens.depth).toBe(1);
    h.back();
    expect(say).toHaveBeenCalledTimes(1);
    expect(h.left()).toBe(false);
  });
});
