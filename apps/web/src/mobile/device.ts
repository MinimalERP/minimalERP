/**
 * Which of the two interfaces a device gets: the desktop app (keyboard-first, the whole product) or the mobile one (touch, look-up and
 * quick entry). The choice is made once, when the books have been opened, and it only decides what is DRAWN: both interfaces read and
 * write through the same `Books`, so permissions and every posting rule are enforced exactly where they always were — on the server.
 *
 *   ?ui=mobile | ?ui=desktop   →   the choice saved on this device   →   a phone (a coarse pointer on a narrow screen)   →   desktop
 *
 * One address is the desktop app's whatever the device: the AI Inbox (`#/inbox…`), which is where a document shared to the app or to the
 * installed site lands. The mobile interface has no inbox of its own yet, and a shared bill must never arrive at a screen that cannot
 * take it.
 */
export type Ui = 'mobile' | 'desktop';

export const UI_KEY = 'minimalerp.ui';

const asUi = (v: string | null | undefined): Ui | undefined => (v === 'mobile' || v === 'desktop' ? v : undefined);

/** `?ui=mobile` / `?ui=desktop` in the address, if it says either. */
export const uiFromSearch = (search: string): Ui | undefined => asUi(new URLSearchParams(search).get('ui'));

/** The order of precedence, as one pure function: the address, then what was chosen here before, then the device, then desktop. */
export function pickUi(input: { readonly fromAddress?: Ui | undefined; readonly saved?: Ui | undefined; readonly phone: boolean }): Ui {
  return input.fromAddress ?? input.saved ?? (input.phone ? 'mobile' : 'desktop');
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface WindowLike {
  readonly location: { readonly search: string; readonly hash?: string };
  matchMedia(query: string): { readonly matches: boolean };
}

/** A phone: fingers, on a narrow screen. A tablet or a touch laptop keeps the desktop app. */
export const isPhone = (win: WindowLike): boolean => win.matchMedia('(pointer: coarse) and (max-width: 820px)').matches;

/** Any touch device: where "Mobile version" is worth offering from the desktop app. */
export const isTouch = (win: WindowLike): boolean => win.matchMedia('(pointer: coarse)').matches;

const read = (storage: StorageLike | undefined): Ui | undefined => {
  try {
    return asUi(storage?.getItem(UI_KEY));
  } catch {
    return undefined;
  }
};

const write = (storage: StorageLike | undefined, ui: Ui): void => {
  try {
    storage?.setItem(UI_KEY, ui);
  } catch {
    // a private window: the choice lasts for this visit only (the address still carries it)
  }
};

/** The desktop's own addresses on any device: the AI Inbox, where shared documents arrive. */
export const isDesktopOnlyAddress = (hash: string | undefined): boolean => /^#\/inbox(\?|$)/.test(hash ?? '');

/** The interface for this visit. An address that names one is remembered, so the next visit needs no `?ui=`. */
export function chosenUi(win: WindowLike, storage: StorageLike | undefined): Ui {
  // for this visit only: nothing is saved, so the phone is back in the mobile interface next time
  if (isDesktopOnlyAddress(win.location.hash)) return 'desktop';
  const fromAddress = uiFromSearch(win.location.search);
  if (fromAddress) write(storage, fromAddress);
  return pickUi({ fromAddress, saved: read(storage), phone: isPhone(win) });
}

/** Switches interface: remembered on this device, and the page starts again in the other one. */
export function switchUi(ui: Ui, win: Window = window, storage: StorageLike | undefined = safeLocalStorage(win)): void {
  write(storage, ui);
  const url = new URL(win.location.href);
  url.searchParams.set('ui', ui); // said in the address too, so it holds where nothing can be stored
  url.hash = '';
  win.location.assign(url.toString());
}

function safeLocalStorage(win: Window): StorageLike | undefined {
  try {
    return win.localStorage;
  } catch {
    return undefined;
  }
}
