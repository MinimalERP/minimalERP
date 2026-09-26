/**
 * A company's own print layout (ADR-0025, step 4), in a real browser: the filled HTML is cleaned before it is shown (no scripts, handlers,
 * outside links or pictures), and it renders in a shadow root so its styles stay its own. The layouts themselves are kept with the
 * online books (tested against the database); here the page's own module is driven directly.
 */
import { expect, test } from './support';

/** The page's own module, served by the dev server (a path the browser imports, not this file). */
const MODULE = '/src/ui/printTemplate.ts';

type Mod = {
  cleanLayoutHtml(html: string): string;
  renderLayout(t: string, doc: unknown, company: unknown, label: string, images: Record<string, string>): { ok: true; html: string } | { ok: false; message: string };
  BUILT_IN_LAYOUTS: { invoice: string };
};

test('a layout is cleaned: no scripts, handlers, outside links or pictures — its own pictures and styles stay', async ({ page }) => {
  await page.goto('/');
  const cleaned = await page.evaluate(async (MODULE) => {
    const m = (await import(/* @vite-ignore */ MODULE)) as Mod;
    return m.cleanLayoutHtml(
      [
        '<style>@import url(https://evil.test/x.css); h1 { color: red; background: url(https://evil.test/t.png) }</style>',
        '<h1 onclick="steal()">Hello</h1><script>steal()</script><iframe src="https://evil.test"></iframe>',
        '<a href="javascript:steal()">x</a><img src="https://evil.test/track.png"><img src="data:image/png;base64,AAAA" alt="logo">',
        '<form action="https://evil.test"><input name="p"></form><p style="background:url(https://evil.test/p.png)">p</p>',
      ].join(''),
    );
  }, MODULE);
  expect(cleaned).toContain('<h1>Hello</h1>');
  expect(cleaned).toContain('h1 { color: red;');
  expect(cleaned).toContain('src="data:image/png;base64,AAAA"');
  for (const gone of ['script', 'steal', 'iframe', 'evil.test', 'javascript:', '<form', '<input', '@import', 'onclick']) expect(cleaned).not.toContain(gone);
});

test('the built-in layout, filled with a document, renders in its own shadow root on the page', async ({ page }) => {
  await page.goto('/');
  const shown = await page.evaluate(async (MODULE) => {
    const m = (await import(/* @vite-ignore */ MODULE)) as Mod;
    const doc = {
      kind: 'invoice',
      docTitle: 'Tax Invoice',
      number: 'INV/1',
      date: '2024-06-01',
      party: { name: 'Acme <Ltd>' },
      lines: [{ desc: 'Bolt', qty: '2 Nos', rate: '10', amount: 2000n }],
      subtotal: 2000n,
      grandTotal: 2000n,
    };
    const r = m.renderLayout(m.BUILT_IN_LAYOUTS.invoice, doc, { name: 'Micro Components' }, 'Original', {});
    if (!r.ok) return r.message;
    const host = document.createElement('div');
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = r.html;
    const root = host.shadowRoot!;
    return { party: root.querySelector('.parties b')?.textContent, total: root.querySelector('tr.grand')?.textContent, leaks: getComputedStyle(document.body).fontFamily.includes('Consolas') };
  }, MODULE);
  expect(shown).toEqual({ party: 'Acme <Ltd>', total: 'Total₹ 20.00', leaks: false });
});
