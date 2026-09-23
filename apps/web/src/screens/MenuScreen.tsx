import type { Frame } from '@minimalerp/command';
import { Kbd } from '../ui/Kbd';
import { ListView } from '../ui/ListView';
import { useLetterKeys } from '../ui/useLetterKeys';
import { useFrameState, useListNavigation, useServices, useSubscriptions } from '../shell/hooks';
import type { ScreenRef } from '../shell/router';

interface Mnemonic {
  /** The letter a bare keypress answers to (always upper-case). */
  readonly char: string;
  /** Where in the row's title that letter sits, so it can be picked out in a different colour. */
  readonly index: number;
}

/**
 * The Gateway's four sections keep the same letter always — chosen by hand, not derived, because
 * "Utilities & Settings" would otherwise mnemonic to its own first letter (U), not the S the section
 * is actually called by.
 */
const GATEWAY_MNEMONIC: Readonly<Record<string, string>> = { masters: 'M', transactions: 'T', reports: 'R', utilities: 'Settings' };

function gatewayMnemonic(id: string, title: string): Mnemonic | undefined {
  const marker = GATEWAY_MNEMONIC[id] ?? title.slice(0, 1);
  const index = title.indexOf(marker);
  return index === -1 ? undefined : { char: marker.slice(0, 1).toUpperCase(), index };
}

/**
 * One letter per row, so a bare keypress can jump straight to it — the same idea as Tally's Gateway.
 * Each row claims the first of its own letters nothing before it already claimed; a row whose every
 * letter is taken gets none (still reachable by arrow keys, just not by a single keypress).
 */
function assignMnemonics(titles: readonly string[]): (Mnemonic | undefined)[] {
  const used = new Set<string>();
  return titles.map((title) => {
    for (let i = 0; i < title.length; i++) {
      const ch = title[i] as string;
      if (!/[a-zA-Z]/.test(ch)) continue;
      const upper = ch.toUpperCase();
      if (used.has(upper)) continue;
      used.add(upper);
      return { char: upper, index: i };
    }
    return undefined;
  });
}

function TitleWithMnemonic({ title, mnemonic }: { title: string; mnemonic: Mnemonic | undefined }) {
  if (!mnemonic) return <>{title}</>;
  return (
    <>
      {title.slice(0, mnemonic.index)}
      <span class="mnemonic">{title.slice(mnemonic.index, mnemonic.index + 1)}</span>
      {title.slice(mnemonic.index + 1)}
    </>
  );
}

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

  const mnemonics: (Mnemonic | undefined)[] = isGateway
    ? rows.map((r) => gatewayMnemonic(r.key, r.title))
    : assignMnemonics(rows.map((r) => r.title));
  const mnemonicByKey = new Map(rows.map((r, i) => [r.key, mnemonics[i]]));

  // A bare letter jumps straight to the row it marks — safe here only because this screen is a pure list: no text field ever has focus on it.
  useLetterKeys(
    (letter) => {
      const i = mnemonics.findIndex((m) => m?.char === letter);
      if (i === -1) return false;
      rows[i]?.open();
      return true;
    },
    [rows, mnemonics],
  );

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
          ? 'Choose where to go: type a red letter to jump straight in, or press Alt+G at any time to search everything.'
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
                  <span class="row-title">
                    <TitleWithMnemonic title={r.title} mnemonic={mnemonicByKey.get(r.key)} />
                  </span>
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
