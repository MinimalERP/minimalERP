import { useServices } from './hooks';

/**
 * The × at the right of a window's title bar: the mouse's way to close it. It does exactly what the panel's Close does — a window with
 * something entered still asks "Close and leave?" first. Not a tab stop: the keyboard has Esc.
 */
export function WindowClose() {
  const { registry, scopes } = useServices();
  return (
    <button
      type="button"
      class="win-x"
      data-testid="window-close"
      aria-label="Close window"
      title="Close (Esc)"
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const active = scopes.snapshot();
        registry.dispatch('app.close', { scopes: active.ids, modal: active.modal });
      }}
    >
      ×
    </button>
  );
}
