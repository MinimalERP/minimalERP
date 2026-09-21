/** A screen in the stack, plus a bag of state that survives while other screens are on top of it. */
export interface Frame<S> {
  readonly id: number;
  readonly screen: S;
  /** Cursor row, scroll position, half-typed text… restored when Esc brings the user back here. */
  readonly state: Map<string, unknown>;
}

/**
 * The navigation model: a stack of screens. Open something = push; Esc = pop, landing exactly where
 * you left. `pushForResult` is how "create a master from inside a voucher" (Alt+C) works: the create
 * screen is pushed on top of the voucher, and when it is closed the new record's id flows back to
 * the field that asked for it — the voucher underneath is never lost.
 *
 * Generic over the screen descriptor and free of any UI framework.
 */
export class ScreenStack<S> {
  private frames: Frame<S>[];
  private nextId = 1;
  private readonly resolvers = new Map<number, (result: unknown) => void>();
  private readonly listeners = new Set<() => void>();

  constructor(root: S) {
    this.frames = [this.makeFrame(root)];
  }

  get top(): Frame<S> {
    return this.frames.at(-1) as Frame<S>;
  }

  get depth(): number {
    return this.frames.length;
  }

  get all(): readonly Frame<S>[] {
    return this.frames;
  }

  push(screen: S): Frame<S> {
    const frame = this.makeFrame(screen);
    this.frames = [...this.frames, frame];
    this.notify();
    return frame;
  }

  /**
   * Changes WHAT the top screen is without changing its place in the stack: same frame, same saved state. A voucher switching from Payment to
   * Journal is still the same screen with the same draft — only its address and its name in the breadcrumb change.
   */
  replaceTop(screen: S): void {
    this.frames = [...this.frames.slice(0, -1), { ...this.top, screen }];
    this.notify();
  }

  /** Pushes a screen and resolves when it is popped with a result (or undefined if cancelled). */
  pushForResult<R>(screen: S): Promise<R | undefined> {
    const frame = this.push(screen);
    return new Promise<R | undefined>((resolve) => {
      this.resolvers.set(frame.id, resolve as (r: unknown) => void);
    });
  }

  /** Removes the top screen. Returns false — and does nothing — if it is the only one. */
  pop(result?: unknown): boolean {
    if (this.frames.length <= 1) return false;
    const frame = this.top;
    this.frames = this.frames.slice(0, -1);
    const resolve = this.resolvers.get(frame.id);
    this.resolvers.delete(frame.id);
    // Hand the result over BEFORE telling the UI. The waiting code runs as a microtask and the UI re-renders as one;
    // resolving first queues the result's handler first, so the screen underneath is rebuilt with the result already
    // in its state (a screen that mounts a moment earlier would read state that is missing it).
    resolve?.(result);
    this.notify();
    return true;
  }

  /** Replaces the whole stack (e.g. when the address changes). Anything waiting on a result is cancelled. */
  reset(root: S, ...above: S[]): void {
    for (const [id, resolve] of this.resolvers) {
      this.resolvers.delete(id);
      resolve(undefined);
    }
    this.frames = [root, ...above].map((s) => this.makeFrame(s));
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private makeFrame(screen: S): Frame<S> {
    return { id: this.nextId++, screen, state: new Map() };
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}
