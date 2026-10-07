import type { BaseKind } from '@minimalerp/domain';
import type { InboxItem } from '@minimalerp/ports';

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
  | { readonly page: 'utilities' }
  | { readonly page: 'reports' }
  | { readonly page: 'orderRegister'; readonly side: 'sales' | 'purchase' }
  | { readonly page: 'dayBook' }
  /** A new Stock Journal: stock out of a godown and into one, no accounts touched. */
  | { readonly page: 'stockJournal' }
  /** Scan: photograph or choose a document to be read, and the ones read and waiting to be checked and saved. */
  | { readonly page: 'scan' }
  /** A new stock item or customer, in the few fields a sale needs (from the Stock / Parties lists). */
  | { readonly page: 'create'; readonly what: 'item' | 'customer' }
  /** What can be made on the phone: the list of documents to start. */
  | { readonly page: 'new' }
  /**
   * Entering a document by touch: a new one of `kind` (optionally for a party, or for what an order / challan still has pending), or the
   * posted `voucherId` being altered.
   */
  | { readonly page: 'entry'; readonly kind: EntryKind; readonly voucherId?: string; readonly partyId?: string; readonly fromOrder?: string; /** With `fromOrder`: only these lines of the order. */ readonly fromOrderLines?: readonly string[]; /** A document read by Scan: the form starts as what was read, and is posted under its id. */ readonly proposal?: InboxItem };

/** The documents the phone enters: the selling side's, and the Purchase bill. Everything else is entered on the desktop. */
export type EntryKind = 'sales' | 'salesOrder' | 'quotation' | 'deliveryChallan' | 'purchase';

interface HistoryWindow {
  readonly history: { pushState(data: unknown, unused: string): void; back(): void };
  addEventListener(type: 'popstate', listener: () => void): void;
}

export class MobileNav {
  private stack: Page[] = [{ page: 'gateway' }];
  /** What is open OVER the page on top (a picker, a sheet): Back closes the last of these before it closes the page. */
  private layers: (() => void)[] = [];
  /** Asked before Back closes the page on top; false keeps the page (it then says why — "Discard changes?"). */
  private guard: (() => boolean) | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly win: HistoryWindow = window) {
    win.addEventListener('popstate', () => {
      const close = this.layers.pop();
      if (close) return close();
      if (this.stack.length <= 1) return;
      if (this.guard && !this.guard()) {
        this.win.history.pushState({ m: this.stack.length }, ''); // the entry Back just spent is laid again: the page stays
        return;
      }
      this.guard = undefined;
      this.stack = this.stack.slice(0, -1);
      this.notify();
    });
  }

  /** Something opened over the page: the phone's Back (or `closeLayer`) closes it, calling `close`. */
  openLayer(close: () => void): void {
    this.layers.push(close);
    this.win.history.pushState({ layer: this.layers.length }, '');
  }

  /** The layer on top becomes another (a list's choice opens a sheet in its place): still one Back to close it. */
  swapLayer(close: () => void): void {
    if (this.layers.length === 0) return this.openLayer(close);
    this.layers[this.layers.length - 1] = close;
  }

  /** Closes the layer on top, exactly as Back would. */
  closeLayer(): void {
    if (this.layers.length > 0) this.win.history.back();
  }

  /** The page on top wants a say before Back closes it (cleared when it does close, or with `undefined`). */
  setGuard(guard: (() => boolean) | undefined): void {
    this.guard = guard;
  }

  /** The page on top becomes another, in place: Back goes where it would have gone (a saved document replaces the form that made it). */
  replace(page: Page): void {
    this.guard = undefined;
    this.stack = [...this.stack.slice(0, -1), page];
    this.notify();
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
    this.guard = undefined;
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
