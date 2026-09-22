import { useEffect, useRef, useState } from 'preact/hooks';
import { useCommandHandler, useScope, useServices, useSubscriptions } from '../shell/hooks';
import { Kbd } from '../ui/Kbd';

const SCOPE = 'overlay:series-advance';

/**
 * The manual override of a numbering series' next number (ADR-0021): type any whole number, forward only. Pre-filled with the
 * current value, so accepting with nothing typed is a no-op — "continue from the last made number." A jump of more than one
 * shows how many numbers it skips, informationally; it is not blocked, since a real reason to jump (matching a legacy system,
 * a paper register) often is more than one. The server has the final, authoritative word (a concurrent post could move the
 * current value between opening this and pressing Accept) — its refusal, if any, is shown the same way as a local one.
 */
export function SeriesAdvanceDialog({ current, onDone }: { readonly current: number; readonly onDone: (value: number | undefined) => void }) {
  const { keymapStore } = useServices();
  useSubscriptions(keymapStore);
  useScope(SCOPE, 'overlay', true);
  const [text, setText] = useState(String(current));
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = text.trim();
  const parsed = /^[0-9]+$/.test(trimmed) ? Number(trimmed) : undefined;
  const gap = parsed !== undefined ? parsed - current : undefined;

  const apply = () => {
    if (parsed === undefined || parsed < 1) {
      setError('Enter a whole number, 1 or more');
      return;
    }
    if (parsed < current) {
      setError(`The next number cannot go before ${current} — number ${current - 1} may already be issued`);
      return;
    }
    onDone(parsed);
  };

  useCommandHandler(SCOPE, 'nav.activate', () => (apply(), true));
  useCommandHandler(SCOPE, 'voucher.accept', () => (apply(), true));
  useCommandHandler(SCOPE, 'app.back', () => (onDone(undefined), true));

  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];

  return (
    <div class="overlay-backdrop" data-testid="series-advance-backdrop">
      <div class="palette dialog" role="dialog" aria-modal="true" aria-label="Next number" data-testid="series-advance-dialog">
        <h2 class="dialog-title">Next number</h2>
        <div class="dialog-body">
          <div class="field-row active">
            <label class="field-label" for="series-next">
              Next number
            </label>
            <div class="field-control">
              <input
                ref={inputRef}
                id="series-next"
                data-testid="series-next-input"
                class={error ? 'field-input invalid' : 'field-input'}
                type="text"
                inputMode="numeric"
                autocomplete="off"
                spellcheck={false}
                value={text}
                onInput={(e) => {
                  setText((e.target as HTMLInputElement).value);
                  setError(undefined);
                }}
              />
              {error && (
                <span class="field-error" role="alert" data-testid="series-advance-error">
                  {error}
                </span>
              )}
              {!error && gap !== undefined && gap > 1 && parsed !== undefined && (
                <span class="field-hint" data-testid="series-gap-hint">
                  This will skip {gap - 1} number{gap - 1 === 1 ? '' : 's'} ({current} through {parsed - 1}).
                </span>
              )}
              {!error && gap === 0 && <span class="field-hint">Continues from the last made number — nothing changes.</span>}
            </div>
          </div>
        </div>
        <div class="palette-foot">
          <span>
            <Kbd chord={chord('voucher.accept') ?? 'Ctrl+A'} /> apply
          </span>
          <span>
            <Kbd chord="Esc" /> cancel
          </span>
        </div>
      </div>
    </div>
  );
}
