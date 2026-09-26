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

/**
 * A browser history with Chrome's rule: entries a page pushes with no tap since it loaded or since the last Back are all skipped by Back
 * (so Back leaves the app), until the person taps again. `tap()` is a touch on the screen; `back()` the phone's Back.
 */
function fakeHistory() {
  const entries: { hash: string; state: unknown; skip: boolean }[] = [{ hash: '#/gateway', state: null, skip: false }];
  let at = 0;
  let tapped = false;
  let left = false;
  const listeners: Record<string, ((e: Event) => void)[]> = {};
  const fire = (type: string, e: Event = { isTrusted: true } as Event) => (listeners[type] ?? []).forEach((l) => l(e));
  const win: BackWindow = {
    location: { get hash() { return (entries[at] as { hash: string }).hash; }, set hash(v: string) { (entries[at] as { hash: string }).hash = v; } },
    history: {
      get state() { return (entries[at] as { state: unknown }).state; },
      pushState: (state, _u, url) => {
        entries.splice(at + 1);
        entries.push({ hash: url ?? (entries[at] as { hash: string }).hash, state, skip: false });
        at++;
        if (!tapped) entries.forEach((e) => (e.skip = true));
      },
      replaceState: (state, _u, url) => void Object.assign(entries[at] as object, { state, hash: url ?? (entries[at] as { hash: string }).hash }),
      go: (delta) => {
        at = Math.max(0, at + delta);
        fire('popstate');
      },
    },
    addEventListener: (t, l) => void (listeners[t] ??= []).push(l),
    removeEventListener: (t, l) => void (listeners[t] = (listeners[t] ?? []).filter((x) => x !== l)),
  };
  return {
    win,
    entries,
    tap: async () => {
      tapped = true;
      entries.forEach((e) => (e.skip = false));
      fire('pointerdown');
      await Promise.resolve(); // the sync after a tap runs as a microtask
    },
    back: () => {
      let to = at - 1;
      while (to >= 0 && (entries[to] as { skip: boolean }).skip) to--;
      if (to < 0) { left = true; return; }
      at = to;
      tapped = false;
      fire('popstate');
    },
    left: () => left,
  };
}

describe('bindBackButton — the phone\'s Back is Esc inside the app; only the Gateway lets it leave', () => {
  const setup = (withAsk = false) => {
    const screens = new ScreenStack<ScreenRef>(GATEWAY);
    const h = fakeHistory();
    const esc = vi.fn(() => void screens.pop()); // what Esc does on a plain screen: back one
    const ask = vi.fn();
    bindBackButton(screens, h.win, { isModal: () => false, onScopes: () => () => {}, pressEsc: esc, ...(withAsk ? { onGatewayBack: ask } : {}) });
    return { screens, h, esc, ask };
  };

  it('on the Gateway (desktop) nothing is added: Back leaves', () => {
    const { h, esc } = setup();
    h.back();
    expect(h.left()).toBe(true);
    expect(esc).not.toHaveBeenCalled();
  });

  it('screens opened by taps: Back presses Esc on each, never re-adding an entry after a Back, then leaves from the Gateway', async () => {
    const { screens, h, esc } = setup();
    await h.tap();
    screens.push({ type: 'menu', id: 'masters' });
    await h.tap();
    screens.push({ type: 'planned', id: 'report.trialBalance' });
    h.back();
    expect(screens.top.screen).toEqual({ type: 'menu', id: 'masters' });
    h.back();
    expect(screens.depth).toBe(1);
    expect(esc).toHaveBeenCalledTimes(2);
    expect(h.left()).toBe(false);
    h.back();
    expect(h.left()).toBe(true);
  });

  it('Esc pressed by hand back to the Gateway gives the entries back, so Back there leaves at once', async () => {
    const { screens, h } = setup();
    await h.tap();
    screens.push({ type: 'menu', id: 'masters' });
    screens.pop();
    expect(h.win.history.state).toEqual({ erpBack: 0 });
    h.back();
    expect(h.left()).toBe(true);
  });

  it('a Back that only stepped a field back is made up for at the next tap', async () => {
    const { screens, h, esc } = setup();
    await h.tap();
    screens.push({ type: 'menu', id: 'masters' });
    esc.mockImplementationOnce(() => {});
    h.back();
    expect(screens.depth).toBe(2);
    await h.tap();
    h.back();
    expect(screens.depth).toBe(1);
    expect(h.left()).toBe(false);
  });

  it('on a phone the Gateway asks first: the first Back opens "Exit?", the next leaves; a tap (Stay) guards it again', async () => {
    const { h, ask } = setup(true);
    await h.tap();
    h.back();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(h.left()).toBe(false);
    await h.tap(); // Stay
    h.back();
    expect(ask).toHaveBeenCalledTimes(2);
    h.back();
    expect(h.left()).toBe(true);
  });
});
