import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { seedCompany } from '../masters/seed';
import type { Voucher } from '../vouchers/voucher';
import { DEFAULT_MAIL_TEMPLATES, fillTemplate, templateFor } from '../masters/mailTemplates';
import { voucherMail } from './voucherMail';

const newId = (n: string) => deterministicUuid(`mail|${n}`);

function company(): { masters: Masters; partyId: string } {
  let masters = seedCompany({ name: 'Micro Components', fyStart: localDate('2026-04-01'), newId });
  const partyId = newId('party');
  const r = prepareMasterCommand({ op: 'create', kind: 'party', id: partyId, data: { name: 'Acme Ltd', roles: ['customer'], email: 'sales@acme.in, accounts@acme.in' } }, masters);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  masters = r.value.masters;
  return { masters, partyId };
}

const voucherOf = (masters: Masters, base: string, content: object): Voucher =>
  ({
    id: newId('v'),
    companyId: masters.company.id,
    voucherTypeId: masters.voucherTypes.find((t) => t.baseKind === base)!.id,
    financialYearId: masters.financialYears[0]!.id,
    number: 'SAL/26-27/0145',
    date: '2026-09-25',
    status: 'posted',
    version: 1,
    revision: 0,
    content,
  }) as unknown as Voucher;

describe('a voucher’s email', () => {
  it('fills the template from the voucher and offers every address of its party', () => {
    const { masters, partyId } = company();
    const v = voucherOf(masters, 'sales', { partyId, reference: 'PO-77', dueDate: '2026-10-25', lines: [{ qty: '10', rate: '55' }] });
    const mail = voucherMail(v, masters)!;
    expect(mail.to).toEqual(['sales@acme.in', 'accounts@acme.in']);
    expect(mail.subject).toBe('Invoice SAL/26-27/0145 from Micro Components');
    expect(mail.body).toContain('invoice SAL/26-27/0145 dated 25-09-2026 for ₹550.00, due on 25-10-2026');
    expect(mail.body.startsWith('Dear Acme Ltd,')).toBe(true);
    expect(mail.body).toContain('Your PO: PO-77');
  });

  it('a line whose placeholder is empty is left out (an invoice without a PO says nothing about one)', () => {
    const { masters, partyId } = company();
    const mail = voucherMail(voucherOf(masters, 'sales', { partyId, dueDate: '2026-10-25', lines: [{ qty: '1', rate: '5' }] }), masters)!;
    expect(mail.body).not.toContain('PO');
    expect(mail.body).toContain('due on 25-10-2026');
  });

  it('uses the company’s own template for that kind, and the default for a part left blank', () => {
    const { masters, partyId } = company();
    const own = masters.with({ company: { ...masters.company, emailTemplates: { sales: { subject: 'Bill {number} / {reference}', body: '' } } } });
    const mail = voucherMail(voucherOf(own, 'sales', { partyId, reference: 'PO-77', lines: [] }), own)!;
    expect(mail.subject).toBe('Bill SAL/26-27/0145 / PO-77');
    expect(templateFor(own.company.emailTemplates, 'sales').body).toBe(DEFAULT_MAIL_TEMPLATES.sales.body);
  });

  it('a name in braces that is not a placeholder stays as typed', () => {
    expect(fillTemplate('{number} {nonsense}', { number: 'Q-1' })).toBe('Q-1 {nonsense}');
  });

  it('only the documents with a party are sent: not a payment', () => {
    const { masters } = company();
    expect(voucherMail(voucherOf(masters, 'payment', {}), masters)).toBeUndefined();
  });

  it('the company keeps its templates: saved through its master command, blank ones dropped', () => {
    const { masters } = company();
    const r = prepareMasterCommand(
      {
        op: 'alter',
        kind: 'company',
        id: masters.company.id,
        data: { name: masters.company.name, emailTemplates: { quotation: { subject: ' Quote {number} ', body: 'Hi {party}\n' }, sales: { subject: '', body: '' } } },
      },
      masters,
    );
    expect(r.ok, r.ok ? '' : JSON.stringify(r.issues)).toBe(true);
    if (r.ok) expect(r.value.masters.company.emailTemplates).toEqual({ quotation: { subject: 'Quote {number}', body: 'Hi {party}' } });
  });
});
