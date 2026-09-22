import { type Result, fail, issue } from '@minimalerp/domain';

/**
 * What a person sees while a master or voucher is being saved. Every save goes through `track`, so the overlay is the same everywhere and
 * no screen has to remember to show it. It knows nothing about screens, keys or the DOM.
 *
 *   - A save that finishes quickly shows nothing at all (the books kept in this browser save in a few milliseconds: a panel flashing on every
 *     Enter would be noise). Only a save still pending after `SHOW_AFTER_MS` gets the panel, and only then is input blocked.
 *   - It then shows "Saved" briefly. That is not a delay: the save has already finished and its caller already has the result.
 *   - A failure the person can do something about — the request never got an answer (offline, the server down) — waits for them: Retry runs the
 *     same save again (safe: a voucher's id and a master's id make a repeat a replay), Close gives the caller the failure. A business refusal
 *     (a duplicate name, an unbalanced voucher) is shown too, if the panel is already up, but only with Close: repeating it cannot succeed, and
 *     the form beneath already points at the field.
 */

/** The adapter's code for "the request got no business answer" (network down, function crashed). */
export const REQUEST_FAILED = 'REQUEST_FAILED';

export const SHOW_AFTER_MS = 100;
export const SAVED_FOR_MS = 700;

export type SavePhase = 'idle' | 'saving' | 'saved' | 'failed';

export interface SaveView {
  readonly phase: SavePhase;
  /** Why it failed, in words for the person (failed only). */
  readonly message?: string | undefined;
  /** Whether Retry can help (failed only). */
  readonly canRetry: boolean;
}

interface Failure {
  readonly message: string | undefined;
  readonly canRetry: boolean;
  readonly resolve: (choice: 'retry' | 'close') => void;
}

export class SaveTracker {
  private pending = 0;
  private shown = false;
  private savedShowing = false;
  private failure: Failure | undefined;
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private savedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Failures are shown one at a time, in the order they happen. */
  private turn: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  /** What subscribers were last told (see `notify`). */
  private announced = 'idle||false';

  get view(): SaveView {
    if (this.failure) return { phase: 'failed', message: this.failure.message, canRetry: this.failure.canRetry };
    if (this.pending > 0 && this.shown) return { phase: 'saving', canRetry: false };
    if (this.savedShowing) return { phase: 'saved', canRetry: false };
    return { phase: 'idle', canRetry: false };
  }

  /** True while input beneath must not react: the panel is up and the person has nothing to do but wait or choose. */
  get blocking(): boolean {
    const phase = this.view.phase;
    return phase === 'saving' || phase === 'failed';
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Runs one save. Resolves with its result once the person has no more to decide (immediately, unless it failed and the panel asked). */
  async track<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    this.begin();
    let succeeded = false;
    try {
      for (;;) {
        const result = await attempt(work);
        if (result.ok) {
          succeeded = true;
          return result;
        }
        const transport = result.issues.some((i) => i.code === REQUEST_FAILED);
        // A refusal on a save that was quick never reached the panel: the form beneath shows it, as it always did.
        if (!transport && !this.shown) return result;
        const choice = await this.ask(result.issues[0]?.message, transport);
        if (choice === 'retry') continue;
        return result;
      }
    } finally {
      this.end(succeeded);
    }
  }

  /** The person chose Retry on a failure. */
  retry(): void {
    this.failure?.resolve('retry');
  }

  /** The person chose Close on a failure. */
  dismiss(): void {
    this.failure?.resolve('close');
  }

  private begin(): void {
    if (this.pending++ > 0) return;
    this.clearSaved();
    this.showTimer = setTimeout(() => {
      this.showTimer = undefined;
      this.shown = true;
      this.notify();
    }, SHOW_AFTER_MS);
  }

  private end(succeeded: boolean): void {
    if (--this.pending > 0) return;
    if (this.showTimer !== undefined) clearTimeout(this.showTimer);
    this.showTimer = undefined;
    const wasShown = this.shown;
    this.shown = false;
    if (wasShown && succeeded) {
      this.savedShowing = true;
      this.savedTimer = setTimeout(() => this.clearSaved(true), SAVED_FOR_MS);
    }
    this.notify();
  }

  private clearSaved(announce = false): void {
    if (this.savedTimer !== undefined) clearTimeout(this.savedTimer);
    this.savedTimer = undefined;
    if (!this.savedShowing) return;
    this.savedShowing = false;
    if (announce) this.notify();
  }

  /** Puts a failure in front of the person and waits for their choice. */
  private ask(message: string | undefined, canRetry: boolean): Promise<'retry' | 'close'> {
    const asked = this.turn.then(
      () =>
        new Promise<'retry' | 'close'>((resolve) => {
          this.shown = true; // a failure is always shown, however quickly it came
          this.failure = {
            message,
            canRetry,
            resolve: (choice) => {
              this.failure = undefined;
              if (choice === 'close') this.shown = false; // done with the panel: going through "saving" on the way out would flash it
              this.notify();
              resolve(choice);
            },
          };
          this.notify();
        }),
    );
    this.turn = asked;
    return asked;
  }

  /** Tells subscribers, but only when what is shown has changed (a quick save changes nothing, and must not cost a re-render). */
  private notify(): void {
    const v = this.view;
    const key = `${v.phase}|${v.message ?? ''}|${v.canRetry}`;
    if (key === this.announced) return;
    this.announced = key;
    for (const l of [...this.listeners]) l();
  }
}

/** A save that throws is a save that failed to get an answer: the panel treats it like any other request failure. */
async function attempt<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await work();
  } catch (error) {
    return fail(issue(REQUEST_FAILED, error instanceof Error ? error.message : 'The request did not complete'));
  }
}
