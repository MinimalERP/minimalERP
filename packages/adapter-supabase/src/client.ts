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

export interface SupabaseAuthSession {
  readonly user: { readonly id: string; readonly email?: string | undefined; readonly identities?: readonly unknown[] | undefined };
}

interface AuthError extends SupabaseError {
  /** supabase-js's machine-readable reason (`invalid_credentials`, `user_already_exists`…). */
  readonly code?: string | undefined;
}

/** The slice of `client.auth` the sign-in adapter uses. */
export interface SupabaseAuthLike {
  readonly auth: {
    getSession(): Promise<{ data: { session: SupabaseAuthSession | null }; error: AuthError | null }>;
    signInWithPassword(credentials: { email: string; password: string }): Promise<{
      data: { session: SupabaseAuthSession | null };
      error: AuthError | null;
    }>;
    resetPasswordForEmail(email: string, options?: { redirectTo?: string }): Promise<{ error: AuthError | null }>;
    updateUser(attributes: { password: string }): Promise<{ data: { user: SupabaseAuthSession['user'] | null }; error: AuthError | null }>;
    signOut(): Promise<{ error: AuthError | null }>;
    onAuthStateChange(callback: (event: string, session: SupabaseAuthSession | null) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
  };
}
