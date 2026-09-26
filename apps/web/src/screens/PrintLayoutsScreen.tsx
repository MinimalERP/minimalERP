import type { Frame } from '@minimalerp/command';
import type { PrintLayouts } from '@minimalerp/ports';
import { useMemo, useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { useCommandHandler, useFrameState, useServices, useSubscriptions } from '../shell/hooks';
import type { ScreenRef } from '../shell/router';
import { Kbd } from '../ui/Kbd';
import { type InvoiceDoc, type LedgerDoc, OwnLayout } from '../ui/PrintView';
import { printCompanyOf } from '../ui/printing';
import { BUILT_IN_LAYOUTS, LAYOUT_PLACEHOLDERS, LAYOUT_SHAPES, type LayoutShape, renderLayout } from '../ui/printTemplate';
import { invoiceDocFromBooks } from '../vouchers/invoicePrint';

const SCOPE = 'screen:print-layouts';
const MAX_IMAGE = 150 * 1024;

/** Every layout a company can have: one per document shape, and one per voucher kind (which wins over its shape's). */
const CHOICES: readonly { readonly key: string; readonly shape: LayoutShape; readonly kind?: string; readonly label: string }[] = (Object.keys(LAYOUT_SHAPES) as LayoutShape[]).flatMap((shape) => [
  { key: shape, shape, label: `${LAYOUT_SHAPES[shape].name} — all` },
  ...Object.entries(LAYOUT_SHAPES[shape].kinds).map(([kind, name]) => ({ key: `${shape}.${kind}`, shape, kind, label: `${name} only` })),
]);

/** The newest posted voucher this layout would print, as the document the preview fills (or none yet). */
function sampleDoc(books: Books, shape: LayoutShape, kind: string | undefined): InvoiceDoc | LedgerDoc | undefined {
  const kinds: readonly string[] = kind ? [kind] : Object.keys(LAYOUT_SHAPES[shape].kinds);
  const voucher = [...books.vouchers].reverse().find((v) => v.status === 'posted' && kinds.includes(books.masters.voucherType(v.voucherTypeId)?.baseKind ?? ''));
  if (!voucher) return undefined;
  const type = books.masters.voucherType(voucher.voucherTypeId);
  if (shape === 'invoice') return invoiceDocFromBooks(voucher, books);
  const lines = books.lines
    .filter((l) => l.voucherId === voucher.id)
    .map((l) => ({ ledger: books.masters.ledger(l.ledgerId)?.name ?? '', side: l.side, amount: l.amount as bigint }));
  return { kind: 'ledger', voucherKind: type?.baseKind, docTitle: type?.name ?? '', number: voucher.number, date: voucher.date, lines, narration: voucher.content.narration || undefined };
}

/**
 * The company's own print layouts (ADR-0025, step 4): simple HTML with placeholders, one for invoices and orders and one for Payment /
 * Receipt / Contra / Journal, or one for a single voucher kind. A layout left empty prints the built-in one. The preview fills it with the
 * newest voucher it would print; the logo and signature are kept with the layouts.
 */
export function PrintLayoutsScreen({ frame }: { frame: Frame<ScreenRef> }) {
  const { books: host, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const books = host.current;
  const saved = books?.printLayouts ?? { templates: {}, images: {} };
  const [draft, setDraft] = useFrameState<PrintLayouts>(frame, 'draft', saved);
  const [choice, setChoice] = useFrameState<string>(frame, 'choice', 'invoice');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const picked = CHOICES.find((c) => c.key === choice) ?? CHOICES[0]!;
  const text = draft.templates[picked.key] ?? '';
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const setText = (value: string) => {
    const templates = { ...draft.templates };
    if (value.trim() === '') delete templates[picked.key];
    else templates[picked.key] = value;
    setDraft({ ...draft, templates });
    setNotice(undefined);
  };
  const setImage = (name: 'logo' | 'signature', value: string | undefined) => {
    const images = { ...draft.images };
    if (value === undefined) delete images[name];
    else images[name] = value;
    setDraft({ ...draft, images });
  };
  const pickImage = (name: 'logo' | 'signature', file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return setProblem(`${file.name}: choose a PNG, JPEG, GIF or WebP picture`);
    if (file.size > MAX_IMAGE) return setProblem(`${file.name} is ${Math.round(file.size / 1024)} KB: a picture may be at most 150 KB (make it smaller first)`);
    const reader = new FileReader();
    reader.onload = () => {
      setProblem(undefined);
      setImage(name, String(reader.result));
    };
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (!books || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const r = await books.savePrintLayouts(draft);
      if (!r.ok) return setProblem(r.issues.map((i) => i.message).join(' '));
      setDraft(r.value);
      setNotice('Saved: this company’s vouchers now print with these layouts.');
    } finally {
      setBusy(false);
    }
  };
  useCommandHandler(SCOPE, 'voucher.accept', () => (void save(), true));

  const sample = useMemo(() => (books ? sampleDoc(books, picked.shape, picked.kind) : undefined), [books, picked.key, books?.vouchers]);
  const preview = useMemo(() => {
    if (!books || !sample || text.trim() === '') return undefined;
    return renderLayout(text, sample, printCompanyOf(books.masters), 'Original', draft.images);
  }, [books, sample, text, draft.images]);

  if (!books) return <p class="empty">No company is open.</p>;
  const chord = keymapStore.keymap.chordsFor('voucher.accept')[0];
  return (
    <section class="screen form-screen print-layouts" aria-labelledby="layouts-title" data-testid="print-layouts">
      <h1 id="layouts-title">Print Layouts</h1>
      <p class="lede">
        {books.masters.company.name} prints with its own layout where one is set here, and with the built-in one elsewhere. A layout is simple
        HTML: <code>{'{{name}}'}</code> puts in a value, <code>{'{{#lines}} … {{/lines}}'}</code> repeats for each line, and{' '}
        <code>{'{{#poNo}} … {{/poNo}}'}</code> shows only when there is one. Scripts and outside links are removed.
      </p>
      {problem && (
        <p class="notice error" role="alert">
          {problem}
        </p>
      )}
      {notice && !dirty && (
        <p class="notice" role="status">
          {notice}
        </p>
      )}
      <div class="form">
        <div class="field-row active">
          <label class="field-label" for="layout-choice">
            Layout for
          </label>
          <div class="field-control">
            <select id="layout-choice" class="field-input" value={picked.key} onChange={(e) => setChoice((e.target as HTMLSelectElement).value)}>
              {CHOICES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                  {draft.templates[c.key] ? ' ✓' : ''}
                </option>
              ))}
            </select>
            <span class="field-hint">
              {picked.kind ? 'Used for this kind only; empty = the layout for all of them.' : 'Used for each of these unless that kind has its own.'}
            </span>
          </div>
        </div>
        <div class="field-row">
          <label class="field-label" for="layout-html">
            HTML
          </label>
          <div class="field-control">
            <textarea
              id="layout-html"
              class="field-input layout-html"
              rows={18}
              spellcheck={false}
              value={text}
              placeholder="Empty: the built-in layout prints. Start from it with the button below."
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            />
            <span class="field-hint">Placeholders: {LAYOUT_PLACEHOLDERS[picked.shape].join(' · ')}</span>
          </div>
        </div>
        {(['logo', 'signature'] as const).map((name) => (
          <div class="field-row" key={name}>
            <label class="field-label" for={`layout-${name}`}>
              {name === 'logo' ? 'Logo' : 'Signature'}
            </label>
            <div class="field-control">
              {draft.images[name] && <img class="layout-image" src={draft.images[name]} alt="" />}
              <input id={`layout-${name}`} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => pickImage(name, (e.target as HTMLInputElement).files?.[0])} />
              {draft.images[name] && (
                <button type="button" class="button" onClick={() => setImage(name, undefined)}>
                  Remove
                </button>
              )}
              <span class="field-hint">
                {`{{images.${name}}}`} in a layout — PNG, JPEG, GIF or WebP, at most 150 KB.
              </span>
            </div>
          </div>
        ))}
      </div>
      <div class="toolbar">
        <button type="button" class="button" disabled={busy || !dirty} onClick={() => void save()}>
          Save {chord && <Kbd chord={chord} />}
        </button>
        <button type="button" class="button" onClick={() => setText(BUILT_IN_LAYOUTS[picked.shape])}>
          Start from the built-in layout
        </button>
        {text !== '' && (
          <button type="button" class="button" onClick={() => setText('')}>
            Empty this layout (print the built-in one)
          </button>
        )}
      </div>
      <h2 class="form-section">Preview</h2>
      {text.trim() === '' ? (
        <p class="empty">This layout is empty: the built-in layout prints.</p>
      ) : !sample ? (
        <p class="empty">No voucher of this kind yet to preview with.</p>
      ) : preview && !preview.ok ? (
        <p class="notice error" role="alert">
          The layout cannot be read: {preview.message}. Until it is fixed, the built-in layout prints.
        </p>
      ) : (
        preview && (
          <div class="print-root layout-preview">
            <div class="paper">
              <OwnLayout html={preview.html} />
            </div>
          </div>
        )
      )}
    </section>
  );
}
