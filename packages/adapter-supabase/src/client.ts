/**
 * The slice of the Supabase client this adapter uses, written as structural interfaces so the
 * adapter is testable with a fake and is not tied to a supabase-js version. A compile-time check
 * (compat.typecheck.ts) proves the real `SupabaseClient` satisfies it.
 */
export interface SupabaseError {
  readonly message: string;
  /** For FunctionsHttpError: the failed HTTP response, whose JSON body carries our issue list. */
  readonly context?: unknown;
}

export interface InvokeResult {
  readonly data: unknown;
  readonly error: SupabaseError | null;
}

export interface QueryResult {
  readonly data: readonly Record<string, unknown>[] | null;
  readonly error: SupabaseError | null;
}

/** PostgREST's filter builder: chainable, awaitable. */
export interface FilterBuilder extends PromiseLike<QueryResult> {
  eq(column: string, value: unknown): this;
  gte(column: string, value: unknown): this;
  lte(column: string, value: unknown): this;
  order(column: string, options?: { ascending?: boolean }): this;
  range(from: number, to: number): this;
}

export interface SupabaseLike {
  readonly functions: {
    invoke(name: string, options: { body: Record<string, unknown> }): Promise<InvokeResult>;
  };
  from(table: string): { select(columns: string): FilterBuilder };
}
