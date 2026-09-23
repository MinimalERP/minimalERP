import { createContext } from 'preact';
import { useContext, useLayoutEffect, useReducer, useRef, useState } from 'preact/hooks';
import type { Frame } from '@minimalerp/command';
import { moveIndex } from '@minimalerp/keyboard';
import type { ScopeLayer } from '@minimalerp/keyboard';
import type { ScreenRef } from './router';
import type { Services } from './services';

export const ServicesContext = createContext<Services | undefined>(undefined);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesContext.Provider>');
  return services;
}

interface Subscribable {
  subscribe(listener: () => void): () => void;
}

/** Re-renders when any of the stores change. Read the values you need during render. */
export function useSubscriptions(...stores: Subscribable[]): void {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    const offs = stores.map((s) => s.subscribe(() => rerender(0)));
    rerender(0); // a store may have changed between this render and the subscription (another component's scope or handler arriving): read it again
    return () => offs.forEach((off) => off());
  }, stores);
}

/**
 * Declares "the user is somewhere with this scope" while the component is mounted. This — not an
 * onKeyDown handler — is how a screen takes part in keyboard handling.
 */
export function useScope(id: string, layer: ScopeLayer, modal = false): void {
  const { scopes } = useServices();
  // Layout, like the focus effects: a screen's keys are live the moment it is on screen, before the next keydown is handled.
  useLayoutEffect(() => scopes.push({ id, layer, modal }), [scopes, id, layer, modal]);
}

/** Supplies this component's behaviour for a contextual command (like "move down") while mounted. */
export function useCommandHandler(scopeId: string, commandId: string, handler: (args?: unknown) => boolean | void): void {
  const { registry } = useServices();
  const latest = useRef(handler);
  latest.current = handler; // always call the freshest closure without re-registering
  useLayoutEffect(
    () => registry.pushHandler(scopeId, commandId, (args) => latest.current(args)),
    [registry, scopeId, commandId],
  );
}

export interface NavOptions {
  readonly count: number;
  readonly index: number;
  readonly setIndex: (index: number) => void;
  readonly onActivate: (index: number) => void;
  readonly wrap?: boolean;
  readonly pageSize?: number;
  /** Home/End jump to the first/last row. Turn off when a text input has focus: they must move its caret. */
  readonly homeEnd?: boolean;
}

/**
 * Makes a list keyboard-navigable by handling the navigation COMMANDS in `scopeId`.
 * Which physical keys those are is the keymap's business — nothing here mentions a key.
 */
export function useListNavigation(scopeId: string, o: NavOptions): void {
  const move = (m: Parameters<typeof moveIndex>[2]) => {
    if (o.count === 0) return false; // nothing to move: let the key fall through
    o.setIndex(moveIndex(o.index, o.count, m, { wrap: o.wrap ?? false, pageSize: o.pageSize ?? 8 }));
    return true;
  };
  useCommandHandler(scopeId, 'nav.up', () => move('up'));
  useCommandHandler(scopeId, 'nav.down', () => move('down'));
  useCommandHandler(scopeId, 'nav.pageUp', () => move('pageUp'));
  useCommandHandler(scopeId, 'nav.pageDown', () => move('pageDown'));
  const homeEnd = o.homeEnd ?? true;
  useCommandHandler(scopeId, 'nav.first', () => homeEnd && move('first'));
  useCommandHandler(scopeId, 'nav.last', () => homeEnd && move('last'));
  useCommandHandler(scopeId, 'field.next', () => move('down'));
  useCommandHandler(scopeId, 'field.prev', () => move('up'));
  useCommandHandler(scopeId, 'nav.activate', () => {
    if (o.count === 0) return false;
    o.onActivate(o.index);
    return true;
  });
}

/**
 * State that lives on the screen-stack frame, so it survives the screen being covered by another and
 * is there again when Esc returns — the menu cursor is on the same row you left it.
 */
export function useFrameState<T>(frame: Frame<ScreenRef>, key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => (frame.state.has(key) ? (frame.state.get(key) as T) : initial));
  return [
    value,
    (next) => {
      frame.state.set(key, next);
      setValue(next);
    },
  ];
}
