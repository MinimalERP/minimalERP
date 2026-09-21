import type { Command, DefaultBinding, MenuEntry, MenuSection, ModuleManifest, SearchProvider } from './types';

/** A screen's implementation of a contextual command. Return `false` to say "not me — try the next one out". */
export type Handler = (args?: unknown) => boolean | void;

export interface DispatchInfo {
  /** Active scope ids, innermost first. */
  readonly scopes: readonly string[];
  /** A modal overlay is open: only handlers in the visible scopes and commands marked allowInModal may run. */
  readonly modal: boolean;
  readonly args?: unknown;
}

/**
 * The one registry of everything the user can do.
 *
 *   dispatch(id, …)  — the KEYBOARD path. A screen's handler for the command wins; otherwise the
 *                      command's own `run`. Handlers are looked up scope by scope, innermost first, so an
 *                      overlay's "move down" beats the menu's beneath it.
 *   run(id, …)       — the DIRECT path (menu entry, search result, button). Just runs the command.
 */
export class CommandRegistry<Ctx> {
  private readonly commands = new Map<string, Command<Ctx>>();
  private readonly modules: ModuleManifest<Ctx>[] = [];
  private readonly handlers = new Map<string, Map<string, Handler[]>>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly getContext: () => Ctx,
    private readonly onError: (error: unknown, commandId: string) => void = (e, id) => console.error(`Command ${id} failed`, e),
  ) {}

  // ---- registration ----

  register(command: Command<Ctx>): this {
    if (this.commands.has(command.id)) throw new Error(`Command "${command.id}" is already registered`);
    this.commands.set(command.id, command);
    this.notify();
    return this;
  }

  registerModule(manifest: ModuleManifest<Ctx>): this {
    if (this.modules.some((m) => m.id === manifest.id)) throw new Error(`Module "${manifest.id}" is already registered`);
    this.modules.push(manifest);
    for (const c of manifest.commands ?? []) this.register(c);
    return this;
  }

  get(id: string): Command<Ctx> | undefined {
    return this.commands.get(id);
  }

  all(): readonly Command<Ctx>[] {
    return [...this.commands.values()];
  }

  /** Every default binding contributed by any module, in registration order. */
  defaultBindings(): readonly DefaultBinding[] {
    return this.modules.flatMap((m) => m.bindings ?? []);
  }

  providers(): readonly SearchProvider<Ctx>[] {
    return this.modules.flatMap((m) => m.providers ?? []);
  }

  menuSections(): readonly MenuSection[] {
    return this.modules.flatMap((m) => m.menuSections ?? []).sort((a, b) => a.order - b.order);
  }

  /** The commands in one Gateway section, in menu order. Unavailable ones are omitted. */
  menu(sectionId: string): readonly Command<Ctx>[] {
    return this.menuItems(sectionId).map((i) => i.command);
  }

  /** The same, each with the heading it sits under (if the section is grouped). */
  menuItems(sectionId: string): readonly { readonly command: Command<Ctx>; readonly group: string | undefined }[] {
    const ctx = this.getContext();
    return this.modules
      .flatMap((m) => m.menu ?? [])
      .filter((e: MenuEntry) => e.section === sectionId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .flatMap((e) => {
        const command = this.commands.get(e.commandId);
        return command !== undefined && (command.when?.(ctx) ?? true) ? [{ command, group: e.group }] : [];
      });
  }

  // ---- contextual handlers ----

  /** A screen/overlay supplies behaviour for a contextual command while it is mounted. Returns the disposer. */
  pushHandler(scopeId: string, commandId: string, handler: Handler): () => void {
    const scope = this.handlers.get(scopeId) ?? new Map<string, Handler[]>();
    this.handlers.set(scopeId, scope);
    const stack = scope.get(commandId) ?? [];
    scope.set(commandId, stack);
    stack.push(handler);
    this.notify();
    return () => {
      const i = stack.indexOf(handler);
      if (i !== -1) stack.splice(i, 1);
      this.notify();
    };
  }

  // ---- execution ----

  dispatch(commandId: string, info: DispatchInfo): boolean {
    for (const scopeId of info.scopes) {
      const stack = this.handlers.get(scopeId)?.get(commandId);
      if (!stack) continue;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (this.invoke(commandId, () => (stack[i] as Handler)(info.args)) !== false) return true;
      }
    }
    const command = this.commands.get(commandId);
    if (!command?.run) return false;
    if (info.modal && !command.allowInModal) return false;
    if (!this.isEnabled(command)) return false;
    this.invoke(commandId, () => command.run?.(this.getContext(), info.args));
    return true;
  }

  /** Runs a command by identity, ignoring scopes and handlers. False if it does not exist, has no `run`, or is unavailable. */
  run(commandId: string, args?: unknown): boolean {
    const command = this.commands.get(commandId);
    if (!command?.run || !this.isEnabled(command)) return false;
    this.invoke(commandId, () => command.run?.(this.getContext(), args));
    return true;
  }

  /** Would pressing its key do something right now? (Used to show only live hints in the status bar.) */
  isAvailable(commandId: string, scopes: readonly string[], modal: boolean): boolean {
    if (scopes.some((s) => (this.handlers.get(s)?.get(commandId)?.length ?? 0) > 0)) return true;
    const command = this.commands.get(commandId);
    return !!command?.run && (!modal || !!command.allowInModal) && this.isEnabled(command);
  }

  /** Can it be run directly (from a menu or search)? */
  isRunnable(commandId: string): boolean {
    const command = this.commands.get(commandId);
    return !!command?.run && this.isEnabled(command);
  }

  /** Something the commands' `when` conditions depend on changed (a company opened): re-derive menus and hints. */
  refresh(): void {
    this.notify();
  }

  /** Notified whenever commands or handlers change — the status bar re-derives its hints from this. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private isEnabled(command: Command<Ctx>): boolean {
    return command.when?.(this.getContext()) ?? true;
  }

  /** Runs `fn`, converting a thrown error into a report so one broken command cannot take down the key handler. */
  private invoke<T>(commandId: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      this.onError(error, commandId);
      return undefined;
    }
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}
