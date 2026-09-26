import { describe, expect, it } from 'vitest';
import { parseTemplate, renderTemplate } from './template';

const html = (t: string, data: Parameters<typeof renderTemplate>[1]) => {
  const r = renderTemplate(t, data);
  if (!r.ok) throw new Error(r.message);
  return r.html;
};

describe('a print layout', () => {
  it('fills values by dotted name, and leaves an unknown one blank', () => {
    expect(html('<b>{{company.name}}</b> {{company.gstin}}|{{nope.x}}|', { company: { name: 'Micro Components', gstin: '27AAACM1234C1Z5' } })).toBe(
      '<b>Micro Components</b> 27AAACM1234C1Z5||',
    );
  });

  it('escapes every value: data can never add markup', () => {
    expect(html('<td>{{desc}}</td><img alt="{{alt}}">', { desc: '<script>x</script>', alt: '" onerror="x' })).toBe(
      '<td>&lt;script&gt;x&lt;/script&gt;</td><img alt="&quot; onerror&#61;&quot;x">',
    );
  });

  it('repeats a list, the item’s own fields first and everything outside it after', () => {
    const t = '{{#lines}}<tr><td>{{sno}}</td><td>{{desc}}</td><td>{{currency}}{{amount}}</td></tr>{{/lines}}';
    expect(html(t, { currency: '₹', lines: [{ sno: 1, desc: 'Bolt', amount: '10.00' }, { sno: 2, desc: 'Nut', amount: '5.00' }] })).toBe(
      '<tr><td>1</td><td>Bolt</td><td>₹10.00</td></tr><tr><td>2</td><td>Nut</td><td>₹5.00</td></tr>',
    );
  });

  it('shows a section when the value is there, its opposite when it is not', () => {
    const t = '{{#poNo}}PO {{poNo}}{{/poNo}}{{^poNo}}no PO{{/poNo}}|{{#gst}}CGST {{cgst}}{{/gst}}';
    expect(html(t, { poNo: 'PO-7', gst: { cgst: '9.00' } })).toBe('PO PO-7|CGST 9.00');
    expect(html(t, { poNo: '', gst: undefined })).toBe('no PO|');
    expect(html('{{#lines}}x{{/lines}}{{^lines}}none{{/lines}}', { lines: [] })).toBe('none');
  });

  it('says which section is left open or closed wrongly', () => {
    expect(parseTemplate('{{#lines}}<tr>')).toEqual({ ok: false, message: '{{#lines}} is never closed with {{/lines}}' });
    expect(parseTemplate('{{#a}}{{/b}}')).toEqual({ ok: false, message: '{{/b}} closes {{#a}}' });
  });

  it('leaves text that only looks like a placeholder alone', () => {
    expect(html('{ {a}} {{ 1x }} {{a}}', { a: 'A' })).toBe('{ {a}} {{ 1x }} A');
  });
});
