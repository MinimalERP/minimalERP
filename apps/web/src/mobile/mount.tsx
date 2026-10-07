import { render } from 'preact';
import type { BooksHost } from '../books/books';
import type { Account, LocalBooks } from '../shell/services';
import { PrintCoordinator } from '../ui/printCoordinator';
import { MobileApp } from './MobileApp';
import { MobileNav } from './nav';
import './mobile.css';

/**
 * Shows the mobile interface in place of the desktop shell (main.tsx decides which, once the books are open). It is given the books and the
 * account, and nothing of the desktop's machinery: no command registry, no keymap, no keyboard listener.
 */
export function mountMobile(options: { readonly books: BooksHost; readonly root: HTMLElement; readonly account?: Account | undefined; readonly localBooks?: LocalBooks | undefined }): void {
  const nav = new MobileNav(window);
  const print = new PrintCoordinator();
  // A document shared to the app (or to the installed site) arrives at the inbox address: on the phone that is Scan, which takes it.
  if (/^#\/inbox(\?|$)/.test(window.location.hash)) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    nav.open({ page: 'scan' });
  }
  // The Android app's "New" shortcut (a long press on its icon).
  if (/^#\/new(\?|$)/.test(window.location.hash)) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    nav.open({ page: 'new' });
  }
  render(<MobileApp host={options.books} nav={nav} print={print} account={options.account} localBooks={options.localBooks} />, options.root);
}
