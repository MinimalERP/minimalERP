import { type BillRow, type LedgerId, type Voucher, ledgerMail, ledgerMailProblems, localDate, mailValues, outstandingBills, voucherMail, voucherMailProblems } from '@minimalerp/domain';
import type { Books } from '../books/books';
import { ledgerBills } from '../reports/ledgerReport';
import { pdfOf } from '../ui/pdf';
import type { PrintCoordinator } from '../ui/printCoordinator';
import type { PrintDoc, ReportDoc } from '../ui/printDocs';
import { printCompanyOf } from '../ui/printing';
import type { MailWindowProps } from './MailDialog';
import { formatAmount, formatDate, todayText } from './format';
import { invoiceDocFromBooks } from './invoicePrint';

/**
 * Payment reminders, by email from the company's Gmail, each with its PDF made and attached:
 *  - one bill (“Payment reminder” on a Sales invoice still unpaid): the invoice with a Payment Status box under its totals — only this copy carries it;
 *  - a customer's whole ledger (“Payment reminder” on its Ledger): its Statement of Account, the pending bills listed in the message.
 * The message starts written and stays editable; nothing is kept but the audit line of whom it went to.
 */

type Reminder = Pick<MailWindowProps, 'title' | 'addresses' | 'subject' | 'body' | 'bodyHint' | 'fileHint' | 'makeFile' | 'printFile' | 'problems' | 'send'>;

const fileName = (s: string): string => s.replace(/[\\/:*?"<>|]+/g, '-').trim();
const rupees = (m: bigint): string => `₹${formatAmount(m)}`;
const overdueText = (days: number): string => (days > 0 ? ` (${days} day${days === 1 ? '' : 's'} overdue)` : '');
/** The customer's PO a bill was raised against (the invoice's "Cust PO / ref"), if it has one. */
const poOf = (voucherId: string, books: Books): string => {
  const v = books.voucher(voucherId);
  return v ? mailValues(v, books.masters).reference.trim() : '';
};
const sign = (company: string): string => `Kindly ignore this if it is already paid.\n\nRegards,\n${company}`;

/** A bill as a reminder names it: its number, the customer's PO when the invoice carries one (as it prints), and what is left of it. */
export interface ReminderBill {
  readonly ref: string;
  readonly po: string;
  readonly billDate: string;
  readonly dueDate: string;
  readonly amount: bigint;
  readonly pending: bigint;
  readonly daysOverdue: number;
}

/** One bill's reminder: the subject and the message (editable in the window before it goes). */
export function billReminderText(bill: ReminderBill, party: string, company: string): { subject: string; body: string } {
  const late = bill.daysOverdue > 0;
  return {
    subject: `Payment reminder: invoice ${bill.ref}${bill.po ? ` (your PO ${bill.po})` : ''} — ${rupees(bill.pending)} ${late ? 'overdue' : 'due'}`,
    body:
      `Dear ${party},\n\n` +
      `This is a reminder that our invoice ${bill.ref} dated ${formatDate(bill.billDate)}${bill.po ? ` against your PO No. ${bill.po}` : ''} for ${rupees(bill.amount)} ${late ? 'was' : 'is'} due on ${formatDate(bill.dueDate)}, ` +
      `and ${rupees(bill.pending)} of it is still unpaid${overdueText(bill.daysOverdue)}.\n\n` +
      `The invoice is attached, with its payment status.\n\n` +
      sign(company),
  };
}

/** A pending bill as a line of the whole-ledger reminder. */
export const reminderBillLine = (b: ReminderBill): string =>
  `  ${b.ref}  dated ${formatDate(b.billDate)}${b.po ? `  your PO ${b.po}` : ''}  due ${formatDate(b.dueDate)}  ${rupees(b.pending)}${overdueText(b.daysOverdue)}`;

/** The unpaid bill a Sales invoice raised on its customer, as on today — undefined once it is paid (or for any other voucher). */
export function unpaidBillOf(voucher: Voucher, books: Books): BillRow | undefined {
  const masters = books.masters;
  if (voucher.status !== 'posted' || masters.voucherType(voucher.voucherTypeId)?.baseKind !== 'sales') return undefined;
  return outstandingBills({ vouchers: books.vouchers, masters, side: 'receivable', asOn: localDate(todayText()) }).find((b) => b.voucherId === voucher.id);
}

/** A reminder for one unpaid Sales invoice. */
export function billReminder(voucher: Voucher, books: Books, print: PrintCoordinator): Reminder | undefined {
  const masters = books.masters;
  const bill = unpaidBillOf(voucher, books);
  const mail = voucherMail(voucher, masters);
  if (!bill || !mail) return undefined;
  const today = todayText();
  const party = masters.ledger(bill.ledgerId)?.name ?? bill.party;
  const text = billReminderText({ ...bill, po: poOf(voucher.id, books) }, party, masters.company.name);
  const doc = (): PrintDoc => {
    const d = invoiceDocFromBooks(voucher, books);
    if (!d) throw new Error('The invoice could not be read back');
    return { ...d, paymentStatus: { asOn: today, amount: bill.amount, received: bill.amount - bill.pending, pending: bill.pending, dueDate: bill.dueDate, daysOverdue: bill.daysOverdue } };
  };
  return {
    title: `Payment reminder — ${mail.docName} ${voucher.number}`,
    addresses: mail.to,
    subject: text.subject,
    body: text.body,
    bodyHint: 'Sent in the voucher’s own typewriter style, with the invoice’s number, date and amount above it.',
    fileHint: 'The invoice’s PDF with its payment status is made and attached for you.',
    makeFile: async () => ({ name: `${fileName(voucher.number)}.pdf`, base64: await pdfOf([doc()], printCompanyOf(masters), books.printLayouts) }),
    printFile: () => print.printCopy(doc()),
    problems: (req) => voucherMailProblems(voucher, masters, req),
    send: (req) => books.sendVoucherMail({ voucherId: voucher.id, ...req }),
  };
}

/** A reminder of everything a customer owes: its ledger's statement (`statement`, the printed ledger) attached, the pending bills listed. */
export function ledgerReminder(ledgerId: string, books: Books, statement: ReportDoc, print: PrintCoordinator): Reminder | undefined {
  const masters = books.masters;
  const mail = ledgerMail(ledgerId as LedgerId, masters);
  if (!mail) return undefined;
  const today = todayText();
  const bills = ledgerBills(books.vouchers, masters, ledgerId as LedgerId, localDate(today));
  const total = bills.reduce((t, b) => t + b.pending, 0n);
  const list = bills.map((b) => reminderBillLine({ ...b, po: poOf(b.voucherId, books) })).join('\n');
  return {
    title: `Payment reminder — ${mail.name} (statement of account)`,
    addresses: mail.to,
    subject: bills.length > 0 ? `Payment reminder: ${rupees(total)} due to ${masters.company.name}` : `Statement of account from ${masters.company.name}`,
    body:
      `Dear ${mail.name},\n\n` +
      (bills.length > 0 ? `As on ${formatDate(today)}, these bills are pending with us:\n\n${list}\n\n  Total pending: ${rupees(total)}\n\n` : `Please find your statement of account as on ${formatDate(today)}.\n\n`) +
      `Our statement of account is attached.\n\n` +
      sign(masters.company.name),
    bodyHint: 'Sent in the print’s typewriter style, headed “Statement of Account”.',
    fileHint: 'The Statement of Account (this ledger, as printed) is made and attached for you.',
    makeFile: async () => ({ name: `${fileName(`Statement of Account - ${mail.name} - ${formatDate(today)}`)}.pdf`, base64: await pdfOf([statement], printCompanyOf(masters), books.printLayouts) }),
    printFile: () => print.printCopy(statement),
    problems: (req) => ledgerMailProblems(ledgerId as LedgerId, masters, req),
    send: (req) => books.sendLedgerMail({ ledgerId, ...req }),
  };
}
