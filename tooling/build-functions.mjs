// Bundles each Edge Function's shared logic (domain + Postgres adapter + zod, and for `intake` the Gemini reader) into ONE
// self-contained ES module, so the Deno runtime needs no workspace packages and no node_modules.
//   pnpm build:functions   →   supabase/functions/post-voucher/handler.bundle.js
//                              supabase/functions/intake/handler.bundle.js
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const common = {
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],
  minify: false, // unminified: stack traces stay readable in function logs
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
};

/** Builds every function; returns the post-voucher bundle's path (what the bundle tests load). */
export async function buildFunctions() {
  const outfile = resolve(root, 'supabase/functions/post-voucher/handler.bundle.js');
  await build({ ...common, entryPoints: [resolve(root, 'packages/adapter-postgres/src/index.ts')], outfile });
  // intake = the Postgres backend + the intake handler + the Gemini reader. The two packages may not know each other (boundaries), so the
  // function's entry joins them here; each resolves its own dependencies from its package.
  await build({
    ...common,
    stdin: {
      contents: [
        "export { PostgresBackend, createIntakeHandler } from './packages/adapter-postgres/src/index.ts';",
        "export { GeminiReader } from './packages/adapter-gemini/src/index.ts';",
      ].join('\n'),
      resolveDir: root,
      loader: 'ts',
      sourcefile: 'intake-entry.ts',
    },
    outfile: resolve(root, 'supabase/functions/intake/handler.bundle.js'),
  });
  return outfile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await buildFunctions();
  console.log(`built ${out}`);
}
