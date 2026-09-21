/**
 * Compile-time proof (no runtime): the real supabase-js client's `functions` satisfies `SupabaseLike`.
 * If a supabase-js upgrade changes the shape we depend on, `pnpm typecheck` fails here.
 *
 * The query-builder half (`from().select().eq()…`) is generic to a depth TypeScript will not compare
 * structurally, so it is verified at runtime instead — see compat.test.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseLike } from './client';

export const realFunctionsAreCompatible = (client: SupabaseClient): Pick<SupabaseLike, 'functions'> => client;
