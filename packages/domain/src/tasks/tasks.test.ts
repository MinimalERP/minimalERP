import { describe, expect, it } from 'vitest';
import { IssueCode } from '../errors';
import { type TaskList, applyTask, tasksToShow, withoutExpired } from './tasks';

const me = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@x.in' };
const other = { id: '22222222-2222-4222-8222-222222222222', email: 'user@x.in', role: 'member' };
const empty: TaskList = { tasks: [], people: [{ ...me, role: 'owner' }, other] };
const id = '33333333-3333-4333-8333-333333333333';
const at = '2026-09-27T10:00:00.000Z';

const must = (r: ReturnType<typeof applyTask>) => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
};

describe('tasks', () => {
  it('a new task is open and for whoever adds it; an enquiry starts New with its first note', () => {
    const l = must(applyTask(empty, { op: 'create', id, kind: 'task', title: 'Call Kumar' }, me, at));
    expect(l.tasks[0]).toMatchObject({ status: 'open', assignee: me.id, source: 'typed', notes: [] });
    const e = must(applyTask(empty, { op: 'create', id, kind: 'enquiry', title: 'Honeywell', note: 'drawing received', assignee: other.id }, me, at));
    expect(e.tasks[0]).toMatchObject({ status: 'new', assignee: other.id, notes: [{ at, by: me.email, text: 'drawing received' }] });
  });

  it('only a status of its kind; closing stamps when, and it leaves the list a week later', () => {
    const l = must(applyTask(empty, { op: 'create', id, kind: 'enquiry', title: 'Eclipse flange' }, me, at));
    const bad = applyTask(l, { op: 'update', id, status: 'done' }, me, at);
    expect(bad.ok ? [] : bad.issues.map((i) => i.code)).toContain(IssueCode.SchemaInvalid);
    const won = must(applyTask(l, { op: 'update', id, status: 'won' }, me, at));
    expect(won.tasks[0]?.doneAt).toBe(at);
    expect(tasksToShow(won, '2026-10-01T00:00:00.000Z').enquiries).toHaveLength(1);
    expect(tasksToShow(won, '2026-10-05T00:00:00.000Z').enquiries).toHaveLength(0);
    const reopened = must(applyTask(won, { op: 'update', id, status: 'working' }, me, at));
    expect(reopened.tasks[0]?.doneAt).toBeUndefined();
  });

  it('a task is for someone of the company; a note is dated and signed', () => {
    const stranger = applyTask(empty, { op: 'create', id, kind: 'task', title: 'x', assignee: '44444444-4444-4444-8444-444444444444' }, me, at);
    expect(stranger.ok).toBe(false);
    const l = must(applyTask(empty, { op: 'create', id, kind: 'task', title: 'x' }, me, at));
    const noted = must(applyTask(l, { op: 'note', id, text: 'rang, no answer' }, me, '2026-09-28T09:00:00.000Z'));
    expect(noted.tasks[0]?.notes).toEqual([{ at: '2026-09-28T09:00:00.000Z', by: me.email, text: 'rang, no answer' }]);
  });

  it('disposable: deleted at any time, and a closed one is gone a week after it closed', () => {
    const l = must(applyTask(empty, { op: 'create', id, kind: 'task', title: 'x' }, me, at));
    expect(must(applyTask(l, { op: 'delete', id }, me, at)).tasks).toHaveLength(0);
    const done = must(applyTask(l, { op: 'update', id, status: 'done' }, me, at));
    expect(withoutExpired(done, '2026-10-03T00:00:00.000Z').tasks).toHaveLength(1);
    expect(withoutExpired(done, '2026-10-05T00:00:00.000Z').tasks).toHaveLength(0);
  });
});
