import type { Voucher } from '@minimalerp/domain';
import { useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { ANDROID_APK_URL, canShareInApp, isAndroidApp, openInApp, saveInApp, shareInApp } from '../ui/nativeApp';
import type { PrintCoordinator } from '../ui/printCoordinator';
import { printCompanyOf } from '../ui/printing';
import { invoiceDocFromBooks } from '../vouchers/invoicePrint';
import type { MobileNav } from './nav';
import { COPY_CHOICES, bytesOfBase64, copyLabelsOf, pdfNameOf, rememberCopies, rememberedCopies, shareWayOf } from './print';
import { Row } from './ui';

const PDF = 'application/pdf';

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Whether this browser can hand a PDF file to another app. */
function browserShares(): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([new Uint8Array(1)], 'a.pdf', { type: PDF })] });
  } catch {
    return false;
  }
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

/**
 * "Print / PDF" on a document: which copies (the desktop's list), then Print, Share PDF or Save PDF. The pages are the desktop's own
 * (`PrintCoordinator`, `pdfOf`), so a phone's Duplicate is the desk's Duplicate. The phone's Back closes it (it is a layer of the page).
 */
export function PrintSheet({ books, nav, print, voucher }: { books: Books; nav: MobileNav; print: PrintCoordinator; voucher: Voucher }) {
  const [copies, setCopies] = useState(() => rememberedCopies(storage()));
  const [busy, setBusy] = useState<'share' | 'save' | undefined>(undefined);
  const [problem, setProblem] = useState('');
  /** A PDF made for sharing that the browser would not send without a fresh tap (it took too long to draw): the next tap sends it. */
  const [ready, setReady] = useState<{ readonly copies: string; readonly file: File } | undefined>(undefined);
  const way = shareWayOf({ inApp: isAndroidApp(), appShares: canShareInApp(), browserShares: browserShares() });
  const name = pdfNameOf(voucher.number);

  const choose = (value: string) => {
    setCopies(value);
    setProblem('');
  };
  const printIt = () => {
    const doc = invoiceDocFromBooks(voucher, books);
    if (!doc) return;
    rememberCopies(storage(), copies);
    nav.closeLayer();
    print.printVoucher(doc);
    print.choose(copies);
  };
  const makePdf = async (): Promise<string> => {
    const doc = invoiceDocFromBooks(voucher, books);
    if (!doc) throw new Error('This voucher has no printed form.');
    rememberCopies(storage(), copies);
    const { pdfOf } = await import('../ui/pdf');
    return pdfOf([doc], printCompanyOf(books.masters), books.printLayouts, copyLabelsOf(copies));
  };
  const failed = (e: unknown) => setProblem(`The PDF could not be made: ${e instanceof Error ? e.message : String(e)}`);
  const send = async (file: File) => {
    try {
      await navigator.share({ files: [file], title: `${voucher.number}` });
      setReady(undefined);
      nav.closeLayer();
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return; // the person closed the share sheet
      setReady({ copies, file }); // drawn, but the browser wants a fresh tap to send it
    }
  };
  const shareIt = async () => {
    if (ready && ready.copies === copies) return send(ready.file);
    setBusy('share');
    setProblem('');
    try {
      const base64 = await makePdf();
      if (way === 'app') {
        shareInApp(name, PDF, base64);
        nav.closeLayer();
      } else {
        await send(new File([bytesOfBase64(base64)], name, { type: PDF }));
      }
    } catch (e) {
      failed(e);
    } finally {
      setBusy(undefined);
    }
  };
  const saveIt = async () => {
    setBusy('save');
    setProblem('');
    try {
      const bytes = bytesOfBase64(await makePdf());
      if (!saveInApp(name, PDF, bytes)) download(name, bytes);
      nav.closeLayer();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(undefined);
    }
  };

  const waiting = ready !== undefined && ready.copies === copies;
  return (
    <div class="m-sheet-back" onClick={(e) => e.target === e.currentTarget && !busy && nav.closeLayer()}>
      <div class="m-sheet" role="dialog" aria-label="Print" data-testid="print-sheet">
        <p class="m-sheet-title">Print {voucher.number}</p>
        {COPY_CHOICES.map((c) => (
          <Row key={c.value} title={c.label} sub={c.hint} selected={copies === c.value} onHold={() => undefined} onOpen={() => choose(c.value)} testId={`copies-${c.value}`} />
        ))}
        {problem ? (
          <p class="m-note bad" data-testid="print-problem">
            {problem}
          </p>
        ) : null}
        {way === 'update' ? (
          <p class="m-note" data-testid="print-update">
            To send a PDF to WhatsApp or mail from here,{' '}
            <button type="button" class="m-link" onClick={() => void openInApp(ANDROID_APK_URL)}>
              update the app
            </button>
            . Save PDF works now.
          </p>
        ) : null}
        <div class="m-actions m-wrap">
          <button type="button" class="m-button m-primary" data-testid="print-go" disabled={busy !== undefined} onClick={printIt}>
            Print
          </button>
          {way === 'app' || way === 'browser' ? (
            <button type="button" class="m-button" data-testid="print-share" disabled={busy !== undefined} onClick={() => void shareIt()}>
              {busy === 'share' ? 'Making the PDF…' : waiting ? `Send ${name}` : 'Share PDF'}
            </button>
          ) : null}
          <button type="button" class="m-button" data-testid="print-save" disabled={busy !== undefined} onClick={() => void saveIt()}>
            {busy === 'save' ? 'Making the PDF…' : 'Save PDF'}
          </button>
        </div>
      </div>
    </div>
  );
}
