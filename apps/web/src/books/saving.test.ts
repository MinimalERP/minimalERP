import { type Result, fail, issue, ok } from '@minimalerp/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_FAILED, SAVED_FOR_MS, SHOW_AFTER_MS, SaveTracker } from './saving';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A save that finishes after `ms`, with `result`. */
const after = <T>(ms: number, result: Result<T>) => () => new Promise<Result<T>>((resolve) => setTimeout(() => resolve(result), ms));
const phases = (t: SaveTracker) => {
  const seen: string[] = [];
  t.subscribe(() => seen.push(t.view.phase));
  return seen;
};

describe('a quick save', () => {
  it('shows nothing at all, and never blocks: the books kept in the browser save in milliseconds', async () => {
    const t = new SaveTracker();
    const seen = phases(t);
    const done = t.track(after(5, ok('fine')));
    expect(t.blocking).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    expect(await done).toEqual(ok('fine'));
    await vi.advanceTimersByTimeAsync(SAVED_FOR_MS * 2);
    expect(seen).toEqual([]); // no phase ever changed
    expect(t.view.phase).toBe('idle');
  });

  it('a refusal is not put on the panel: the form beneath already shows it', async () => {
    const t = new SaveTracker();
    const refused = fail(issue('DUPLICATE_NAME', 'That name is taken', 'name'));
    const done = t.track(after(5, refused));
    await vi.advanceTimersByTimeAsync(5);
    expect(await done).toBe(refused);
    expect(t.view.phase).toBe('idle');
  });
});

describe('a slow save', () => {
  it('shows "saving" only once it has been pending for a moment, and blocks from then on', async () => {
    const t = new SaveTracker();
    const done = t.track(after(1000, ok(1)));
    await vi.advanceTimersByTimeAsync(SHOW_AFTER_MS - 1);
    expect(t.view.phase).toBe('idle');
    expect(t.blocking).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.view.phase).toBe('saving');
    expect(t.blocking).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
  });

  it('then says "saved" without blocking, and clears itself after a short while — and the caller never waited for that', async () => {
    const t = new SaveTracker();
    const done = t.track(after(500, ok(1)));
    await vi.advanceTimersByTimeAsync(500);
    expect(await done).toEqual(ok(1)); // the caller has its result at once
    expect(t.view.phase).toBe('saved');
    expect(t.blocking).toBe(false); // and can carry on typing
    await vi.advanceTimersByTimeAsync(SAVED_FOR_MS);
    expect(t.view.phase).toBe('idle');
  });

  it('a new save while "saved" is showing takes over from it', async () => {
    const t = new SaveTracker();
    const first = t.track(after(500, ok(1)));
    await vi.advanceTimersByTimeAsync(500);
    await first;
    expect(t.view.phase).toBe('saved');
    const second = t.track(after(500, ok(2)));
    expect(t.view.phase).toBe('idle'); // the old "saved" is gone; the new save is not yet slow
    await vi.advanceTimersByTimeAsync(500);
    await second;
  });
});

describe('a failure', () => {
  const offline = () => fail(issue(REQUEST_FAILED, 'Failed to send a request'));

  it('waits for the person, however quickly it came, and offers Retry', async () => {
    const t = new SaveTracker();
    const done = t.track(async () => offline());
    await vi.advanceTimersByTimeAsync(0);
    expect(t.view).toEqual({ phase: 'failed', message: 'Failed to send a request', canRetry: true });
    expect(t.blocking).toBe(true);
    t.dismiss();
    const r = await done;
    expect(!r.ok && r.issues[0]?.code).toBe(REQUEST_FAILED); // Close: the caller gets the failure
    expect(t.view.phase).toBe('idle');
  });

  it('Retry runs the same save again, and its success is what the caller gets', async () => {
    const t = new SaveTracker();
    const work = vi.fn().mockResolvedValueOnce(offline()).mockResolvedValueOnce(ok('saved second time'));
    const done = t.track(work);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.view.phase).toBe('failed');
    t.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(await done).toEqual(ok('saved second time'));
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('a save that throws is a failed request too', async () => {
    const t = new SaveTracker();
    const done = t.track(async () => {
      throw new Error('socket hang up');
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.view).toMatchObject({ phase: 'failed', message: 'socket hang up', canRetry: true });
    t.dismiss();
    await done;
  });

  it('a business refusal on the panel offers only Close (repeating it cannot succeed)', async () => {
    const t = new SaveTracker();
    const done = t.track(after(500, fail(issue('UNBALANCED', 'Debits and credits differ'))));
    await vi.advanceTimersByTimeAsync(500);
    expect(t.view).toEqual({ phase: 'failed', message: 'Debits and credits differ', canRetry: false });
    t.dismiss();
    const r = await done;
    expect(r.ok).toBe(false);
    expect(t.view.phase).toBe('idle');
  });

  it('is announced to subscribers: saving, then failed, then idle', async () => {
    const t = new SaveTracker();
    const seen = phases(t);
    const done = t.track(after(500, fail(issue(REQUEST_FAILED, 'offline'))));
    await vi.advanceTimersByTimeAsync(500);
    t.dismiss();
    await done;
    expect(seen).toEqual(['saving', 'failed', 'idle']);
  });
});

describe('several saves at once', () => {
  it('the panel stays up until the last one finishes', async () => {
    const t = new SaveTracker();
    const a = t.track(after(400, ok('a')));
    const b = t.track(after(900, ok('b')));
    await vi.advanceTimersByTimeAsync(400);
    await a;
    expect(t.view.phase).toBe('saving');
    await vi.advanceTimersByTimeAsync(500);
    await b;
    expect(t.view.phase).toBe('saved');
  });
});
