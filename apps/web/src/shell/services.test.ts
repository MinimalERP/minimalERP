/**
 * The whole keyboard/command/navigation stack wired together exactly as the app wires it — real
 * modules, real keymap, real registry, real screen stack — driven by simulated key presses.
 * Only the rendering (Preact) is absent; that is covered by the browser tests in e2e/.
 */
import type { Command } from '@minimalerp/command';
import { describe, expect, it } from 'vitest';
import { coreModule } from '../modules/core';
import { mastersModule } from '../modules/masters';
import { reportsModule } from '../modules/reports';
import { vouchersModule } from '../modules/vouchers';
import { PHASES, roadmapModule } from '../modules/roadmap';
import { GATEWAY } from './router';
import { type AppContext, type Services, createServices } from './services';

type Init = { key: string; code: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean };
const keydown = (init: Init) =>
  Object.assign(new Event('keydown', { cancelable: true, bubbles: true }), {
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, ...init,
  });

const K = {
  altG: () => keydown({ key: 'g', code: 'KeyG', altKey: true }),
  altJ: () => keydown({ key: 'j', code: 'KeyJ', altKey: true }),
  altC: () => keydown({ key: 'c', code: 'KeyC', altKey: true }),
  ctrlA: () => keydown({ key: 'a', code: 'KeyA', ctrlKey: true }),
  esc: () => keydown({ key: 'Escape', code: 'Escape' }),
  enter: () => keydown({ key: 'Enter', code: 'Enter' }),
  down: () => keydown({ key: 'ArrowDown', code: 'ArrowDown' }),
  tab: () => keydown({ key: 'Tab', code: 'Tab' }),
  f: (n: number) => keydown({ key: `F${n}`, code: `F${n}` }),
};

function memoryStorage() {
  const data: Record<string, string> = {};
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v), removeItem: (k: string) => void delete data[k] };
}

function boot(storage = memoryStorage()) {
  const target = new EventTarget();
  const services = createServices({ target, storage, modules: [coreModule, roadmapModule, mastersModule, vouchersModule, reportsModule], now: () => 1_700_000_000_000 });
  services.keyboard.start();
  const press = (e: Event) => {
    target.dispatchEvent(e);
    return e;
  };
  return { services, storage, target, press };
}

const top = (s: Services) => s.screens.top.screen;
const titleOfTop = (s: Services) => {
  const ref = top(s);
  if (ref.type === 'voucher' && ref.typeKey) return s.registry.get(`voucher.new.${ref.typeKey}`)?.title; // a real voucher screen (Phase 5)
  return ref.type === 'planned' ? s.registry.get(ref.id)?.title : ref.type;
};

describe('the shipped configuration is internally consistent', () => {
  const { services } = boot();

  it('every default shortcut is valid and conflict-free', () => {
    expect(services.keymapStore.problems).toEqual([]);
  });

  it('every default binding names a command that exists (no typos)', () => {
    for (const b of services.registry.defaultBindings()) {
      expect(services.registry.get(b.commandId), `binding ${b.chord} → ${b.commandId}`).toBeDefined();
    }
  });

  it('every menu entry names a command that exists, in a section that exists', () => {
    const sections = new Set(services.registry.menuSections().map((s) => s.id));
    for (const s of sections) {
      for (const c of services.registry.menu(s)) expect(c, s).toBeDefined();
    }
    const menuIds = services.registry.menuSections().flatMap((s) => services.registry.menu(s.id).map((c) => c.id));
    expect(new Set(menuIds).size).toBe(menuIds.length); // nothing appears in two places
    expect(menuIds.length).toBeGreaterThan(20);
  });

  it('the Gateway lists its sections in order', () => {
    expect(services.registry.menuSections().map((s) => s.id)).toEqual(['masters', 'transactions', 'reports', 'utilities']);
  });

  it('every planned command says which phase delivers it, and that phase is real', () => {
    for (const c of services.registry.all()) {
      const phase = /^Phase (\d+)$/.exec(c.badge ?? '')?.[1];
      if (c.badge) expect(PHASES[Number(phase)], `${c.id} → ${c.badge}`).toBeDefined();
    }
  });

  it('every command has a unique id, a title and a category', () => {
    const ids = services.registry.all().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of services.registry.all()) {
      expect(c.title.length, c.id).toBeGreaterThan(0);
      expect(c.category.length, c.id).toBeGreaterThan(0);
    }
  });

  it('the books are real reports now — the planned placeholders for them are gone, each opens its own screen', () => {
    const { services: s } = boot();
    const opens: [string, unknown][] = [
      ['report.trialBalance', { type: 'report', report: 'trial-balance' }],
      ['report.profitAndLoss', { type: 'report', report: 'profit-loss' }],
      ['report.balanceSheet', { type: 'report', report: 'balance-sheet' }],
      ['report.cashBook', { type: 'report', report: 'book', kind: 'cash' }],
      ['report.bankBook', { type: 'report', report: 'book', kind: 'bank' }],
      ['report.outstanding', { type: 'report', report: 'outstanding', kind: 'receivable' }],
      ['report.payables', { type: 'report', report: 'outstanding', kind: 'payable' }],
    ];
    for (const [id, screen] of opens) {
      expect(s.registry.get(id)?.badge, id).toBeUndefined();
      s.app.goHome();
      expect(s.registry.run(id), id).toBe(true);
      expect(top(s), id).toEqual(screen);
    }
    s.app.goHome();
    expect(s.registry.run('report.groupSummary', { id: 'g-1' })).toBe(true);
    expect(top(s)).toEqual({ type: 'report', report: 'trial-balance', groupId: 'g-1' });
  });

  it('the purchase documents are real: F9 and Shift+F9, their lists in the Purchase group, their order register — and only the debit note is still planned there', () => {
    const { services: s } = boot();
    for (const [id, kind] of [['voucher.new.purchase', 'purchase'], ['voucher.new.purchaseOrder', 'purchaseOrder']] as const) {
      expect(s.registry.get(id)?.badge, id).toBeUndefined();
      s.app.goHome();
      expect(s.registry.run(id), id).toBe(true);
      expect(top(s), id).toEqual({ type: 'voucher', mode: 'create', typeKey: kind });
    }
    expect(s.keymapStore.keymap.chordsFor('voucher.new.purchase')).toEqual(['F9']);
    expect(s.keymapStore.keymap.chordsFor('voucher.new.purchaseOrder')).toEqual(['Shift+F9']);
    const purchase = s.registry.menuItems('transactions').filter((i) => i.group === 'Purchase');
    expect(purchase.map((i) => [i.command.title, i.command.badge])).toEqual([
      ['Purchase Vouchers', undefined],
      ['Purchase Orders', undefined],
      ['New Debit Note', 'Phase 7'],
    ]);
    s.app.goHome();
    expect(s.registry.run('report.purchaseOrders')).toBe(true);
    expect(top(s)).toEqual({ type: 'report', report: 'purchase-orders' });
  });

  it('the Reports menu is grouped: Statements, Books, Outstanding, Inventory & Sales, GST', () => {
    const { services: s } = boot();
    const items = s.registry.menuItems('reports');
    expect([...new Set(items.map((i) => i.group))]).toEqual(['Statements', 'Books', 'Outstanding', 'Inventory & Sales', 'GST']);
  });

  it('every planned command opens the planned screen for itself', () => {
    const { services: s } = boot();
    const planned = s.registry.all().filter((c: Command<AppContext>) => c.badge && c.run);
    // Phases 4–9 made the masters, vouchers, the reports and GST real, so only the credit and debit notes stand in as "planned" now.
    expect(planned.length).toBeGreaterThan(1);
    for (const c of planned) {
      s.app.goHome();
      expect(s.registry.run(c.id), c.id).toBe(true);
      expect(top(s), c.id).toEqual({ type: 'planned', id: c.id });
    }
  });
});

describe('the function keys', () => {
  it.each([
    [4, 'New Contra Voucher'], [5, 'New Payment Voucher'], [6, 'New Receipt Voucher'],
    [7, 'New Journal Voucher'], [8, 'New Sales Voucher'], [9, 'New Purchase Voucher'],
  ])('F%d opens %s from the Gateway', (n, title) => {
    const { services, press } = boot();
    const e = press(K.f(n));
    expect(titleOfTop(services)).toBe(title);
    expect(e.defaultPrevented).toBe(true); // consumed, so the browser does not also act (F5 would reload!)
  });

  it('a held-down F5 opens the voucher once, not once per repeat', () => {
    const { services, press } = boot();
    press(K.f(5));
    const repeat = press(keydown({ key: 'F5', code: 'F5', repeat: true }));
    expect(services.screens.depth).toBe(2);
    expect(repeat.defaultPrevented).toBe(true); // still swallowed: the page must not reload
  });

  it('F2, Ctrl+A and Alt+C are reserved but inert until a voucher screen exists — the browser keeps them', () => {
    const { services, press } = boot();
    for (const e of [K.f(2), K.ctrlA(), K.altC()]) expect(press(e).defaultPrevented).toBe(false);
    expect(services.screens.depth).toBe(1);
  });
});

describe('Esc and navigation', () => {
  it('Esc goes back, and lands on the Gateway', () => {
    const { services, press } = boot();
    press(K.f(8));
    expect(services.screens.depth).toBe(2);
    expect(press(K.esc()).defaultPrevented).toBe(true);
    expect(top(services)).toEqual(GATEWAY);
  });

  it('Esc on the Gateway does nothing and is left alone for the browser', () => {
    const { services, press } = boot();
    expect(press(K.esc()).defaultPrevented).toBe(false);
    expect(services.screens.depth).toBe(1);
  });

  it('Esc unwinds a deep path one screen at a time', () => {
    const { services, press } = boot();
    services.app.navigate({ type: 'menu', id: 'reports' });
    press(K.f(8));
    expect(services.screens.depth).toBe(3);
    press(K.esc());
    expect(top(services)).toEqual({ type: 'menu', id: 'reports' });
    press(K.esc());
    expect(top(services)).toEqual(GATEWAY);
  });

  it('a screen keeps its cursor while another sits on top of it', () => {
    const { services, press } = boot();
    services.screens.top.state.set('index', 2); // the user had moved to the 3rd row
    press(K.f(8));
    press(K.esc());
    expect(services.screens.top.state.get('index')).toBe(2);
  });
});

describe('Go To (Alt+G)', () => {
  it('opens and closes the palette', () => {
    const { services, press } = boot();
    expect(services.ui.gotoOpen).toBe(false);
    expect(press(K.altG()).defaultPrevented).toBe(true);
    expect(services.ui.gotoOpen).toBe(true);
    press(K.altG());
    expect(services.ui.gotoOpen).toBe(false);
  });

  it('remembers which keyboard scopes were active when it opened (context-aware ranking)', () => {
    const { services, press } = boot();
    services.scopes.push({ id: 'screen:menu', layer: 'screen' });
    press(K.altG());
    expect(services.ui.gotoContext).toEqual(['screen:menu']);
  });

  it('while it is open, other shortcuts are inert — F8 must not open a voucher UNDER the palette', () => {
    const { services, press } = boot();
    press(K.altG());
    const e = press(K.f(8));
    expect(e.defaultPrevented).toBe(false);
    expect(services.screens.depth).toBe(1);
  });

  it('Esc closes the overlay via its own handler — not by also going back a screen', () => {
    const { services, press } = boot();
    services.app.navigate({ type: 'menu', id: 'masters' });
    press(K.altG());
    services.registry.pushHandler('overlay:goto', 'app.back', () => {
      services.app.closeGoTo();
      return true;
    });
    press(K.esc());
    expect(services.ui.gotoOpen).toBe(false);
    expect(services.screens.depth).toBe(2); // still on Masters: Esc closed the palette only
  });

  it('opening a result closes the palette and navigates', () => {
    const { services } = boot();
    services.app.openGoTo();
    services.app.navigate({ type: 'planned', id: 'report.trialBalance' });
    expect(services.ui.gotoOpen).toBe(false);
    expect(titleOfTop(services)).toBe('Trial Balance');
  });
});

describe('contextual commands are handled by whichever screen is active', () => {
  it('Enter does nothing until a screen offers to handle "open"', () => {
    const { services, press } = boot();
    expect(press(K.enter()).defaultPrevented).toBe(false);

    let opened = 0;
    services.scopes.push({ id: 'screen:menu', layer: 'screen' });
    services.registry.pushHandler('screen:menu', 'nav.activate', () => void opened++);
    expect(press(K.enter()).defaultPrevented).toBe(true);
    expect(opened).toBe(1);
  });

  it('a list that is empty declines, so the key falls through', () => {
    const { services, press } = boot();
    services.scopes.push({ id: 'screen:menu', layer: 'screen' });
    services.registry.pushHandler('screen:menu', 'nav.down', () => false);
    expect(press(K.down()).defaultPrevented).toBe(false);
  });

  it('Tab moves through a list just like Down (and will move between form fields later)', () => {
    const { services, press } = boot();
    const calls: string[] = [];
    services.scopes.push({ id: 'screen:menu', layer: 'screen' });
    services.registry.pushHandler('screen:menu', 'field.next', () => void calls.push('next'));
    press(K.tab());
    expect(calls).toEqual(['next']);
  });

  it('in the shortcut editor Enter means "change shortcut", not "open" — a scoped binding beats the general one', () => {
    const { services, press } = boot();
    const calls: string[] = [];
    services.scopes.push({ id: 'screen:settings-keyboard', layer: 'screen' });
    services.registry.pushHandler('screen:settings-keyboard', 'nav.activate', () => void calls.push('open'));
    services.registry.pushHandler('screen:settings-keyboard', 'keymap.change', () => void calls.push('change'));
    press(K.enter());
    expect(calls).toEqual(['change']);
  });
});

describe('customising shortcuts', () => {
  it('rebinding Go To takes effect on the very next keystroke, and the old key stops working', () => {
    const { services, press } = boot();
    expect(services.keymapStore.assign('goto.open', 'Alt+J').ok).toBe(true);

    expect(press(K.altG()).defaultPrevented).toBe(false);
    expect(services.ui.gotoOpen).toBe(false);
    expect(press(K.altJ()).defaultPrevented).toBe(true);
    expect(services.ui.gotoOpen).toBe(true);
  });

  it('survives a reload', () => {
    const first = boot();
    first.services.keymapStore.assign('voucher.new.sales', 'Alt+S');
    const second = boot(first.storage);
    second.press(keydown({ key: 's', code: 'KeyS', altKey: true }));
    expect(titleOfTop(second.services)).toBe('New Sales Voucher');
    expect(second.press(K.f(8)).defaultPrevented).toBe(false); // F8 no longer does it
  });

  it('refuses a key another command already uses', () => {
    const { services } = boot();
    const r = services.keymapStore.assign('goto.open', 'F8');
    expect(r).toMatchObject({ ok: false, reason: 'conflict', conflictWith: 'voucher.new.sales' });
  });

  it('a command with its shortcut removed is still reachable by running it', () => {
    const { services, press } = boot();
    services.keymapStore.unbind('voucher.new.sales');
    expect(press(K.f(8)).defaultPrevented).toBe(false);
    expect(services.registry.run('voucher.new.sales')).toBe(true);
    expect(titleOfTop(services)).toBe('New Sales Voucher');
  });

  it('"Reset Keyboard Shortcuts" restores the defaults', () => {
    const { services, press } = boot();
    services.keymapStore.assign('goto.open', 'Alt+J');
    services.registry.run('settings.resetKeymap');
    expect(press(K.altG()).defaultPrevented).toBe(true);
  });

  it('typing keys cannot be shortcuts — they could no longer be typed', () => {
    const { services } = boot();
    expect(services.keymapStore.assign('goto.open', 'g')).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('Go To search over the real command set', () => {
  const { services } = boot();
  const search = (q: string) => services.search.search(q, { app: services.app, scopes: [] });
  const titles = async (q: string) => (await search(q)).map((h) => h.title);

  it.each([
    ['trial balance', 'Trial Balance'], ['trb', 'Trial Balance'], ['trail balance', 'Trial Balance'],
    ['daybook', 'Day Book'], ['sales voucher', 'New Sales Voucher'], ['purchase voucher', 'New Purchase Voucher'],
    ['create ledger', 'Create Ledger'], ['keyboard', 'Keyboard Shortcuts'], ['hotkeys', 'Keyboard Shortcuts'],
    ['gstr-1', 'GSTR-1'], ['gstr', 'GSTR-1'], ['debtors', 'Outstanding Receivables'], ['godown', 'Create Warehouse'],
    ['p&l', 'Profit & Loss'], ['home', 'Gateway'],
  ])('%j finds %s first', async (q, title) => {
    expect((await titles(q))[0]).toBe(title);
  });

  it('typing a command’s exact title always finds that command first', async () => {
    for (const c of services.registry.all()) {
      if (c.hidden || !c.run) continue;
      if (c.when && !c.when(services.app)) continue; // unavailable right now (no company to close…): Go To rightly omits it
      const top = (await search(c.title))[0];
      expect(top?.commandId, `“${c.title}”`).toBe(c.id);
    }
  });

  it('never offers the plumbing: navigation and contextual commands are not places you go', async () => {
    for (const q of ['move', 'next field', 'page down', 'pin', 'back', 'open selected']) {
      const hits = await search(q);
      for (const h of hits) expect(services.registry.get(h.commandId)?.hidden, `${q} → ${h.title}`).not.toBe(true);
    }
  });

  it('an ambiguous query returns EVERY sensible match, so the right one is a keystroke away', async () => {
    // (the Sales Order Register now matches "sales" too, so the two entry commands are asked for by name, not by rank)
    expect(await titles('sales')).toEqual(expect.arrayContaining(['New Sales Order', 'New Sales Voucher', 'Sales Order Register']));
    expect(await titles('gst')).toEqual(expect.arrayContaining(['GSTR-1', 'GSTR-3B', 'GST Rates']));
  });

  it('the > prefix limits results to commands', async () => {
    expect((await titles('>trial'))[0]).toBe('Trial Balance');
  });

  it('shows what is planned and when', async () => {
    const [h] = await search('debit note');
    expect(h?.badge).toBe('Phase 7');
    expect(h?.kind).toBe('Voucher');
  });

  it('with nothing typed, shows what you have used — favourites first', async () => {
    const { services: s } = boot();
    const hits = async () => s.search.search('', { app: s.app, scopes: [] });
    expect(await hits()).toEqual([]);

    const [tb] = await s.search.search('trial balance', { app: s.app, scopes: [] });
    const [day] = await s.search.search('day book', { app: s.app, scopes: [] });
    s.recents.record(tb!);
    s.recents.record(day!);
    s.recents.togglePinned(day!);
    expect((await hits()).map((h) => [h.title, h.kind])).toEqual([['Day Book', 'Favourite'], ['Trial Balance', 'Recent']]);
  });

  it('a result you use often rises above an equally good alternative', async () => {
    const { services: s } = boot();
    // "create" matches seven commands equally well; use one of them a lot and it should come first
    const q = () => s.search.search('create', { app: s.app, scopes: [] });
    const before = (await q()).map((h) => h.title);
    const last = (await q()).at(-1);
    for (let i = 0; i < 8; i++) s.recents.record(last!);
    const after = (await q()).map((h) => h.title);
    expect(after.indexOf(last!.title)).toBeLessThan(before.indexOf(last!.title));
  });
});
