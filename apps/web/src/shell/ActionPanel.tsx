import { type PanelEntry, panelEntries } from '@minimalerp/command';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Kbd } from '../ui/Kbd';
import { useCommandHandler, useScope, useServices, useSubscriptions } from './hooks';

/** The screens that open at the third level — where a person is entering or reading, and wants the screen's own actions at hand. */
export const PANEL_SCREENS: readonly string[] = ['voucher', 'report', 'master', 'master-list', 'inbox', 'import-export'];

/** When the panel is too short, its groups fold into dropdowns in this order — the least used first — and only as many as it takes to fit. */
export const FOLD_ORDER: readonly string[] = ['Other', 'Inventory', 'Email', 'Print'];

const MENU_SCOPE = 'overlay:panel-menu';

/**
 * The screen's actions, down the right edge — the same commands the keys run, drawn as buttons (Tally's button panel). Derived like the
 * status bar: from the commands' `panel` metadata, the live keymap and what is available right now (greyed when nothing would happen).
 * A click runs the command through the same dispatch as its key, so the screen in front decides what it does.
 *
 * It never scrolls: when every button does not fit, whole groups (see FOLD_ORDER) fold into one dropdown each — "Other ▾" — until it does;
 * on a tall window it is exactly as it always was. A folded button's key still works directly.
 *
 * The buttons never take focus (mouse-down is cancelled, they are skipped by Tab): the field being edited keeps its caret and Tab order.
 */
export function ActionPanel() {
  const { scopes, registry, keymapStore, ui, screens } = useServices();
  useSubscriptions(scopes, registry, keymapStore, ui, screens);
  const root = useRef<HTMLElement>(null);
  const [folded, setFolded] = useState(0);
  const [, remeasure] = useState(0);
  /** The dropdown open: its buttons and the keyboard scopes as they were when it opened (its own modal scope would grey them), and where. */
  const [open, setOpen] = useState<{ fold: string; all: readonly PanelEntry[]; scopes: readonly string[]; top: number; right: number } | undefined>(undefined);

  const type = screens.top.screen.type;
  const shown = PANEL_SCREENS.includes(type);
  const active = scopes.snapshot();
  // while a dropdown is open the panel stays as it was when it opened (the dropdown's own modal scope would grey and hide its buttons)
  const entries = open ? open.all : shown ? panelEntries(registry, (id) => keymapStore.keymap.chordsFor(id)[0], type, active) : [];
  const present = FOLD_ORDER.filter((f) => entries.some((e) => e.fold === f));
  const foldedSet = new Set(present.slice(0, folded));
  const signature = `${type}|${entries.map((e) => e.id).join(',')}`;

  // a different screen (or different buttons) starts unfolded, and so does a resized window: then fold group by group while it overflows
  useLayoutEffect(() => setFolded(0), [signature]);
  useLayoutEffect(() => {
    const onResize = () => {
      setOpen(undefined);
      setFolded(0);
      remeasure((n) => n + 1); // even when nothing was folded: the new height is measured again
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useLayoutEffect(() => {
    const el = root.current;
    if (el && folded < present.length && el.scrollHeight > el.clientHeight + 1) setFolded(folded + 1);
  });

  if (!shown) return null;

  const run = (id: string, ids: readonly string[], modal: boolean) => {
    ui.closeKeys();
    registry.dispatch(id, { scopes: ids, modal });
  };
  const button = (e: PanelEntry, gap: boolean) => (
    <button
      key={e.id}
      type="button"
      class={gap ? 'action gap' : 'action'}
      data-command={e.id}
      disabled={!e.enabled}
      tabIndex={-1}
      onMouseDown={(ev) => ev.preventDefault()}
      onClick={() => run(e.id, active.ids, active.modal)}
    >
      <span class="action-label">{e.label}</span>
      <span class="action-key">{e.chord ? <Kbd chord={e.chord} /> : null}</span>
    </button>
  );

  // a folded group is drawn once, as its dropdown, where its first button was
  const drawn: preact.JSX.Element[] = [];
  const placed = new Set<string>();
  let afterFold = false;
  entries.forEach((e) => {
    const fold = e.fold && foldedSet.has(e.fold) ? e.fold : undefined;
    if (!fold) {
      drawn.push(button(e, drawn.length > 0 && (e.startsGroup || afterFold)));
      afterFold = false;
      return;
    }
    if (placed.has(fold)) return;
    placed.add(fold);
    afterFold = true;
    const members = entries.filter((x) => x.fold === fold);
    drawn.push(
      <button
        key={`fold-${fold}`}
        type="button"
        class={`action fold${drawn.length > 0 ? ' gap' : ''}${open?.fold === fold ? ' open' : ''}`}
        data-fold={fold}
        aria-haspopup="menu"
        aria-expanded={open?.fold === fold}
        disabled={!members.some((m) => m.enabled)}
        tabIndex={-1}
        onMouseDown={(ev) => ev.preventDefault()}
        onClick={(ev) => {
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          setOpen(open?.fold === fold ? undefined : { fold, all: entries, scopes: active.ids, top: r.top, right: window.innerWidth - r.left + 4 });
        }}
      >
        <span class="action-label">{fold} ▾</span>
      </button>,
    );
  });

  return (
    <aside ref={root} class={ui.keysOpen ? 'actionpanel open' : 'actionpanel'} aria-label="Actions for this screen" data-testid="action-panel">
      {drawn}
      {open && (
        <FoldMenu
          title={open.fold}
          entries={open.all.filter((e) => e.fold === open.fold)}
          top={open.top}
          right={open.right}
          onClose={() => setOpen(undefined)}
          onRun={(id) => {
            const ids = open.scopes;
            setOpen(undefined);
            run(id, ids, false);
          }}
        />
      )}
    </aside>
  );
}

/** A folded group's buttons, beside the panel: click one, or ↑↓ and Enter; Esc (or a click elsewhere) closes it. */
function FoldMenu({ title, entries, top, right, onClose, onRun }: { title: string; entries: readonly PanelEntry[]; top: number; right: number; onClose: () => void; onRun: (id: string) => void }) {
  useScope(MENU_SCOPE, 'overlay', true);
  const usable = entries.filter((e) => e.enabled);
  const [at, setAt] = useState(0);
  const cur = usable[Math.min(at, usable.length - 1)];
  const menu = useRef<HTMLDivElement>(null);
  useCommandHandler(MENU_SCOPE, 'nav.down', () => (setAt(Math.min(at + 1, usable.length - 1)), true));
  useCommandHandler(MENU_SCOPE, 'nav.up', () => (setAt(Math.max(at - 1, 0)), true));
  useCommandHandler(MENU_SCOPE, 'nav.activate', () => (cur ? onRun(cur.id) : onClose(), true));
  useCommandHandler(MENU_SCOPE, 'app.back', () => (onClose(), true));
  useLayoutEffect(() => {
    const away = (ev: MouseEvent) => {
      if (!(ev.target instanceof Node) || menu.current?.contains(ev.target) || (ev.target as Element).closest?.('[data-fold]')) return;
      onClose();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);
  return (
    <div class="fold-menu" role="menu" aria-label={title} data-testid="fold-menu" ref={menu} style={{ top: `${Math.max(4, Math.min(top, window.innerHeight - 40 * entries.length - 40))}px`, right: `${right}px` }}>
      <div class="fold-menu-title">{title}</div>
      {entries.map((e) => (
        <button
          key={e.id}
          type="button"
          role="menuitem"
          class={e === cur ? 'action chosen' : 'action'}
          data-command={e.id}
          disabled={!e.enabled}
          tabIndex={-1}
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => onRun(e.id)}
        >
          <span class="action-label">{e.label}</span>
          <span class="action-key">{e.chord ? <Kbd chord={e.chord} /> : null}</span>
        </button>
      ))}
    </div>
  );
}
