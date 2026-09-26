/**
 * A company's own print layout (ADR-0025, step 4): simple HTML with placeholders, filled from the figures the screen already computed.
 *
 *   {{company.name}}              a value, HTML-escaped (a value can never add markup)
 *   {{#lines}} … {{/lines}}       a list: repeated once per line, the line's own fields first, then everything outside it
 *   {{#gst}} … {{/gst}}           a condition: shown when the value is there (not empty, not false, not an empty list)
 *   {{^poNo}} … {{/poNo}}         the opposite: shown when it is not
 *
 * There is no way to insert raw HTML from a value, to call anything, or to reach outside the data given: a layout is a template, not a
 * program. A name that is not in the data is simply blank.
 */

export type TemplateValue = string | number | boolean | null | undefined | TemplateData | readonly TemplateData[];
export interface TemplateData {
  readonly [key: string]: TemplateValue;
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"'`=]/g, (c) => ESCAPES[c] ?? c);

/** A dotted name looked up from the innermost list item outwards. */
function lookup(stack: readonly TemplateValue[], name: string): TemplateValue {
  if (name === '.') return stack[stack.length - 1];
  const [head = '', ...rest] = name.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    const scope = stack[i];
    if (scope !== null && typeof scope === 'object' && !Array.isArray(scope) && Object.hasOwn(scope, head)) {
      let v: TemplateValue = (scope as TemplateData)[head];
      for (const part of rest) {
        v = v !== null && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, part) ? (v as TemplateData)[part] : undefined;
      }
      return v;
    }
  }
  return undefined;
}

const present = (v: TemplateValue): boolean => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false && v !== '');
const text = (v: TemplateValue): string => (v === undefined || v === null || v === false || typeof v === 'object' ? '' : String(v));

type Node = { readonly t: 'text'; readonly s: string } | { readonly t: 'value'; readonly name: string } | { readonly t: 'section'; readonly name: string; readonly inverted: boolean; readonly body: readonly Node[] };

const TAG = /\{\{\s*([#^/]?)\s*([A-Za-z_][\w.]*|\.)\s*\}\}/g;

/** Reads a layout into its parts; an unclosed or mismatched section is an error naming it (the editor shows it). */
export function parseTemplate(template: string): { readonly ok: true; readonly nodes: readonly Node[] } | { readonly ok: false; readonly message: string } {
  const root: Node[] = [];
  const open: { name: string; inverted: boolean; body: Node[] }[] = [];
  const into = () => open[open.length - 1]?.body ?? root;
  let at = 0;
  for (const m of template.matchAll(TAG)) {
    const [whole, sigil = '', name = ''] = m;
    if (m.index > at) into().push({ t: 'text', s: template.slice(at, m.index) });
    at = m.index + whole.length;
    if (sigil === '#' || sigil === '^') open.push({ name, inverted: sigil === '^', body: [] });
    else if (sigil === '/') {
      const section = open.pop();
      if (!section || section.name !== name) return { ok: false, message: `{{/${name}}} closes ${section ? `{{#${section.name}}}` : 'nothing'}` };
      into().push({ t: 'section', name, inverted: section.inverted, body: section.body });
    } else into().push({ t: 'value', name });
  }
  if (at < template.length) into().push({ t: 'text', s: template.slice(at) });
  const unclosed = open[open.length - 1];
  return unclosed ? { ok: false, message: `{{#${unclosed.name}}} is never closed with {{/${unclosed.name}}}` } : { ok: true, nodes: root };
}

function render(nodes: readonly Node[], stack: readonly TemplateValue[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.s;
    else if (n.t === 'value') out += escapeHtml(text(lookup(stack, n.name)));
    else {
      const v = lookup(stack, n.name);
      if (n.inverted) {
        if (!present(v)) out += render(n.body, stack);
      } else if (Array.isArray(v)) {
        for (const item of v as readonly TemplateValue[]) out += render(n.body, [...stack, item]);
      } else if (present(v)) {
        out += render(n.body, typeof v === 'object' ? [...stack, v] : stack);
      }
    }
  }
  return out;
}

/** The layout filled with the data, or why the layout cannot be read. */
export function renderTemplate(template: string, data: TemplateData): { readonly ok: true; readonly html: string } | { readonly ok: false; readonly message: string } {
  const parsed = parseTemplate(template);
  return parsed.ok ? { ok: true, html: render(parsed.nodes, [data]) } : parsed;
}
