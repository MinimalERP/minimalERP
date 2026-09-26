import type { CommandRegistry } from './registry';

/** One button of a screen's action panel, ready to draw. */
export interface PanelEntry {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  /** The key that runs it right now (the live keymap's first chord), if it has one. */
  readonly chord?: string | undefined;
  /** Would it do something right now? Greyed when not. */
  readonly enabled: boolean;
  /** True on the first entry of a new group: the panel draws a gap above it. */
  readonly startsGroup: boolean;
  /** The dropdown it folds into when the panel does not fit; absent = always shown. */
  readonly fold?: string | undefined;
}

/**
 * The panel for one screen type, derived from the commands' `panel` metadata — the same way the status bar is derived from `statusBar`:
 * nothing here is written per screen, so a new screen's buttons appear by declaring them on its commands.
 *
 * `enabled` is exactly "would pressing its key do something": a handler registered by the screen in front, or a runnable command. While a
 * modal overlay is open nothing beneath it is available, so the whole panel goes grey.
 */
export function panelEntries<Ctx>(
  registry: Pick<CommandRegistry<Ctx>, 'all' | 'isAvailable'>,
  chordFor: (commandId: string) => string | undefined,
  screenType: string,
  active: { readonly ids: readonly string[]; readonly modal: boolean },
): PanelEntry[] {
  const shown = registry
    .all()
    .filter((c) => c.panel?.on.includes(screenType))
    .filter((c) => !c.panel?.hideWhenUnavailable || registry.isAvailable(c.id, active.ids, active.modal))
    .sort((a, b) => (a.panel?.order ?? 0) - (b.panel?.order ?? 0));
  return shown.map((c, i) => {
    const panel = c.panel as NonNullable<typeof c.panel>;
    return {
      id: c.id,
      label: panel.labelOn?.[screenType] ?? panel.label,
      group: panel.group,
      chord: chordFor(panel.keyOf ?? c.id),
      enabled: registry.isAvailable(c.id, active.ids, active.modal),
      startsGroup: i > 0 && shown[i - 1]?.panel?.group !== panel.group,
      ...(panel.fold ? { fold: panel.fold } : {}),
    };
  });
}
