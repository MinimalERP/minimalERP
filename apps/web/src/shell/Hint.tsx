import { Kbd } from '../ui/Kbd';
import { useServices, useSubscriptions } from './hooks';

/**
 * A shortcut hint you can also CLICK: the key caps and what they do, as a button that runs the same command in the same place the key
 * would (the bottom bar, the footers of dialogs). `also` is a second command shown before it (↑ ↓ pairs). Not a tab stop — the keyboard has the key —
 * and pressing it never takes the cursor out of the field being edited.
 */
export function Hint({ command, also, fallback, children }: { command: string; also?: string; fallback?: string; children: preact.ComponentChildren }) {
  const { registry, scopes, keymapStore } = useServices();
  useSubscriptions(keymapStore);
  const chord = keymapStore.keymap.chordsFor(command)[0] ?? fallback;
  const other = also ? keymapStore.keymap.chordsFor(also)[0] : undefined;
  if (!chord) return null;
  return (
    <button
      type="button"
      class="hint-btn"
      data-command={command}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const active = scopes.snapshot();
        registry.dispatch(command, { scopes: active.ids, modal: active.modal });
      }}
    >
      {other && <Kbd chord={other} />}
      <Kbd chord={chord} />
      <span>{children}</span>
    </button>
  );
}
