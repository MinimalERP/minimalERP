import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { DrawingLink, type DrawingKind, type DrawingScale, drawingPdfName, printWayOf } from './drawingLink';
import { canPrintPdfInApp, canShareInApp, isAndroidApp, printPdfInApp, saveInApp, shareInApp } from './nativeApp';
import './drawingViewer.css';

const PDF = 'application/pdf';

type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function download(name: string, bytes: Uint8Array<ArrayBuffer>): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: PDF }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A desk browser prints a PDF from a frame nobody sees; one that will not is shown the PDF in a tab of its own instead. */
function printInBrowser(bytes: Uint8Array<ArrayBuffer>): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: PDF }));
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  frame.onload = () => {
    try {
      frame.contentWindow!.focus();
      frame.contentWindow!.print();
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  };
  frame.src = url;
  document.body.appendChild(frame);
  // the print window reads the frame while it is open: cleared well after, never during
  setTimeout(() => {
    frame.remove();
    URL.revokeObjectURL(url);
  }, 10 * 60_000);
}

function browserShares(): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([new Uint8Array(1)], 'a.pdf', { type: PDF })] });
  } catch {
    return false;
  }
}

const isPhone = (): boolean => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/**
 * An item's MinimalCAD drawing, shown over the page to be looked at and printed — on the desk and, in the Android app, on the shop floor.
 * MinimalCAD's own view-only page draws it (in a frame: the drawing is the editor's, to the line) and makes the PDF; nothing here can
 * change the drawing. A drawing sheet prints at its paper size; a plain 2D drawing (a flat layout) is fitted to A4, or printed 1:1.
 *
 * It takes no part in the desktop's keyboard scopes or the phone's Back: whoever shows it closes it (`onClose`).
 */
export function DrawingViewer({ title, viewerUrl, load, onClose }: { readonly title: string; readonly viewerUrl: string; readonly load: () => Promise<Answer<unknown>>; readonly onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const link = useRef<DrawingLink | undefined>(undefined);
  const [kind, setKind] = useState<DrawingKind | undefined>(undefined);
  const [problem, setProblem] = useState('');
  const [scale, setScale] = useState<DrawingScale>('fit');
  const [busy, setBusy] = useState<'print' | 'share' | 'save' | undefined>(undefined);
  const [note, setNote] = useState<{ readonly text: string; readonly bad: boolean } | undefined>(undefined);

  // Layout, not after paint: the frame must be listened to before it can have loaded
  useLayoutEffect(() => {
    let live = true;
    const made = new DrawingLink(() => frame.current?.contentWindow, viewerUrl, {
      opened: (k) => live && setKind(k),
      problem: (m) => live && setProblem(m),
    });
    link.current = made;
    void load().then(
      (r) => {
        if (!live) return;
        if (r.ok) made.open(r.value);
        else setProblem(r.message);
      },
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : 'The drawing could not be fetched'),
    );
    return () => {
      live = false;
      made.close();
    };
  }, [viewerUrl]);

  const name = drawingPdfName(title);
  const printWay = printWayOf({ inApp: isAndroidApp(), appPrintsPdf: canPrintPdfInApp(), phone: isPhone() });
  const shares = isAndroidApp() ? canShareInApp() : browserShares();

  const withPdf = async (what: 'print' | 'share' | 'save', use: (bytes: Uint8Array<ArrayBuffer>) => Promise<string | undefined> | string | undefined) => {
    if (!link.current || busy) return;
    setBusy(what);
    setNote(undefined);
    try {
      const pdf = await link.current.pdf(scale);
      const said = await use(pdf.bytes);
      const text = [pdf.warning ? 'At 1:1 the drawing is larger than one A4 page: what did not fit was cut off. Fit to page prints all of it.' : undefined, said].filter(Boolean).join(' ');
      if (text) setNote({ text, bad: pdf.warning !== undefined });
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') setNote({ text: `The PDF could not be made: ${e instanceof Error ? e.message : String(e)}`, bad: true });
    } finally {
      setBusy(undefined);
    }
  };
  const print = () =>
    withPdf('print', (bytes) => {
      if (printWay === 'app') return void printPdfInApp(name, base64Of(bytes));
      if (printWay === 'appViewer') {
        saveInApp(name, PDF, bytes);
        return 'Saved to Downloads and opened: print it from there. Update the app to print straight from here.';
      }
      if (printWay === 'browser') return void printInBrowser(bytes);
      download(name, bytes);
      return 'The PDF was downloaded: open it to print.';
    });
  const share = () =>
    withPdf('share', async (bytes) => {
      if (shareInApp(name, PDF, base64Of(bytes))) return undefined;
      await navigator.share({ files: [new File([bytes], name, { type: PDF })], title });
      return undefined;
    });
  const save = () =>
    withPdf('save', (bytes) => {
      if (saveInApp(name, PDF, bytes)) return 'Saved to Downloads.';
      download(name, bytes);
      return undefined;
    });

  const shown = kind !== undefined && problem === '';
  return (
    <div class="drawing-viewer-back" role="presentation" data-testid="drawing-viewer">
      <section class="drawing-viewer" role="dialog" aria-modal="true" aria-label={`Drawing: ${title}`}>
        <header class="drawing-viewer-head">
          <strong>{title}</strong>
          {shown && kind === 'drawing' ? (
            <label class="drawing-viewer-scale">
              Print
              <select value={scale} data-testid="drawing-scale" onChange={(e) => setScale((e.target as HTMLSelectElement).value === '1:1' ? '1:1' : 'fit')}>
                <option value="fit">Fit to A4</option>
                <option value="1:1">1:1 on A4</option>
              </select>
            </label>
          ) : null}
          <button type="button" class="drawing-viewer-button primary" disabled={!shown || busy !== undefined} data-testid="drawing-print" onClick={() => void print()}>
            {busy === 'print' ? 'Making…' : 'Print'}
          </button>
          {shares ? (
            <button type="button" class="drawing-viewer-button" disabled={!shown || busy !== undefined} data-testid="drawing-share" onClick={() => void share()}>
              {busy === 'share' ? 'Making…' : 'Share PDF'}
            </button>
          ) : null}
          <button type="button" class="drawing-viewer-button" disabled={!shown || busy !== undefined} data-testid="drawing-save" onClick={() => void save()}>
            {busy === 'save' ? 'Making…' : 'Save PDF'}
          </button>
          <button type="button" class="drawing-viewer-button" data-testid="drawing-close" onClick={onClose}>
            Close
          </button>
        </header>
        {note ? (
          <p class={note.bad ? 'drawing-viewer-note bad' : 'drawing-viewer-note'} role="status" data-testid="drawing-note">
            {note.text}
          </p>
        ) : null}
        {problem ? (
          <p class="drawing-viewer-problem" role="alert" data-testid="drawing-problem">
            {problem}
          </p>
        ) : (
          <iframe ref={frame} title={`Drawing: ${title}`} src={viewerUrl} onLoad={() => link.current?.hello()} />
        )}
      </section>
    </div>
  );
}
