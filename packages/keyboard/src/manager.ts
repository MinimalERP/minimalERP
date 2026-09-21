import { type Chord, chordFromEvent, isRepeatable } from './chord';
import type { Keymap } from './keymap';
import type { ScopeStack } from './scopes';

export interface DispatchInfo {
  readonly chord: Chord;
  /** Active scope ids, innermost first. */
  readonly scopes: readonly string[];
  readonly modal: boolean;
}

export interface KeyboardManagerOptions {
  readonly target: EventTarget;
  readonly scopes: ScopeStack;
  /** Read on every keystroke, so keymap edits take effect immediately. */
  readonly keymap: () => Keymap;
  /** Try to run a command. Return true if something handled it (the key is then consumed). */
  readonly dispatch: (commandId: string, info: DispatchInfo) => boolean;
}

/**
 * The ONE keyboard listener in the application (capture phase, so it runs before any element).
 * Everything else declares scopes and command handlers; nothing else attaches shortcut listeners.
 *
 *   keydown → chord → keymap (which commands could this mean in the active scopes?)
 *           → dispatch each in order until one is handled → consume the event
 *
 * A key with no handler is left alone, so ordinary editing (typing, caret movement, Tab between fields
 * before a form takes over) keeps working.
 */
export class KeyboardManager {
  private captureResolver: ((chord: Chord | null) => void) | undefined;

  constructor(private readonly options: KeyboardManagerOptions) {}

  /** Starts listening. Returns the function that stops. */
  start(): () => void {
    const listener = (event: Event) => this.onKeyDown(event as KeyboardEvent);
    this.options.target.addEventListener('keydown', listener, { capture: true });
    return () => this.options.target.removeEventListener('keydown', listener, { capture: true });
  }

  get capturing(): boolean {
    return this.captureResolver !== undefined;
  }

  /**
   * Resolves with the next chord pressed (used by the shortcut editor to record a new key),
   * swallowing it so it triggers nothing. Esc cancels (resolves null). Only one capture at a time.
   */
  captureNext(): Promise<Chord | null> {
    this.cancelCapture();
    return new Promise((resolve) => {
      this.captureResolver = resolve;
    });
  }

  cancelCapture(): void {
    const resolve = this.captureResolver;
    this.captureResolver = undefined;
    resolve?.(null);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing) return; // an IME is mid-composition; the key belongs to it

    const chord = chordFromEvent(e);
    if (this.captureResolver) {
      e.preventDefault();
      e.stopPropagation();
      if (chord === undefined) return; // a modifier on its own: keep waiting for the real key
      const resolve = this.captureResolver;
      this.captureResolver = undefined;
      resolve(chord === 'Esc' ? null : chord);
      return;
    }
    if (chord === undefined) return;

    const { ids, modal } = this.options.scopes.snapshot();
    const bindings = this.options.keymap().bindingsFor(chord, ids);
    if (bindings.length === 0) return;

    // Holding a key fires repeats. Repeating a list-navigation key is wanted; repeating "open Go To" or
    // a browser-reserved key like F5 is not — swallow those without acting again.
    if (e.repeat && !isRepeatable(chord)) {
      e.preventDefault();
      return;
    }

    for (const binding of bindings) {
      if (this.options.dispatch(binding.commandId, { chord, scopes: ids, modal })) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
  }
}
