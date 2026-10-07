import { describe, expect, it } from 'vitest';
import { DrawingLink, drawingPdfName, printWayOf } from './drawingLink';

const VIEWER_URL = 'https://cad.example/minimalCAD/view.html';
const ORIGIN = 'https://cad.example';

function setup() {
  const sent: { message: Record<string, unknown>; to: string }[] = [];
  const frame = { postMessage: (message: unknown, to: string) => void sent.push({ message: message as Record<string, unknown>, to }) };
  let listener: ((e: { source: unknown; origin: string; data: unknown }) => void) | undefined;
  const win = {
    addEventListener: (_: 'message', l: typeof listener) => void (listener = l),
    removeEventListener: () => void (listener = undefined),
  };
  const events: string[] = [];
  const link = new DrawingLink(() => frame, VIEWER_URL, { opened: (kind) => void events.push(`opened ${kind}`), problem: (m) => void events.push(`problem ${m}`) }, win as never);
  const say = (data: unknown, from: { source?: unknown; origin?: string } = {}) => listener?.({ source: from.source ?? frame, origin: from.origin ?? ORIGIN, data });
  return { link, sent, events, say, listening: () => listener !== undefined };
}

describe('DrawingLink', () => {
  it('hands the drawing over once the viewer is ready, to the viewer’s own address only', () => {
    const { link, sent, events, say } = setup();
    link.open({ entities: [1] });
    expect(sent).toEqual([{ message: { source: 'minimalcad-host', type: 'hello' }, to: ORIGIN }]); // its first 'ready' may have been missed
    say({ source: 'minimalcad-viewer', type: 'ready' });
    expect(sent.at(-1)).toEqual({ message: { source: 'minimalcad-host', type: 'open', document: { entities: [1] } }, to: ORIGIN });
    say({ source: 'minimalcad-viewer', type: 'opened', kind: 'sheet' });
    expect(events).toEqual(['opened sheet']);
  });

  it('opens at once when the viewer was ready first', () => {
    const { link, sent, say } = setup();
    say({ source: 'minimalcad-viewer', type: 'ready' });
    link.hello(); // nothing to ask: it has said so
    link.open({ entities: [] });
    expect(sent.map((s) => s.message['type'])).toEqual(['open']);
  });

  it('hears only its own frame at the viewer’s address', () => {
    const { link, sent, events, say } = setup();
    link.open({ entities: [] });
    say({ source: 'minimalcad-viewer', type: 'ready' }, { source: {} });
    say({ source: 'minimalcad-viewer', type: 'ready' }, { origin: 'https://elsewhere.example' });
    say({ source: 'someone', type: 'ready' });
    say('ready');
    expect(sent.map((s) => s.message['type'])).toEqual(['hello']);
    say({ source: 'minimalcad-viewer', type: 'problem', message: 'This drawing is empty.' });
    expect(events).toEqual(['problem This drawing is empty.']);
  });

  it('asks for the PDF and gives back its bytes and warning', async () => {
    const { link, sent, say } = setup();
    await expect(link.pdf('fit')).rejects.toThrow('not open yet');
    say({ source: 'minimalcad-viewer', type: 'ready' });
    const asked = link.pdf('1:1');
    expect(sent.at(-1)).toEqual({ message: { source: 'minimalcad-host', type: 'pdf', id: '1', scale: '1:1' }, to: ORIGIN });
    say({ source: 'minimalcad-viewer', type: 'pdf', id: '1', bytes: new Uint8Array([37, 80, 68, 70]).buffer, warning: 'clipped' });
    const pdf = await asked;
    expect([...pdf.bytes]).toEqual([37, 80, 68, 70]);
    expect(pdf.warning).toBe('clipped');
  });

  it('fails a PDF the viewer could not make, and whatever is asked when it closes', async () => {
    const { link, say, listening } = setup();
    say({ source: 'minimalcad-viewer', type: 'ready' });
    const refused = link.pdf('fit');
    say({ source: 'minimalcad-viewer', type: 'pdf', id: '1', error: 'There is nothing to print' });
    await expect(refused).rejects.toThrow('There is nothing to print');
    const open = link.pdf('fit');
    link.close();
    await expect(open).rejects.toThrow('closed');
    expect(listening()).toBe(false);
  });
});

describe('drawingPdfName', () => {
  it('names the PDF after the item and the file', () => {
    expect(drawingPdfName('EC21842 - BRKT,MTG / Flat layout')).toBe('EC21842 - BRKT,MTG - Flat layout.pdf');
    expect(drawingPdfName('  ')).toBe('Drawing.pdf');
  });
});

describe('printWayOf', () => {
  it('says what Print does on each device', () => {
    expect(printWayOf({ inApp: true, appPrintsPdf: true, phone: true })).toBe('app');
    expect(printWayOf({ inApp: true, appPrintsPdf: false, phone: true })).toBe('appViewer');
    expect(printWayOf({ inApp: false, appPrintsPdf: false, phone: false })).toBe('browser');
    expect(printWayOf({ inApp: false, appPrintsPdf: false, phone: true })).toBe('download');
  });
});
