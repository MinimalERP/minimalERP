import type { Frame } from '@minimalerp/command';
import { Kbd } from '../ui/Kbd';
import { ListView } from '../ui/ListView';
import { useFrameState, useListNavigation, useServices, useSubscriptions } from '../shell/hooks';
import type { ScreenRef } from '../shell/router';

interface Row {
  readonly key: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly badge?: string | undefined;
  readonly chord?: string | undefined;
  /** The heading it sits under (a grouped section, like Transactions). */
  readonly group?: string | undefined;
  readonly open: () => void;
}

/**
 * The Gateway and every menu beneath it. It is generic: rows come from the module manifests
 * (sections and menu entries), so adding a feature adds a row without touching this file.
 */
export function MenuScreen({ frame, menuId }: { frame: Frame<ScreenRef>; menuId: string }) {
  const { registry, keymapStore, app } = useServices();
  useSubscriptions(registry, keymapStore);
  const [index, setIndex] = useFrameState(frame, 'index', 0);

  const isGateway = menuId === 'gateway';
  const section = registry.menuSections().find((s) => s.id === menuId);

  const rows: Row[] = isGateway
    ? registry.menuSections().map((s) => ({
        key: s.id,
        title: s.title,
        description: s.description,
        open: () => app.navigate({ type: 'menu', id: s.id }),
      }))
    : registry.menuItems(menuId).map(({ command: c, group }) => ({
        key: c.id,
        title: c.title,
        description: c.description,
        badge: c.badge,
        chord: keymapStore.keymap.chordsFor(c.id)[0] ?? (c.menuKeyOf ? keymapStore.keymap.chordsFor(c.menuKeyOf)[0] : undefined),
        group,
        open: () => void registry.run(c.id),
      }));

  const safeIndex = Math.min(index, Math.max(0, rows.length - 1));
  // Rows are one flat list for the keyboard (one cursor); a grouped section draws a heading and a list per group.
  const groups: { title: string; start: number; rows: Row[] }[] = [];
  rows.forEach((r, i) => {
    const title = r.group ?? '';
    const last = groups.at(-1);
    if (last && last.title === title) last.rows.push(r);
    else groups.push({ title, start: i, rows: [r] });
  });
  const activate = (i: number) => rows[i]?.open();

  // The scope id matches `screen:menu`, so the screen's own handlers are found by the registry.
  useListNavigation('screen:menu', { count: rows.length, index: safeIndex, setIndex, onActivate: activate, wrap: true });

  return (
    <section class="screen" aria-labelledby="menu-title">
      <h1 id="menu-title">{isGateway ? 'Gateway' : (section?.title ?? menuId)}</h1>
      <p class="lede">
        {isGateway
          ? 'Choose where to go. Press Alt+G at any time to search everything.'
          : (section?.description ?? '')}
      </p>
      {rows.length === 0 ? (
        <p class="empty">Nothing here yet.</p>
      ) : (
        groups.map((g) => (
          <div key={g.title || 'all'} class="menu-group" data-testid={g.title ? 'menu-group' : undefined}>
            {g.title && <h2 class="menu-group-title">{g.title}</h2>}
            <ListView
              items={g.rows}
              index={safeIndex >= g.start && safeIndex < g.start + g.rows.length ? safeIndex - g.start : -1}
              itemKey={(r) => r.key}
              label={g.title || (isGateway ? 'Gateway' : (section?.title ?? 'Menu'))}
              onActivate={(i) => {
                setIndex(g.start + i);
                activate(g.start + i);
              }}
              renderItem={(r) => (
                <>
                  <span class="row-title">{r.title}</span>
                  {r.description && <span class="row-desc">{r.description}</span>}
                  <span class="row-meta">
                    {r.badge && <span class="badge">{r.badge}</span>}
                    {r.chord && <Kbd chord={r.chord} />}
                  </span>
                </>
              )}
            />
          </div>
        ))
      )}
    </section>
  );
}
