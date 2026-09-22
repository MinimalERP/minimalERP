import { useScope, useServices, useSubscriptions } from './hooks';

const SCOPE = 'overlay:saving';

/**
 * What is shown while a master or voucher save is in flight: nothing at first (the books kept in this browser save in milliseconds, and the
 * online books usually answer in about a second — see ADR-0020 — so a panel flashing on every accept would be noise), then, once it has taken
 * a moment, a small panel over everything, blocking input. On success it flashes "Saved" and clears itself; on a failure it waits with a
 * message and Retry/Close. See `books/saving.ts` (`SaveTracker`) for the timing rules this renders.
 *
 * One instance for the whole app (in Shell, like the Go To overlay and "Close and leave?"): every screen's accept goes through the same
 * tracker via `useServices().saving`. While it blocks, a modal scope with no bound commands hides every scope beneath it — including
 * global — so no key reaches the form underneath; Enter on the panel itself only ever runs the button it lands on.
 */
export function SavingOverlay() {
  const { saving } = useServices();
  useSubscriptions(saving);
  const view = saving.view;
  useScope(SCOPE, 'overlay', saving.blocking);

  if (view.phase === 'idle') return null;

  return (
    <div class="overlay-backdrop saving-backdrop" data-testid="saving-overlay">
      <div class="palette dialog saving-panel" role={view.phase === 'failed' ? 'alertdialog' : 'status'} aria-live="polite" aria-modal={view.phase === 'failed' || undefined} data-testid={`saving-${view.phase}`}>
        {view.phase === 'saving' && (
          <>
            <span class="saving-spinner" aria-hidden="true" />
            <span>Saving…</span>
          </>
        )}
        {view.phase === 'saved' && (
          <>
            <span class="saving-icon saving-ok" aria-hidden="true">
              ✓
            </span>
            <span>Saved</span>
          </>
        )}
        {view.phase === 'failed' && (
          <>
            <p class="saving-failed-line">
              <span class="saving-icon saving-bad" aria-hidden="true">
                ✕
              </span>
              <span>Save failed</span>
            </p>
            {view.message && <p class="saving-message">{view.message}</p>}
            <div class="confirm-actions">
              <button type="button" class="button" onClick={() => saving.dismiss()} autoFocus>
                Close
              </button>
              {view.canRetry && (
                <button type="button" class="button" onClick={() => saving.retry()}>
                  Retry
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
