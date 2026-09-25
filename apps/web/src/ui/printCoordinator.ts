import type { DocketDoc, PrintDoc, ReportDoc } from './PrintView';

/** What "1 copy" … "4 copies" prints — Original / Duplicate / Triplicate / a plain Extra Copy, the classic GST-invoice convention. */
export const COPY_LABELS: Readonly<Record<string, readonly string[]>> = {
  '1': ['ORIGINAL'],
  '2': ['ORIGINAL', 'DUPLICATE'],
  '3': ['ORIGINAL', 'DUPLICATE', 'TRIPLICATE'],
  '4': ['ORIGINAL', 'DUPLICATE', 'TRIPLICATE', 'EXTRA COPY'],
};

/**
 * What is being printed, for the whole app — one instance, held in `Services` (like `SaveTracker`/`saving`), rendered by one
 * `PrintHost` mounted directly under `.shell` in `Shell.tsx`. Not one per screen: `#print-root` must be a DIRECT child of
 * `.shell` for the print stylesheet's `.shell > *:not(#print-root) { display: none }` to work — nested any deeper, an
 * ancestor between it and `.shell` would itself be hidden and take the print content down with it (exactly what
 * happened when each screen mounted its own `PrintView` inline: the page printed blank).
 */
export class PrintCoordinator {
  private _docs: readonly PrintDoc[] = [];
  private _copies: readonly string[] | undefined;
  private _dialogOpen = false;
  private readonly listeners = new Set<() => void>();

  /** What prints, in order: one voucher, several chosen on a list (each in all its copies), a report or a docket. */
  get docs(): readonly PrintDoc[] {
    return this._docs;
  }
  get copies(): readonly string[] | undefined {
    return this._copies;
  }
  get dialogOpen(): boolean {
    return this._dialogOpen;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** A voucher, or several chosen on a list: opens the copy-count dialog first (Original / Duplicate / …); every one prints that many. */
  printVoucher(doc: PrintDoc | readonly PrintDoc[]): void {
    this._docs = Array.isArray(doc) ? doc : [doc as PrintDoc];
    this._copies = undefined;
    this._dialogOpen = true;
    this.notify();
  }

  /** A report or a dispatch docket: one unlabelled copy, no dialog — not a document sent to anyone. */
  printReport(doc: ReportDoc | DocketDoc): void {
    this._docs = [doc];
    this._copies = [''];
    this._dialogOpen = false;
    this.notify();
    this.fireWhenMounted();
  }

  /** The copy-count dialog's answer. `undefined` (Esc) cancels: nothing prints. */
  choose(value: string | undefined): void {
    this._dialogOpen = false;
    if (value === undefined) {
      this._docs = [];
      this.notify();
      return;
    }
    this._copies = COPY_LABELS[value] ?? COPY_LABELS['1'];
    this.notify();
    this.fireWhenMounted();
  }

  /** `window.print()` once the DOM has actually committed the copies (a plain call right after choosing would race Preact's own
   * re-render). The mounted copies are left in place afterwards — `#print-root` stays invisible on screen either way, and
   * `window.print()` is not guaranteed to block until the dialog closes, so tearing down on its return could race the
   * browser's own capture of the page. */
  private fireWhenMounted(): void {
    setTimeout(() => window.print(), 0);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}
