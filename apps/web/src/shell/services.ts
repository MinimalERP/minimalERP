import {
  CommandRegistry,
  RecentStore,
  ScreenStack,
  SearchService,
  type ModuleManifest,
  commandProvider,
} from '@minimalerp/command';
import { KeyboardManager, KeymapStore, ScopeStack, type StorageLike } from '@minimalerp/keyboard';
import { BooksHost } from '../books/books';
import { GATEWAY, type ScreenRef, sameScreen } from './router';

/**
 * What commands are allowed to do to the application. Commands receive this and nothing else, so a
 * module can navigate, open Go To, etc. without importing any UI.
 */
export interface AppContext {
  /** The open company, if any. Commands that need one check `books.current`. */
  readonly books: BooksHost;
  navigate(ref: ScreenRef): void;
  /** Changes the top screen in place (a voucher switching type keeps its draft, its place and its history). */
  replace(ref: ScreenRef): void;
  /**
   * Opens a screen on top of the current one and resolves with what it hands back when it closes (or undefined if it was
   * cancelled). This is how Alt+C creates a master from inside a field and returns to it with the draft intact.
   */
  navigateForResult<R>(ref: ScreenRef): Promise<R | undefined>;
  goHome(): void;
  /** Closes the top screen, optionally handing a result to whoever opened it with navigateForResult. */
  back(result?: unknown): boolean;
  canGoBack(): boolean;
  openGoTo(): void;
  closeGoTo(): void;
  toggleGoTo(): void;
  resetKeymap(): void;
}

/**
 * Overlay state. The Go To palette is an overlay, not a screen: it never enters the screen stack.
 *
 * Opening it pushes its MODAL keyboard scope right here, synchronously — not from the component that
 * renders it. A component effect runs a moment later, and a fast Alt+G then F8 would land in that gap
 * and open a voucher underneath the palette.
 */
export class UiState {
  private popScope: (() => void) | undefined;
  private open = false;
  private keys = false;
  private scopesAtOpen: readonly string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly scopes: ScopeStack) {}

  get gotoOpen(): boolean {
    return this.open;
  }

  /** On a narrow window the action panel is hidden until asked for (the top bar's Keys button). */
  get keysOpen(): boolean {
    return this.keys;
  }

  toggleKeys(): void {
    this.keys = !this.keys;
    this.notify();
  }

  closeKeys(): void {
    if (!this.keys) return;
    this.keys = false;
    this.notify();
  }

  /** The keyboard scopes that were active when Go To opened — the context its results are ranked for. */
  get gotoContext(): readonly string[] {
    return this.scopesAtOpen;
  }

  openGoTo(): void {
    if (this.open) return;
    this.scopesAtOpen = this.scopes.snapshot().ids; // before the modal scope hides them
    this.popScope = this.scopes.push({ id: 'overlay:goto', layer: 'overlay', modal: true });
    this.open = true;
    this.notify();
  }

  closeGoTo(): void {
    if (!this.open) return;
    this.popScope?.();
    this.popScope = undefined;
    this.open = false;
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}

export interface Services {
  readonly books: BooksHost;
  readonly scopes: ScopeStack;
  readonly registry: CommandRegistry<AppContext>;
  readonly keymapStore: KeymapStore;
  readonly keyboard: KeyboardManager;
  readonly screens: ScreenStack<ScreenRef>;
  readonly search: SearchService<AppContext>;
  readonly recents: RecentStore;
  readonly ui: UiState;
  readonly app: AppContext;
}

export interface ServicesOptions {
  readonly target: EventTarget;
  readonly modules: readonly ModuleManifest<AppContext>[];
  readonly storage?: StorageLike | undefined;
  /** Where the open company lives. Omitted (tests) = a host with no way to create one. */
  readonly books?: BooksHost | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * The composition root's wiring: builds every service once and connects them. There is exactly one
 * keyboard manager, one command registry, one search service and one screen stack in the app.
 */
export function createServices(options: ServicesOptions): Services {
  const scopes = new ScopeStack();
  const ui = new UiState(scopes);
  const screens = new ScreenStack<ScreenRef>(GATEWAY);
  // The keymap is built after modules declare their default bindings, but commands need to reach it lazily.
  const late: { keymapStore?: KeymapStore } = {};

  const books = options.books ?? new BooksHost();

  const app: AppContext = {
    books,
    navigate(ref) {
      ui.closeGoTo();
      if (!sameScreen(screens.top.screen, ref)) screens.push(ref);
    },
    replace(ref) {
      screens.replaceTop(ref);
    },
    navigateForResult<R>(ref: ScreenRef) {
      ui.closeGoTo();
      return screens.pushForResult<R>(ref);
    },
    goHome() {
      ui.closeGoTo();
      screens.reset(GATEWAY);
    },
    back: (result) => screens.pop(result),
    canGoBack: () => screens.depth > 1,
    openGoTo: () => ui.openGoTo(),
    closeGoTo: () => ui.closeGoTo(),
    toggleGoTo() {
      if (ui.gotoOpen) ui.closeGoTo();
      else ui.openGoTo();
    },
    resetKeymap: () => late.keymapStore?.resetAll(),
  };

  const registry = new CommandRegistry<AppContext>(() => app);
  // Commands become available or not when a company opens: menus, Go To and the status bar must re-derive.
  books.subscribe(() => registry.refresh());
  for (const module of options.modules) registry.registerModule(module);

  const keymapStore = new KeymapStore(registry.defaultBindings(), options.storage);
  late.keymapStore = keymapStore;
  const recents = new RecentStore(options.storage, options.now);

  const search = new SearchService<AppContext>({
    providers: () => [commandProvider(registry), ...registry.providers()],
    recents,
    isRunnable: (id) => registry.isRunnable(id),
  });

  const keyboard = new KeyboardManager({
    target: options.target,
    scopes,
    keymap: () => keymapStore.keymap,
    dispatch: (commandId, info) => registry.dispatch(commandId, { scopes: info.scopes, modal: info.modal }),
  });

  return { books, scopes, registry, keymapStore, keyboard, screens, search, recents, ui, app };
}
