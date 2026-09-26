import { render } from 'preact';
import type { PrintLayouts } from '@minimalerp/ports';
import { PrintView } from './PrintView';
import type { PrintCompany, PrintDoc } from './printDocs';

/**
 * A PDF of printed pages, made in the page itself — what a payment reminder attaches, so it goes out looking exactly like the printout. The
 * pages are drawn off screen by the same `PrintView` Print uses, pictured, and laid on A4 at the voucher page's margins (0.75in binding margin on
 * the left, 0.4in at the top, 0.2in right and bottom); a page longer than A4 runs on to the next. The PDF libraries load only when one is made.
 */

const A4_H = 297;
const LEFT = 19.05;
const TOP = 10.16;
const WIDTH = 210 - LEFT - 5.08;
const HEIGHT = A4_H - TOP - 5.08;

/**
 * The page is pictured from a copy of the document, whose linked style sheets would be fetched again — on a slow connection they are not back
 * in time and the copy is drawn unstyled. So the copy gets the styles this page already has, written in, and no links to fetch.
 */
function inlineStyles(copy: Document): void {
  const css = [...document.styleSheets]
    .map((sheet) => {
      try {
        return [...sheet.cssRules].map((r) => r.cssText).join('\n');
      } catch {
        return ''; // a sheet from elsewhere cannot be read (none of ours are)
      }
    })
    .join('\n');
  for (const link of copy.querySelectorAll('link[rel="stylesheet"]')) link.remove();
  const style = copy.createElement('style');
  style.textContent = css;
  copy.head.appendChild(style);
}

/** The PDF as base64 (what a mail carries). One unlabelled copy of each document. */
export async function pdfOf(docs: readonly PrintDoc[], company: PrintCompany, layouts?: PrintLayouts): Promise<string> {
  const [{ jsPDF }, { default: html2canvas }] = await Promise.all([import('jspdf'), import('html2canvas-pro')]);
  const host = document.createElement('div');
  host.className = 'pdf-render';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  try {
    render(<PrintView docs={docs} company={company} copies={['']} layouts={layouts} />, host);
    await document.fonts?.ready;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    let first = true;
    for (const page of host.querySelectorAll<HTMLElement>('.print-copy')) {
      const canvas = await html2canvas(page, { scale: 2, backgroundColor: '#ffffff', logging: false, onclone: inlineStyles });
      const perMm = canvas.width / WIDTH;
      const slice = Math.floor(HEIGHT * perMm);
      for (let y = 0; y < canvas.height; y += slice) {
        const part = document.createElement('canvas');
        part.width = canvas.width;
        part.height = Math.min(slice, canvas.height - y);
        part.getContext('2d')?.drawImage(canvas, 0, -y);
        if (!first) pdf.addPage();
        first = false;
        pdf.addImage(part.toDataURL('image/jpeg', 0.9), 'JPEG', LEFT, TOP, WIDTH, part.height / perMm);
      }
    }
    return pdf.output('datauristring').replace(/^data:[^,]*,/, '');
  } finally {
    render(null, host);
    host.remove();
  }
}
