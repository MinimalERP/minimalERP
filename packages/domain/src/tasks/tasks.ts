import { z } from 'zod';
import type { LocalDate } from '../dates';
import { type Result, IssueCode, fail, issue, ok } from '../errors';
import { dailyDigest } from '../reports/digest';
import type { JournalLine } from '../posting/plan';
import type { Masters } from '../masters/masters';
import type { OrderBook } from '../orders/orderBook';
import type { Voucher } from '../vouchers/voucher';

/**
 * TASKS — what someone has to do, on the Gateway: a task ("call Kumar about the plating rate") or a project ENQUIRY followed from first
 * contact to won or lost, with short dated notes of what was done on it. A task is for the owner or the company's user. It may come from
 * the Gateway, the Gmail side panel (with a link back to the mail) or the assistant. What is DUE this week is not a task: it is read from the
 * books every time (`dueThisWeek`).
 *
 * They are DISPOSABLE: nothing in the books depends on them (what came of an enquiry is in the books as its quotation, order or invoice). A
 * task can be deleted at any time, one closed (done, won or lost) is deleted a week after it was closed, and nothing about them is kept in
 * the audit log.
 */

export const TASK_KINDS = ['task', 'enquiry'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_STATUSES = { task: ['open', 'done'], enquiry: ['new', 'working', 'quoted', 'won', 'lost'] } as const;
export type TaskStatus = (typeof TASK_STATUSES)[TaskKind][number];
/** A status after which there is nothing more to do: it leaves the list a week later. */
export const isClosedStatus = (s: string): boolean => s === 'done' || s === 'won' || s === 'lost';
export const TASK_SOURCES = ['typed', 'gmail', 'assistant'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export interface TaskNote {
  /** When it was written (ISO timestamp). */
  readonly at: string;
  /** Who wrote it (their email, as the list shows it). */
  readonly by: string;
  readonly text: string;
}

export interface Task {
  readonly id: string;
  readonly kind: TaskKind;
  readonly title: string;
  readonly status: TaskStatus;
  /** Whom it is for: a user of the company (their id), or nobody yet. */
  readonly assignee?: string | undefined;
  readonly dueDate?: LocalDate | undefined;
  readonly source: TaskSource;
  /** A task made from a mail: the link that opens it in Gmail. */
  readonly mailLink?: string | undefined;
  readonly notes: readonly TaskNote[];
  readonly createdAt: string;
  readonly createdBy: string;
  /** When it was closed (done, won or lost). */
  readonly doneAt?: string | undefined;
}

/** Someone a task can be for: the owner or the company's one extra user. */
export interface TaskPerson {
  readonly id: string;
  readonly email: string;
  readonly role: string;
}

export interface TaskList {
  readonly tasks: readonly Task[];
  readonly people: readonly TaskPerson[];
}

const text = (max: number) => z.string().trim().min(1).max(max);
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const mailLink = z.string().max(300).regex(/^https:\/\/mail\.google\.com\//, 'A mail link opens in Gmail');

/** What can be done to the list. Every change is one of these, checked the same way in the browser's books and in the database. */
export const taskCommandSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    id: z.string().uuid(),
    kind: z.enum(TASK_KINDS),
    title: text(200),
    assignee: z.string().uuid().nullable().optional(),
    dueDate: dateText.nullable().optional(),
    source: z.enum(TASK_SOURCES).optional(),
    mailLink: mailLink.optional(),
    note: text(500).optional(),
  }),
  z.object({
    op: z.literal('update'),
    id: z.string().uuid(),
    title: text(200).optional(),
    status: z.string().optional(),
    assignee: z.string().uuid().nullable().optional(),
    dueDate: dateText.nullable().optional(),
  }),
  z.object({ op: z.literal('note'), id: z.string().uuid(), text: text(500) }),
  z.object({ op: z.literal('delete'), id: z.string().uuid() }),
]);
export type TaskCommand = z.output<typeof taskCommandSchema>;

/**
 * One command applied to the list (the browser's own books; the database's task_apply does the same): a new task starts open (an enquiry,
 * new), its first note if one came with it; a status must be one of its kind's, and closing it stamps when; a note is dated and signed.
 */
export function applyTask(list: TaskList, input: unknown, who: { id: string; email: string }, now: string): Result<TaskList> {
  const parsed = taskCommandSchema.safeParse(input);
  if (!parsed.success) return fail(issue(IssueCode.SchemaInvalid, parsed.error.issues[0]?.message ?? 'Not a task change', parsed.error.issues[0]?.path.join('.')));
  const cmd = parsed.data;
  const person = (id: string | null | undefined) => id === undefined || id === null || list.people.some((p) => p.id === id);
  if ('assignee' in cmd && !person(cmd.assignee)) return fail(issue(IssueCode.SchemaInvalid, 'A task is for someone of this company', 'assignee'));
  if (cmd.op === 'create') {
    if (list.tasks.some((t) => t.id === cmd.id)) return fail(issue(IssueCode.IdempotencyConflict, 'That task already exists', 'id'));
    const task: Task = {
      id: cmd.id,
      kind: cmd.kind,
      title: cmd.title,
      status: cmd.kind === 'task' ? 'open' : 'new',
      // for whoever adds it, unless someone else is named (null: nobody yet)
      ...(cmd.assignee === undefined ? { assignee: who.id } : cmd.assignee ? { assignee: cmd.assignee } : {}),
      ...(cmd.dueDate ? { dueDate: cmd.dueDate as LocalDate } : {}),
      source: cmd.source ?? 'typed',
      ...(cmd.mailLink ? { mailLink: cmd.mailLink } : {}),
      notes: cmd.note ? [{ at: now, by: who.email, text: cmd.note }] : [],
      createdAt: now,
      createdBy: who.id,
    };
    return ok({ ...list, tasks: [...list.tasks, task] });
  }
  const t = list.tasks.find((x) => x.id === cmd.id);
  if (!t) return fail(issue(IssueCode.MasterNotFound, 'No such task', 'id'));
  if (cmd.op === 'delete') return ok({ ...list, tasks: list.tasks.filter((x) => x.id !== t.id) });
  let next: Task;
  if (cmd.op === 'note') next = { ...t, notes: [...t.notes, { at: now, by: who.email, text: cmd.text }] };
  else {
    if (cmd.status !== undefined && !(TASK_STATUSES[t.kind] as readonly string[]).includes(cmd.status)) {
      return fail(issue(IssueCode.SchemaInvalid, `A ${t.kind} is ${TASK_STATUSES[t.kind].join(', ')}`, 'status'));
    }
    const status = (cmd.status ?? t.status) as TaskStatus;
    const { assignee: _a, dueDate: _d, doneAt: _x, ...rest } = t;
    const assignee = cmd.assignee === undefined ? t.assignee : (cmd.assignee ?? undefined);
    const dueDate = cmd.dueDate === undefined ? t.dueDate : ((cmd.dueDate ?? undefined) as LocalDate | undefined);
    const doneAt = isClosedStatus(status) ? (isClosedStatus(t.status) ? t.doneAt : now) : undefined;
    next = { ...rest, title: cmd.title ?? t.title, status, ...(assignee ? { assignee } : {}), ...(dueDate ? { dueDate } : {}), ...(doneAt ? { doneAt } : {}) };
  }
  return ok({ ...list, tasks: list.tasks.map((x) => (x.id === t.id ? next : x)) });
}

/** The list without what was closed more than a week ago: those are deleted, not kept. */
export function withoutExpired(list: TaskList, now: string): TaskList {
  const weekAgo = new Date(Date.parse(now) - 7 * 86_400_000).toISOString();
  return { ...list, tasks: list.tasks.filter((t) => !isClosedStatus(t.status) || (t.doneAt ?? now) >= weekAgo) };
}

/** What the Gateway lists: everything open, and what was closed in the last week — tasks by due date (none last), then enquiries. */
export function tasksToShow(list: TaskList, now: string): { readonly tasks: readonly Task[]; readonly enquiries: readonly Task[] } {
  const weekAgo = new Date(Date.parse(now) - 7 * 86_400_000).toISOString();
  const shown = list.tasks.filter((t) => !isClosedStatus(t.status) || (t.doneAt ?? now) >= weekAgo);
  const byDue = (a: Task, b: Task) => (isClosedStatus(a.status) !== isClosedStatus(b.status) ? (isClosedStatus(a.status) ? 1 : -1) : (a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : (a.dueDate ?? '9999') > (b.dueDate ?? '9999') ? 1 : a.createdAt < b.createdAt ? -1 : 1);
  return { tasks: shown.filter((t) => t.kind === 'task').sort(byDue), enquiries: shown.filter((t) => t.kind === 'enquiry').sort(byDue) };
}

/**
 * What needs attention this week, read from the books (the same reading the daily report mails), in three short lists: order lines to
 * DELIVER (late, or due within the week), money to COLLECT (customers overdue), and bills to PAY. The Gateway lays each out as a table.
 */
export interface DueThisWeek {
  readonly deliver: readonly { readonly number: string; readonly custPo: string; readonly party: string; readonly item: string; readonly qty: string; readonly dueDate: LocalDate; readonly daysLate: number }[];
  readonly collect: readonly { readonly party: string; readonly amount: bigint; readonly days: number }[];
  readonly pay: readonly { readonly party: string; readonly ref: string; readonly amount: bigint; readonly dueDate: LocalDate; readonly late: boolean }[];
}

export function dueThisWeek(args: { vouchers: readonly Voucher[]; lines: readonly JournalLine[]; masters: Masters; orders: OrderBook; asOn: LocalDate }): DueThisWeek {
  const d = dailyDigest({ ...args, inboxWaiting: 0 });
  return {
    deliver: d.orders.lines.map((l) => ({ number: l.number, custPo: l.custPo, party: l.party, item: l.item, qty: l.pending, dueDate: l.dueDate, daysLate: l.overdue ? l.daysLate : 0 })),
    collect: d.receivables.topOverdue.map((r) => ({ party: r.name, amount: r.overdue, days: r.oldestDays })),
    pay: d.payablesDue.bills.map((b) => ({ party: b.party, ref: b.ref, amount: b.pending, dueDate: b.dueDate, late: b.dueDate < args.asOn })),
  };
}
