/**
 * Talking to MinimalCAD's view-only page (…/minimalCAD/view.html, framed by `DrawingViewer`): this page has the drawing and the buttons;
 * that page draws it and makes its PDF. They speak by postMessage (MinimalCAD's src/viewer/protocol.ts is the other half):
 *
 *   viewer → here   { source: VIEWER, type: 'ready' }                     when it can take a file, and again whenever asked
 *   here → viewer   { source: HOST, type: 'hello' }                       "are you ready?" (its first 'ready' may have been said before this page listened)
 *   here → viewer   { source: HOST, type: 'open', document }              the item's .jcad
 *   viewer → here   { source: VIEWER, type: 'opened', kind }              'sheet' (a drawing sheet, true paper size) | 'drawing' (plain 2D)
 *   viewer → here   { source: VIEWER, type: 'problem', message }          the file could not be shown
 *   here → viewer   { source: HOST, type: 'pdf', id, scale }              'fit' | '1:1'
 *   viewer → here   { source: VIEWER, type: 'pdf', id, bytes, warning }   or { …, error }
 *
 * The drawing is a company's own: it is sent only to the frame this page made, at MinimalCAD's own address, and only that frame is heard.
 */

const VIEWER = 'minimalcad-viewer';
const HOST = 'minimalcad-host';

export type DrawingKind = 'sheet' | 'drawing';
export type DrawingScale = 'fit' | '1:1';

export interface DrawingPdf {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** Said when a 1:1 page could not hold the whole drawing. */
  readonly warning: string | undefined;
}

/** The frame showing the viewer, as much of it as this needs. */
export interface ViewerFrame {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface MessageLike {
  readonly source: unknown;
  readonly origin: string;
  readonly data: unknown;
}

interface Listening {
  addEventListener(type: 'message', listener: (e: MessageLike) => void): void;
  removeEventListener(type: 'message', listener: (e: MessageLike) => void): void;
}

export interface DrawingLinkEvents {
  opened(kind: DrawingKind): void;
  problem(message: string): void;
}

/** How long a PDF may take before the viewer is taken to have stopped answering. */
const PDF_WAIT_MS = 60_000;

export class DrawingLink {
  private ready = false;
  private waiting: { readonly document: unknown } | undefined;
  private nextId = 1;
  private readonly asked = new Map<string, { resolve(pdf: DrawingPdf): void; reject(problem: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly origin: string;
  private readonly listener = (e: MessageLike) => this.heard(e);

  /** `frame` is asked each time (the frame's window exists only once it is on the page); `viewerUrl` is the viewer's address. */
  constructor(
    private readonly frame: () => ViewerFrame | null | undefined,
    viewerUrl: string,
    private readonly events: DrawingLinkEvents,
    private readonly win: Listening = window as unknown as Listening,
  ) {
    this.origin = new URL(viewerUrl).origin;
    win.addEventListener('message', this.listener);
  }

  /** Shows this drawing: now, or as soon as the viewer says it is ready. */
  open(document: unknown): void {
    this.waiting = { document };
    if (this.ready) this.sendWaiting();
    else this.hello();
  }

  /** Asks the viewer whether it is ready (when its frame has loaded, and when a drawing is waiting for it). */
  hello(): void {
    if (!this.ready) this.frame()?.postMessage({ source: HOST, type: 'hello' }, this.origin);
  }

  /** The page to print, made by the viewer. */
  pdf(scale: DrawingScale): Promise<DrawingPdf> {
    const frame = this.frame();
    if (!this.ready || !frame) return Promise.reject(new Error('The drawing is not open yet'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.asked.delete(id);
        reject(new Error('The drawing viewer did not answer'));
      }, PDF_WAIT_MS);
      this.asked.set(id, { resolve, reject, timer });
      frame.postMessage({ source: HOST, type: 'pdf', id, scale }, this.origin);
    });
  }

  /** Stops listening; anything still asked for fails. */
  close(): void {
    this.win.removeEventListener('message', this.listener);
    for (const [, a] of this.asked) {
      clearTimeout(a.timer);
      a.reject(new Error('The drawing was closed'));
    }
    this.asked.clear();
  }

  private sendWaiting(): void {
    const frame = this.frame();
    if (!this.ready || !this.waiting || !frame) return;
    frame.postMessage({ source: HOST, type: 'open', document: this.waiting.document }, this.origin);
    this.waiting = undefined;
  }

  private heard(e: MessageLike): void {
    const frame = this.frame();
    if (!frame || e.source !== frame || e.origin !== this.origin) return;
    if (typeof e.data !== 'object' || e.data === null) return;
    const m = e.data as Record<string, unknown>;
    if (m['source'] !== VIEWER) return;
    switch (m['type']) {
      case 'ready':
        this.ready = true;
        return this.sendWaiting();
      case 'opened':
        return this.events.opened(m['kind'] === 'sheet' ? 'sheet' : 'drawing');
      case 'problem':
        return this.events.problem(typeof m['message'] === 'string' ? m['message'] : 'The drawing could not be shown');
      case 'pdf': {
        const a = typeof m['id'] === 'string' ? this.asked.get(m['id']) : undefined;
        if (!a) return;
        this.asked.delete(m['id'] as string);
        clearTimeout(a.timer);
        if (m['bytes'] instanceof ArrayBuffer) a.resolve({ bytes: new Uint8Array(m['bytes']), warning: typeof m['warning'] === 'string' ? m['warning'] : undefined });
        else a.reject(new Error(typeof m['error'] === 'string' ? m['error'] : 'The PDF could not be made'));
        return;
      }
    }
  }
}

/** A file name for the PDF of an item's drawing: "EC21842 - Flat layout.pdf", without what a file name cannot hold. */
export function drawingPdfName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return `${cleaned === '' ? 'Drawing' : cleaned}.pdf`;
}

/** What Print does on this device: the Android app prints it itself (a build that can), or opens it in the phone's PDF viewer (an earlier
 *  build); a desk browser prints it; a phone's browser can only be handed the file. */
export type PrintWay = 'app' | 'appViewer' | 'browser' | 'download';

export function printWayOf(device: { readonly inApp: boolean; readonly appPrintsPdf: boolean; readonly phone: boolean }): PrintWay {
  if (device.inApp) return device.appPrintsPdf ? 'app' : 'appViewer';
  return device.phone ? 'download' : 'browser';
}
