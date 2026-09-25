import { type Issue, IssueCode, issue } from '../errors';
import type { Masters } from '../masters/masters';
import { emailsOf } from '../masters/rules';
import { formatMoney } from '../money';
import type { Voucher } from '../vouchers/voucher';
import { grandTotal, gstOfContent } from '../vouchers/kinds/gstDoc';
import { MAIL_DOC_NAMES, type MAIL_PLACEHOLDERS, type MailKind, fillTemplate, isMailKind, templateFor } from '../masters/mailTemplates';

const shownDate = (iso: string | undefined): string => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '');

/** What the placeholders stand for on one voucher. */
export function mailValues(voucher: Voucher, masters: Masters): Record<(typeof MAIL_PLACEHOLDERS)[number], string> {
  const c = voucher.content as unknown as {
    partyId?: string;
    reference?: string;
    billNo?: string;
    dueDate?: string;
    partyDetails?: { mailingName?: string };
    lines?: { qty?: string; rate?: string; gstRate?: string }[];
  };
  const party = c.partyId ? masters.party(c.partyId as never) : undefined;
  const priced = (c.lines ?? []).filter((l): l is { qty: string; rate: string; gstRate?: string } => l.qty !== undefined && l.rate !== undefined);
  return {
    number: voucher.number,
    date: shownDate(voucher.date),
    party: c.partyDetails?.mailingName ?? party?.name ?? '',
    amount: formatMoney(grandTotal(priced.map((l) => ({ qty: String(l.qty), rate: String(l.rate), gstRate: l.gstRate })), gstOfContent(c))),
    due: shownDate(c.dueDate),
    reference: c.reference ?? c.billNo ?? '',
    company: masters.company.name,
  };
}

/** A voucher's mail as it starts: the template filled in, and every address its party has. Undefined for a voucher that is not sent by mail. */
export function voucherMail(voucher: Voucher, masters: Masters): { kind: MailKind; to: string[]; subject: string; body: string; docName: string } | undefined {
  const kind = masters.voucherType(voucher.voucherTypeId)?.baseKind;
  if (!isMailKind(kind)) return undefined;
  const partyId = (voucher.content as unknown as { partyId?: string }).partyId;
  const party = partyId ? masters.party(partyId as never) : undefined;
  const t = templateFor(masters.company.emailTemplates, kind);
  const values = mailValues(voucher, masters);
  return { kind, to: emailsOf(party?.email), subject: fillTemplate(t.subject, values), body: fillTemplate(t.body, values), docName: MAIL_DOC_NAMES[kind] };
}

/** The largest PDF a mail carries (Gmail's own limit is 25 MB for the whole message). */
export const MAX_MAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface VoucherMailRequest {
  readonly to: readonly string[];
  readonly subject: string;
  readonly attachment?: { readonly name: string; readonly base64: string } | undefined;
}

/**
 * What stops a voucher's mail from going: it goes only to addresses of the voucher's OWN party, with a subject, and with at most one PDF of
 * a sensible size. The same check runs in the window and on the server (which does not trust the window).
 */
export function voucherMailProblems(voucher: Voucher, masters: Masters, req: VoucherMailRequest): Issue[] {
  const mail = voucherMail(voucher, masters);
  if (!mail) return [issue(IssueCode.MailInvalid, 'Only sales and purchase documents are sent by email', 'general')];
  const problems: Issue[] = [];
  if (voucher.status !== 'posted') problems.push(issue(IssueCode.MailInvalid, 'Only a saved voucher can be emailed', 'general'));
  const allowed = new Set(mail.to.map((e) => e.toLowerCase()));
  if (req.to.length === 0) problems.push(issue(IssueCode.MailInvalid, allowed.size === 0 ? 'The party has no email address: add one to the party first' : 'Choose at least one address', 'to'));
  const stranger = req.to.find((e) => !allowed.has(e.trim().toLowerCase()));
  if (stranger !== undefined) problems.push(issue(IssueCode.MailInvalid, `${stranger} is not an address of this voucher’s party`, 'to'));
  if (req.subject.trim() === '') problems.push(issue(IssueCode.MailInvalid, 'Enter a subject', 'subject'));
  const a = req.attachment;
  if (a) {
    if (!/\.pdf$/i.test(a.name)) problems.push(issue(IssueCode.MailInvalid, 'Attach a PDF file', 'attachment'));
    if (Math.floor((a.base64.length * 3) / 4) > MAX_MAIL_ATTACHMENT_BYTES) problems.push(issue(IssueCode.MailInvalid, 'The PDF is larger than 10 MB', 'attachment'));
  }
  return problems;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The mail as the party reads it: the voucher's own typewriter look (the monospace the print uses), with the company's name and a summary
 * of the document set off in colour, then the message as the person wrote it, and the company's contact at the foot. Inline styles only:
 * mail programs ignore style sheets. Built on the server from the voucher itself, never from HTML the browser sends.
 */
export function voucherMailHtml(voucher: Voucher, masters: Masters, message: string): string {
  const mail = voucherMail(voucher, masters);
  const v = mailValues(voucher, masters);
  const c = masters.company;
  const font = "Consolas, 'Cascadia Mono', 'Courier New', monospace";
  const accent = '#0b5cad';
  const row = (label: string, value: string, strong = false) =>
    value === ''
      ? ''
      : `<tr><td style="padding:4px 16px 4px 0;color:#5f6b7a;white-space:nowrap">${esc(label)}</td>` +
        `<td style="padding:4px 0;color:${strong ? accent : '#1f2933'};font-weight:${strong ? '700' : '400'}">${esc(value)}</td></tr>`;
  const priced = mail && mail.kind !== 'salesOrder' && mail.kind !== 'purchaseOrder' && mail.kind !== 'quotation';
  const contact = [c.phone, c.email].filter(Boolean).join('  ·  ');
  return (
    `<div style="font-family:${font};font-size:14px;line-height:1.55;color:#1f2933;background:#f4f6f9;padding:24px">` +
    `<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #d9dee5;border-top:4px solid ${accent}">` +
    `<div style="padding:18px 24px 10px"><div style="font-size:18px;font-weight:700;letter-spacing:0.04em;color:${accent}">${esc(c.name.toUpperCase())}</div>` +
    (c.gstin ? `<div style="color:#5f6b7a;font-size:12px">GSTIN ${esc(c.gstin)}</div>` : '') +
    `</div>` +
    `<div style="margin:0 24px;padding:12px 16px;background:#f0f5fb;border-left:3px solid ${accent}">` +
    `<div style="font-size:12px;letter-spacing:0.08em;color:${accent};font-weight:700;margin-bottom:6px">${esc((mail?.docName ?? 'Document').toUpperCase())}</div>` +
    `<table role="presentation" style="border-collapse:collapse;font-family:${font};font-size:14px">` +
    row('Number', v.number, true) +
    row('Date', v.date) +
    row('Reference', v.reference) +
    (priced ? row('Amount', `₹ ${v.amount}`, true) : '') +
    (priced ? row('Due', v.due) : '') +
    `</table></div>` +
    `<div style="padding:18px 24px;white-space:pre-wrap">${esc(message)}</div>` +
    `<div style="padding:12px 24px;border-top:1px dashed #c7ced8;color:#5f6b7a;font-size:12px">` +
    `${esc(c.name)}${c.address ? `<br>${esc(c.address)}` : ''}${contact ? `<br>${esc(contact)}` : ''}</div>` +
    `</div></div>`
  );
}
