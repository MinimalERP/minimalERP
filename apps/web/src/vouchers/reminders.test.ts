import { describe, expect, it } from 'vitest';
import { billReminderText, reminderBillLine } from './reminders';

const bill = { ref: '26-27/031', po: '4422869063', billDate: '2026-05-19', dueDate: '2026-05-19', amount: 10443000n, pending: 1591157n, daysOverdue: 130 };

describe('payment reminder wording', () => {
  it('names the customer’s PO, as the invoice prints it, in the subject and the message', () => {
    const t = billReminderText(bill, 'Eclipse combustion Pvt Ltd', 'Micro Components');
    expect(t.subject).toBe('Payment reminder: invoice 26-27/031 (your PO 4422869063) — ₹15,911.57 overdue');
    expect(t.body).toContain('our invoice 26-27/031 dated 19-May-2026 against your PO No. 4422869063 for ₹1,04,430.00 was due on 19-May-2026');
    expect(t.body).toContain('₹15,911.57 of it is still unpaid (130 days overdue)');
    expect(t.body).toMatch(/Regards,\nMicro Components$/);
  });

  it('an invoice without a PO says nothing about one; one not yet due is “due”', () => {
    const t = billReminderText({ ...bill, po: '', daysOverdue: 0 }, 'Acme', 'Micro Components');
    expect(t.subject).toBe('Payment reminder: invoice 26-27/031 — ₹15,911.57 due');
    expect(t.body).not.toContain('PO');
    expect(t.body).toContain('is due on');
  });

  it('a line of the whole-ledger reminder carries the PO too', () => {
    expect(reminderBillLine(bill)).toBe('  26-27/031  dated 19-May-2026  your PO 4422869063  due 19-May-2026  ₹15,911.57 (130 days overdue)');
    expect(reminderBillLine({ ...bill, po: '' })).not.toContain('PO');
  });
});
