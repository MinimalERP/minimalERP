import { Kbd } from '../ui/Kbd';
import { useServices, useSubscriptions } from './hooks';

/**
 * The keys available RIGHT NOW. It is derived, not written: a command shows up here only if it has a
 * hint, is currently available in the active scopes, and has a shortcut in the live keymap. So the hints
 * can never disagree with what the keys actually do — remap Go To and this bar follows.
 */
export function StatusBar() {
  const { scopes, registry, keymapStore, ui } = useServices();
  useSubscriptions(scopes, registry, keymapStore, ui);

  const active = scopes.snapshot();
  const keymap = keymapStore.keymap;

  const hints = registry
    .all()
    .filter((c) => c.statusBar && registry.isAvailable(c.id, active.ids, active.modal))
    .sort((a, b) => (a.statusBar?.order ?? 99) - (b.statusBar?.order ?? 99))
    .flatMap((c) => {
      const chord = keymap.chordsFor(c.id)[0];
      if (!chord || !c.statusBar) return [];
      const also = c.statusBar.also ? keymap.chordsFor(c.statusBar.also)[0] : undefined;
      return [{ id: c.id, label: c.statusBar.label, chords: also ? [also, chord] : [chord] }];
    });

  // Two commands can share a key when a screen scopes a more specific meaning to it (Enter = "Select" in a
  // list, but "Change shortcut" in the shortcut editor). Show only the one that actually wins.
  const scoped = (id: string) => keymap.bindingsOf(id)[0]?.scope !== undefined;
  const winners = new Map<string, (typeof hints)[number]>();
  for (const h of hints) {
    const key = h.chords.join('+');
    const held = winners.get(key);
    if (!held || (scoped(h.id) && !scoped(held.id))) winners.set(key, h);
  }
  const shown = hints.filter((h) => winners.get(h.chords.join('+')) === h);

  return (
    <footer class="statusbar" role="status" aria-label="Available keys">
      {shown.map((h) => (
        <button
          key={h.id}
          type="button"
          class="hint hint-btn"
          data-command={h.id}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => registry.dispatch(h.id, { scopes: active.ids, modal: active.modal })}
        >
          {h.chords.map((c) => (
            <Kbd key={c} chord={c} />
          ))}
          <span>{h.label}</span>
        </button>
      ))}
    </footer>
  );
}
