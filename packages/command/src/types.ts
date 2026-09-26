/**
 * The vocabulary of the command layer. Everything the user can DO or GO TO is a Command; modules
 * contribute them through a ModuleManifest, and the registry, menus, Go To search and keyboard
 * shortcuts are all derived from that one description.
 */

/** `Ctx` is the application's own context (navigation, services…). This package never looks inside it. */
export interface Command<Ctx = unknown> {
  readonly id: string;
  readonly title: string;
  /** Groups it in search and in the shortcut editor: "Go To", "Create", "Report", "Settings"… */
  readonly category: string;
  readonly keywords?: readonly string[];
  readonly description?: string;
  /**
   * Plumbing that is not something a person "goes to" (list navigation, Back). Never offered by
   * search or menus. Still bindable to keys unless `configurable` is false.
   */
  readonly hidden?: boolean;
  /** Whether the shortcut editor lists it. Defaults to !hidden. */
  readonly configurable?: boolean;
  /** Short tag shown beside it, e.g. "Phase 6" for something planned but not built. */
  readonly badge?: string;
  /** May run while a modal overlay (like Go To) is open. Default false: modals block everything beneath them. */
  readonly allowInModal?: boolean;
  /** Show a hint for it in the status bar while it is available. `also` pairs a second command's key (↑↓). */
  /** The shortcut to show on this command's menu row when it has none of its own (a list row shows the F-key of the voucher it creates). */
  readonly menuKeyOf?: string;
  readonly statusBar?: { readonly label: string; readonly order?: number; readonly also?: string };
  /**
   * A button in the action panel beside a screen, for the screen types listed in `on` ("voucher", "report"…). It is shown even when it
   * cannot be used right now (greyed), so the panel reads like the screen's own menu; `labelOn` renames it for one screen type
   * (the same F2 is "Date" in a voucher and "Period" in a report). Entries are ordered by `order`; `group` starts a new block.
   */
  readonly panel?: {
    readonly label: string;
    readonly group: string;
    readonly order: number;
    readonly on: readonly string[];
    readonly labelOn?: Readonly<Record<string, string>>;
    /** Show the key of ANOTHER command on the button (a Close button that shows Esc, which is really "back"). */
    readonly keyOf?: string;
    /** Leave the button out (not just grey it) while nothing supplies it — for buttons that belong to ONE screen among many of the same type ("New Sales Voucher" on the Sales list). */
    readonly hideWhenUnavailable?: boolean;
    /** The dropdown this button folds into when the panel is too short to show every button ("Print", "Email", "Inventory", "Other"). */
    readonly fold?: string;
  };
  /** Is it available right now? Unavailable commands are neither searched nor run. */
  when?(ctx: Ctx): boolean;
  /**
   * What it does. Omit for a purely CONTEXTUAL command (like list "move down"): its behaviour is
   * supplied by whichever screen is active, via CommandRegistry.pushHandler.
   */
  run?(ctx: Ctx, args?: unknown): void;
}

/** A default key binding a module declares for one of its commands. `scope` omitted = everywhere. */
export interface DefaultBinding {
  readonly commandId: string;
  readonly chord: string;
  readonly scope?: string | undefined;
}

export interface MenuSection {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly description?: string;
}

/** Puts a command in a Gateway menu section. */
export interface MenuEntry {
  readonly section: string;
  readonly commandId: string;
  readonly order?: number;
  /** A heading the entry sits under inside its section ("Sales", "Inventory"); groups appear in the order of their first entry. */
  readonly group?: string;
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------
export interface ParsedQuery {
  readonly raw: string;
  /** The query with any scope prefix removed. */
  readonly text: string;
  readonly terms: readonly string[];
  /** Set by a prefix like `>` (commands only) or `l:` (ledgers). */
  readonly scope?: string | undefined;
}

export interface SearchContext<Ctx = unknown> {
  readonly app: Ctx;
  /** Active keyboard scope ids, innermost first — lets providers rank what is relevant HERE. */
  readonly scopes: readonly string[];
}

/**
 * One result. Activating it runs `commandId` with `args`, so every hit — a report, a ledger, a
 * voucher — resolves to a command invocation and the router is the only place that knows about screens.
 */
/** A secondary thing you can do with a result (Display, Alter, later Transactions…). Enter runs the hit itself; → lists these. */
export interface HitAction {
  readonly label: string;
  readonly commandId: string;
  readonly args?: unknown;
}

export interface SearchHit {
  /** Stable identity, used for recents, favourites and de-duplication. */
  readonly key: string;
  /** "Command", "Report", "Ledger"… shown as the row's label. */
  readonly kind: string;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly badge?: string | undefined;
  readonly commandId: string;
  readonly args?: unknown;
  /** 0..1 relevance from the provider. */
  readonly score: number;
  /** Character ranges in `title` to highlight. */
  readonly ranges?: readonly (readonly [number, number])[] | undefined;
  /** Other things to do with this result, offered by the "more actions" key. */
  readonly actions?: readonly HitAction[] | undefined;
}

export interface SearchProvider<Ctx = unknown> {
  readonly id: string;
  /** The `>`/`l:`-style scopes this provider answers to. Omitted = only unscoped queries. */
  readonly scopes?: readonly string[];
  search(query: ParsedQuery, context: SearchContext<Ctx>, signal?: AbortSignal): SearchHit[] | Promise<SearchHit[]>;
}

// ---------------------------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------------------------
/** What a feature module contributes. The shell never imports a module by name — it just registers manifests. */
export interface ModuleManifest<Ctx = unknown> {
  readonly id: string;
  readonly commands?: readonly Command<Ctx>[];
  readonly bindings?: readonly DefaultBinding[];
  readonly menuSections?: readonly MenuSection[];
  readonly menu?: readonly MenuEntry[];
  readonly providers?: readonly SearchProvider<Ctx>[];
}
