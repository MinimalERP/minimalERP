import { panelEntries } from '@minimalerp/command';
import { Kbd } from '../ui/Kbd';
import { useServices, useSubscriptions } from './hooks';

/** The screens that open at the third level — where a person is entering or reading, and wants the screen's own actions at hand. */
export const PANEL_SCREENS: readonly string[] = ['voucher', 'report', 'master', 'master-list'];

/**
 * The screen's actions, down the right edge — the same commands the keys run, drawn as buttons (Tally's button panel). Derived like the
 * status bar: from the commands' `panel` metadata, the live keymap and what is available right now (greyed when nothing would happen).
 * A click runs the command through the same dispatch as its key, so the screen in front decides what it does.
 *
 * The buttons never take focus (mouse-down is cancelled, they are skipped by Tab): the field being edited keeps its caret and Tab order.
 */
export function ActionPanel() {
  const { scopes, registry, keymapStore, ui, screens } = useServices();
  useSubscriptions(scopes, registry, keymapStore, ui, screens);

  const type = screens.top.screen.type;
  if (!PANEL_SCREENS.includes(type)) return null;
  const active = scopes.snapshot();
  const entries = panelEntries(registry, (id) => keymapStore.keymap.chordsFor(id)[0], type, active);

  return (
    <aside class={ui.keysOpen ? 'actionpanel open' : 'actionpanel'} aria-label="Actions for this screen" data-testid="action-panel">
      {entries.map((e) => (
        <button
          key={e.id}
          type="button"
          class={e.startsGroup ? 'action gap' : 'action'}
          data-command={e.id}
          disabled={!e.enabled}
          tabIndex={-1}
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => {
            ui.closeKeys();
            registry.dispatch(e.id, { scopes: active.ids, modal: active.modal });
          }}
        >
          <span class="action-label">{e.label}</span>
          <span class="action-key">{e.chord ? <Kbd chord={e.chord} /> : null}</span>
        </button>
      ))}
    </aside>
  );
}
