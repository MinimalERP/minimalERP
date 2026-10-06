import type { BaseKind } from '@minimalerp/domain';

/**
 * Where the mobile interface is — the desktop's own way of moving, for a thumb: a Gateway of plain rows, each opening a list or a menu on
 * top of it, each row of that opening the next, and Back returning to exactly where one was. Every page opened lays a browser history
 * entry, so the phone's Back (and a swipe back) closes the page on top; on the Gateway Back is the browser's, and leaves.
 */
export type Page =
  | { readonly page: 'gateway' }
  | { readonly page: 'transactions' }
  | { readonly page: 'docs'; readonly kind: BaseKind }
  | { readonly page: 'doc'; readonly voucherId: string }
  | { readonly page: 'parties' }
  | { readonly page: 'party'; readonly partyId: string }
  | { readonly page: 'items' }
  | { readonly page: 'item'; readonly itemId: string }
  | { readonly page: 'outstanding'; readonly side: 'receivable' | 'payable' }
  | { readonly page: 'utilities' };

interface HistoryWindow {
  readonly history: { pushState(data: unknown, unused: string): void; back(): void };
  addEventListener(type: 'popstate', listener: () => void): void;
}

export class MobileNav {
  private stack: Page[] = [{ page: 'gateway' }];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly win: HistoryWindow = window) {
    win.addEventListener('popstate', () => {
      if (this.stack.length > 1) {
        this.stack = this.stack.slice(0, -1);
        this.notify();
      }
    });
  }

  get top(): Page {
    return this.stack[this.stack.length - 1] as Page;
  }
  get depth(): number {
    return this.stack.length;
  }

  /** Opens a page on top (Back closes it). */
  open(page: Page): void {
    this.stack = [...this.stack, page];
    this.win.history.pushState({ m: this.stack.length }, '');
    this.notify();
  }

  /** Closes the page on top, as the phone's Back does. */
  back(): void {
    if (this.stack.length > 1) this.win.history.back();
  }

  /** Straight back to the Gateway (another company was opened: nothing of the last one stays on screen). */
  reset(): void {
    this.stack = [{ page: 'gateway' }];
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}
