// Bundles the Edge Function's shared logic (domain + Postgres adapter + zod) into ONE self-contained
// ES module, so the Deno runtime needs no workspace packages and no node_modules.
//   pnpm build:functions   →   supabase/functions/post-voucher/handler.bundle.js
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildFunctions() {
  const outfile = resolve(root, 'supabase/functions/post-voucher/handler.bundle.js');
  await build({
    entryPoints: [resolve(root, 'packages/adapter-postgres/src/index.ts')],
    outfile,
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
  });
  return outfile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await buildFunctions();
  console.log(`built ${out}`);
}
