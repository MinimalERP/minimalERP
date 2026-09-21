import type { Frame } from '@minimalerp/command';
import { useEffect, useState } from 'preact/hooks';
import { Kbd } from '../ui/Kbd';
import { ListView } from '../ui/ListView';
import { useCommandHandler, useFrameState, useListNavigation, useServices, useSubscriptions } from '../shell/hooks';
import type { ScreenRef } from '../shell/router';

const SCOPE = 'screen:settings-keyboard';

type Message = { readonly kind: 'info' | 'error'; readonly text: string };

/**
 * Every configurable shortcut, editable from the keyboard: arrows to pick a row, Enter to record a new
 * key (the KeyboardManager captures it — this screen has no key listener), Delete to remove,
 * Ctrl+Delete to restore the default. Changes apply immediately and persist.
 */
export function KeymapSettingsScreen({ frame }: { frame: Frame<ScreenRef> }) {
  const { registry, keymapStore, keyboard } = useServices();
  useSubscriptions(registry, keymapStore);
  const [index, setIndex] = useFrameState(frame, 'index', 0);
  const [capturing, setCapturing] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<Message | undefined>(undefined);

  const rows = registry
    .all()
    .filter((c) => c.configurable ?? !c.hidden)
    .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  const safeIndex = Math.min(index, Math.max(0, rows.length - 1));
  const current = rows[safeIndex];

  useEffect(() => () => keyboard.cancelCapture(), [keyboard]);

  const change = async (i = safeIndex) => {
    const command = rows[i];
    if (!command || keyboard.capturing) return;
    setIndex(i);
    setCapturing(command.id);
    setMessage(undefined);
    const chord = await keyboard.captureNext();
    setCapturing(undefined);
    if (!chord) {
      setMessage({ kind: 'info', text: 'Cancelled — nothing changed.' });
      return;
    }
    const result = keymapStore.assign(command.id, chord);
    if (result.ok) {
      setMessage({ kind: 'info', text: `${command.title} is now ${result.chord}.` });
    } else {
      const other = result.conflictWith ? (registry.get(result.conflictWith)?.title ?? result.conflictWith) : undefined;
      setMessage({
        kind: 'error',
        text: other
          ? `${chord} is already used by “${other}”. Remove that shortcut first, or choose another key.`
          : result.message,
      });
    }
  };

  useListNavigation(SCOPE, { count: rows.length, index: safeIndex, setIndex, onActivate: (i) => void change(i) });
  useCommandHandler(SCOPE, 'keymap.change', () => {
    void change();
    return true;
  });
  useCommandHandler(SCOPE, 'keymap.unbind', () => {
    if (!current) return false;
    keymapStore.unbind(current.id);
    setMessage({ kind: 'info', text: `${current.title} has no shortcut now. It is still available from Go To and the Gateway.` });
    return true;
  });
  useCommandHandler(SCOPE, 'keymap.reset', () => {
    if (!current) return false;
    keymapStore.reset(current.id);
    setMessage({ kind: 'info', text: `${current.title} is back to its default.` });
    return true;
  });

  const capturingTitle = capturing ? registry.get(capturing)?.title : undefined;

  return (
    <section class="screen" aria-labelledby="keys-title" data-testid="keymap-screen">
      <h1 id="keys-title">Keyboard Shortcuts</h1>
      <p class="lede">
        Pick a row and press <Kbd chord="Enter" /> to record a new key. <Kbd chord="Delete" /> removes it,{' '}
        <Kbd chord="Ctrl+Delete" /> restores the default. Changes apply immediately.
      </p>

      <div class="toolbar">
        <button
          type="button"
          class="button"
          onClick={() => {
            keymapStore.resetAll();
            setMessage({ kind: 'info', text: 'Every shortcut is back to its default.' });
          }}
        >
          Reset all shortcuts
        </button>
      </div>

      {capturingTitle && (
        <p class="notice capture" role="status" data-testid="capture-prompt">
          Press the new shortcut for <strong>{capturingTitle}</strong> — <Kbd chord="Esc" /> cancels.
        </p>
      )}
      {message && !capturingTitle && (
        <p class={message.kind === 'error' ? 'notice error' : 'notice'} role="status" data-testid="keymap-message">
          {message.text}
        </p>
      )}
      {keymapStore.problems.length > 0 && (
        <p class="notice error" role="alert">
          {keymapStore.problems.length} saved shortcut{keymapStore.problems.length === 1 ? '' : 's'} could not be applied.
        </p>
      )}

      <ListView
        items={rows}
        index={safeIndex}
        itemKey={(c) => c.id}
        label="Keyboard shortcuts"
        onActivate={(i) => void change(i)}
        renderItem={(c) => {
          const chords = keymapStore.keymap.chordsFor(c.id);
          return (
            <>
              <span class="row-title">{c.title}</span>
              <span class="row-kind">{c.category}</span>
              <span class="row-meta" data-command={c.id}>
                {capturing === c.id ? (
                  <span class="badge">press a key…</span>
                ) : chords.length > 0 ? (
                  chords.map((chord) => <Kbd key={chord} chord={chord} />)
                ) : (
                  <span class="unassigned">no shortcut</span>
                )}
                {keymapStore.isCustomised(c.id) && <span class="badge custom">customised</span>}
                {c.badge && <span class="badge">{c.badge}</span>}
              </span>
            </>
          );
        }}
      />
    </section>
  );
}
