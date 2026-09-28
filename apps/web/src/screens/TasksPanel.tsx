import { type LocalDate, type Task, type TaskKind, type TaskList, type WebsiteEnquiryList, TASK_STATUSES, dueThisWeek, isClosedStatus, tasksToShow } from '@minimalerp/domain';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useCommandHandler, useScope, useServices, useSubscriptions } from '../shell/hooks';
import { defaultDate } from '../vouchers/entryHelpers';
import { formatAmount, formatDate, parseDateInput } from '../vouchers/format';

const SCOPE = 'overlay:task-dialog';
/** Each list of what is due shows at most this many rows (the most urgent first). */
const DUE_SHOWN = 5;
const short = (d: string) => formatDate(d).replace(/-20(\d\d)$/, '');

const STATUS_WORDS: Readonly<Record<string, string>> = { open: 'Open', done: 'Done', new: 'New', working: 'Working', quoted: 'Quoted', won: 'Won', lost: 'Lost' };

/**
 * The Gateway's tasks: what is due this week (read from the books every time — orders to deliver, money overdue, bills to pay), the tasks
 * of the owner and the company's user, and the project enquiries with what is being done on each. A click opens a task to change it, add
 * a note or delete it; the box ticks a task done. They are disposable: a closed one is deleted a week later, and nothing in the books
 * depends on them.
 */
export function TasksPanel() {
  const { books: host, app } = useServices();
  useSubscriptions(host);
  const books = host.current;
  const [list, setList] = useState<TaskList | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<{ kind: TaskKind; task?: Task } | undefined>(undefined);
  const [website, setWebsite] = useState<WebsiteEnquiryList | undefined>(undefined);

  useEffect(() => {
    if (!books) return;
    void host.tasks().then((r) => (r.ok ? setList(r.value) : setError(r.issues[0]?.message)));
    void host.websiteEnquiries().then((r) => setWebsite(r.ok ? r.value : undefined));
  }, [books?.companyId]);

  const due = useMemo(
    () => (books ? dueThisWeek({ vouchers: books.vouchers, lines: books.lines, masters: books.masters, orders: books.orders, asOn: defaultDate(books.masters) as LocalDate }) : undefined),
    [books, books?.vouchers],
  );
  if (!books) return null;

  const change = async (c: unknown): Promise<string | undefined> => {
    const r = await host.applyTask(c as never);
    if (!r.ok) return r.issues[0]?.message ?? 'Not saved';
    setList(r.value);
    return undefined;
  };
  const shown = list ? tasksToShow(list, new Date().toISOString()) : undefined;
  const who = (id: string | undefined) => (id ? (list?.people.find((p) => p.id === id)?.email ?? '') : '');
  const openOrder = (number: string | undefined) => {
    const v = number ? books.vouchers.find((x) => x.number === number) : undefined;
    if (v) app.navigate({ type: 'voucher', mode: 'display', id: v.id });
  };

  return (
    <aside class="tasks-panel" aria-label="Tasks" data-testid="tasks-panel">
      <div class="tasks-head">
        <h2>Tasks</h2>
        <button type="button" class="button" data-testid="task-new" onClick={() => setOpen({ kind: 'task' })}>
          + Task
        </button>
        <button type="button" class="button" data-testid="enquiry-new" onClick={() => setOpen({ kind: 'enquiry' })}>
          + Enquiry
        </button>
      </div>

      <h3>This week</h3>
      {due && due.deliver.length + due.collect.length + due.pay.length === 0 && <p class="tasks-empty">Nothing to deliver, collect or pay this week.</p>}
      {due && due.deliver.length > 0 && (
        <DueTable title="Deliver" count={due.deliver.length} testid="due-deliver" head={['Due', 'Customer', 'Item', 'Qty', '']}>
          {due.deliver.slice(0, DUE_SHOWN).map((d, i) => (
            <tr key={i} class="clickable" title={`${d.number}${d.custPo ? ` · PO ${d.custPo}` : ''} — open the order`} onClick={() => openOrder(d.number)}>
              <td>{short(d.dueDate)}</td>
              <td>{d.party}</td>
              <td>{d.item}</td>
              <td class="num">{d.qty}</td>
              <td class="num">{d.daysLate > 0 && <span class="late-tag">{d.daysLate}d late</span>}</td>
            </tr>
          ))}
        </DueTable>
      )}
      {due && due.collect.length > 0 && (
        <DueTable title="Collect" count={due.collect.length} testid="due-collect" head={['Customer', 'Overdue', '']}>
          {due.collect.slice(0, DUE_SHOWN).map((c, i) => (
            <tr key={i}>
              <td>{c.party}</td>
              <td class="num">₹{formatAmount(c.amount)}</td>
              <td class="num">
                <span class="late-tag">{c.days}d</span>
              </td>
            </tr>
          ))}
        </DueTable>
      )}
      {due && due.pay.length > 0 && (
        <DueTable title="Pay" count={due.pay.length} testid="due-pay" head={['Due', 'Supplier', 'Bill', 'Amount']}>
          {due.pay.slice(0, DUE_SHOWN).map((b, i) => (
            <tr key={i}>
              <td>{b.late ? <span class="late-tag">{short(b.dueDate)}</span> : short(b.dueDate)}</td>
              <td>{b.party}</td>
              <td>{b.ref}</td>
              <td class="num">₹{formatAmount(b.amount)}</td>
            </tr>
          ))}
        </DueTable>
      )}

      <h3>Tasks</h3>
      {error && <p class="notice error">{error}</p>}
      {shown && shown.tasks.length === 0 && <p class="tasks-empty">No tasks. + Task adds one.</p>}
      <ul class="tasks-list" data-testid="task-list">
        {shown?.tasks.map((t) => (
          <li key={t.id} class={isClosedStatus(t.status) ? 'done' : ''}>
            <input type="checkbox" aria-label={`Done: ${t.title}`} checked={t.status === 'done'} onChange={() => void change({ op: 'update', id: t.id, status: t.status === 'done' ? 'open' : 'done' })} />
            <button type="button" class="link" onClick={() => setOpen({ kind: 'task', task: t })}>
              {t.title}
            </button>
            <span class="tasks-meta">
              {[t.dueDate ? formatDate(t.dueDate) : '', who(t.assignee), t.source !== 'typed' ? t.source : ''].filter(Boolean).join(' · ')}
              {t.mailLink && (
                <>
                  {' '}
                  <a href={t.mailLink} target="_blank" rel="noopener">
                    mail ↗
                  </a>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>

      {website?.site && (
        <p class="tasks-meta" data-testid="website-enquiries-count">
          <button type="button" class="link" onClick={() => app.navigate({ type: 'website-enquiries' })}>
            Website enquiries
          </button>
          {`: ${website.enquiries.filter((e) => e.status === 'new').length} new`}
        </p>
      )}
      <h3>Enquiries</h3>
      {shown && shown.enquiries.length === 0 && <p class="tasks-empty">No enquiries. + Enquiry adds one.</p>}
      <ul class="tasks-list" data-testid="enquiry-list">
        {shown?.enquiries.map((t) => (
          <li key={t.id} class={isClosedStatus(t.status) ? 'done' : ''}>
            <button type="button" class="link" onClick={() => setOpen({ kind: 'enquiry', task: t })}>
              {t.title}
            </button>
            <span class="tasks-meta">
              <strong>{STATUS_WORDS[t.status]}</strong>
              {t.notes.length > 0 && ` · ${formatDate(t.notes.at(-1)!.at.slice(0, 10))} “${t.notes.at(-1)!.text}”`}
            </span>
          </li>
        ))}
      </ul>

      {open && list && (
        <TaskDialog
          kind={open.kind}
          task={open.task}
          people={list.people}
          today={defaultDate(books.masters)}
          onChange={change}
          onClose={() => setOpen(undefined)}
        />
      )}
    </aside>
  );
}

/** One of the week's lists: a heading with how many there are, a compact table of the first few, and how many more. */
function DueTable({ title, count, head, testid, children }: { title: string; count: number; head: readonly string[]; testid: string; children: preact.ComponentChildren }) {
  return (
    <div class="due-block" data-testid={testid}>
      <div class="due-title">
        {title} <span class="tasks-meta">({count})</span>
      </div>
      <table class="due-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} class={h === 'Qty' || h === 'Overdue' || h === 'Amount' ? 'num' : ''}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {count > DUE_SHOWN && <div class="tasks-meta">+{count - DUE_SHOWN} more</div>}
    </div>
  );
}

/** A task or enquiry to add or change: its title, whom it is for, when it is due, its status, and its notes (a new one is added below). */
function TaskDialog(props: {
  kind: TaskKind;
  task: Task | undefined;
  people: TaskList['people'];
  today: string;
  onChange: (c: unknown) => Promise<string | undefined>;
  onClose: () => void;
}) {
  useScope(SCOPE, 'overlay', true);
  useCommandHandler(SCOPE, 'app.back', () => (props.onClose(), true));
  const t = props.task;
  const [title, setTitle] = useState(t?.title ?? '');
  const [assignee, setAssignee] = useState(t ? (t.assignee ?? '') : '');
  const [dueText, setDueText] = useState(t?.dueDate ? formatDate(t.dueDate) : '');
  const [status, setStatus] = useState<string>(t?.status ?? (props.kind === 'task' ? 'open' : 'new'));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  /** Delete asks once more: a deleted task is gone for good. */
  const [deleting, setDeleting] = useState(false);
  const word = props.kind === 'task' ? 'task' : 'enquiry';

  const remove = async () => {
    if (!t) return;
    if (!deleting) return setDeleting(true);
    const problem = await props.onChange({ op: 'delete', id: t.id });
    if (problem) return setError(problem);
    props.onClose();
  };

  const save = async () => {
    const dueDate = dueText.trim() === '' ? null : parseDateInput(dueText, { start: props.today, end: `${Number(props.today.slice(0, 4)) + 3}${props.today.slice(4)}`, base: props.today });
    if (dueDate === undefined) return setError('That is not a date — try 10, 10-5 or 10-5-26');
    if (title.trim() === '') return setError(`Write what the ${word} is`);
    const id = t?.id ?? crypto.randomUUID();
    const problem = t
      ? await props.onChange({ op: 'update', id, title: title.trim(), status, assignee: assignee || null, dueDate })
      : await props.onChange({ op: 'create', id, kind: props.kind, title: title.trim(), ...(assignee ? { assignee } : {}), dueDate, ...(note.trim() ? { note: note.trim() } : {}) });
    if (problem) return setError(problem);
    if (t && note.trim()) {
      const p2 = await props.onChange({ op: 'note', id, text: note.trim() });
      if (p2) return setError(p2);
    }
    props.onClose();
  };

  return (
    <div class="overlay-backdrop">
      <div class="palette dialog task-dialog" role="dialog" aria-modal="true" aria-label={t ? t.title : `New ${word}`} data-testid="task-dialog">
        <h2 class="dialog-title">{t ? `${props.kind === 'task' ? 'Task' : 'Enquiry'}: ${t.title}` : `New ${word}`}</h2>
        <div class="dialog-body">
          <label class="field-row">
            <span class="field-label">{props.kind === 'task' ? 'Task' : 'Enquiry'}</span>
            <input class="field-input" autoFocus value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} aria-label="Title" />
          </label>
          <label class="field-row">
            <span class="field-label">For</span>
            <select class="field-input" value={assignee} onChange={(e) => setAssignee((e.target as HTMLSelectElement).value)} aria-label="For">
              {!t && <option value="">Me</option>}
              {t && <option value="">Nobody yet</option>}
              {props.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.email}
                </option>
              ))}
            </select>
          </label>
          <label class="field-row">
            <span class="field-label">Due</span>
            <input class="field-input" value={dueText} placeholder="none" onInput={(e) => setDueText((e.target as HTMLInputElement).value)} aria-label="Due" />
          </label>
          {t && (
            <label class="field-row">
              <span class="field-label">Status</span>
              <select class="field-input" value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)} aria-label="Status">
                {TASK_STATUSES[props.kind].map((s) => (
                  <option key={s} value={s}>
                    {STATUS_WORDS[s]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {t && t.notes.length > 0 && (
            <ul class="task-notes" data-testid="task-notes">
              {t.notes.map((n, i) => (
                <li key={i}>
                  <span class="tasks-meta">
                    {formatDate(n.at.slice(0, 10))} · {n.by}
                  </span>{' '}
                  {n.text}
                </li>
              ))}
            </ul>
          )}
          <label class="field-row">
            <span class="field-label">Note</span>
            <input class="field-input" value={note} placeholder={t ? 'what was done (optional)' : 'optional'} onInput={(e) => setNote((e.target as HTMLInputElement).value)} aria-label="Note" />
          </label>
          {t?.mailLink && (
            <p>
              <a href={t.mailLink} target="_blank" rel="noopener">
                Open the mail ↗
              </a>
            </p>
          )}
          {error && (
            <p class="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div class="palette-foot">
          {t && (
            <button type="button" class="button" data-testid="task-delete" onClick={() => void remove()}>
              {deleting ? 'Delete for good?' : 'Delete'}
            </button>
          )}
          <button type="button" class="button" data-testid="task-save" onClick={() => void save()}>
            Save
          </button>
          <button type="button" class="button" onClick={props.onClose}>
            Close (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}
