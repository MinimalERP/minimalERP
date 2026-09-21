/**
 * The one thing this adapter needs from a database driver: run a parameterised statement.
 * node-postgres (`pg`) satisfies it directly; the Supabase Edge Function wraps `postgres`.
 * Keeping it this small is what lets the same adapter run in Node, Deno and tests.
 */
export interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
}

export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
}
