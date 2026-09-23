/**
 * Architecture boundaries. CI fails on any violation (`pnpm boundaries`).
 * The rules are the executable form of docs/architecture.md §1–§2.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'Every import must resolve. Under pnpm, importing a workspace package or npm module you have ' +
        'not declared in package.json is unresolvable — declare it first, then the boundary rules apply.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make layering meaningless.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment:
        'packages/domain is pure accounting/ERP logic: it may import itself, zod and big.js only ' +
        '(vitest in tests). No other workspace package, no node built-ins, no framework, no I/O.',
      from: { path: '^packages/domain/src' },
      to: { pathNot: ['^packages/domain/src', 'node_modules/(zod|big\\.js|vitest)/'] },
    },
    {
      name: 'keyboard-and-command-are-generic',
      severity: 'error',
      comment: 'keyboard and command know nothing about accounting, adapters or the app.',
      from: { path: '^packages/(keyboard|command)/src' },
      to: { path: '^(packages/(domain|ports|adapter-memory|adapter-supabase|adapter-postgres|adapter-gemini|testkit|db-tests)|apps)/' },
    },
    {
      name: 'ports-depend-only-on-domain',
      severity: 'error',
      comment: 'ports are interfaces over domain types; they never reach adapters, UI layers or the app.',
      from: { path: '^packages/ports/src' },
      to: { path: '^(packages/(adapter-memory|adapter-supabase|adapter-postgres|adapter-gemini|command|keyboard|testkit|db-tests)|apps)/' },
    },
    {
      name: 'adapter-memory-is-independent',
      severity: 'error',
      comment: 'Adapters implement ports. They do not know each other, the app, or the UI layers.',
      from: { path: '^packages/adapter-memory/src' },
      to: { path: '^(packages/(adapter-supabase|adapter-postgres|adapter-gemini|command|keyboard|testkit|db-tests)|apps)/' },
    },
    {
      name: 'adapter-supabase-is-independent',
      severity: 'error',
      comment: 'Adapters implement ports. They do not know each other, the app, or the UI layers.',
      from: { path: '^packages/adapter-supabase/src' },
      to: { path: '^(packages/(adapter-memory|adapter-postgres|adapter-gemini|command|keyboard|testkit|db-tests)|apps)/' },
    },
    {
      name: 'adapter-postgres-is-independent',
      severity: 'error',
      comment:
        'The server-side Postgres adapter implements ports only. It knows no other adapter, no UI layer, no app. ' +
        'It is bundled into the Edge Function, so anything it imports ships to production.',
      from: { path: '^packages/adapter-postgres/src' },
      to: { path: '^(packages/(adapter-memory|adapter-supabase|adapter-gemini|command|keyboard|testkit|db-tests)|apps)/' },
    },
    {
      name: 'adapter-gemini-is-independent',
      severity: 'error',
      comment:
        'The Gemini reader implements one port (DocumentReader) with fetch. It knows no other adapter, no UI layer, no app. ' +
        'It is bundled into the intake Edge Function.',
      from: { path: '^packages/adapter-gemini/src' },
      to: { path: '^(packages/(adapter-memory|adapter-supabase|adapter-postgres|command|keyboard|testkit|db-tests)|apps)/' },
    },
    {
      name: 'nothing-depends-on-db-tests',
      severity: 'error',
      comment: 'db-tests is a leaf: integration tests against a real database. Nothing may import it.',
      from: { path: '^(apps|packages/(?!db-tests))' },
      to: { path: '^packages/db-tests/' },
    },
    {
      name: 'only-composition-root-imports-adapters',
      severity: 'error',
      comment: 'Screens and modules depend on ports. Only apps/web/src/main.tsx wires an adapter (a test may build a real one).',
      from: { path: '^apps/web/src', pathNot: ['^apps/web/src/main\\.tsx$', '\\.test\\.tsx?$'] },
      to: { path: '^packages/adapter-' },
    },
    {
      name: 'testkit-is-test-only',
      severity: 'error',
      comment: 'testkit (builders, seeds, contract tests) must not leak into production code.',
      from: {
        path: '^(apps|packages/(domain|ports|command|keyboard|adapter-supabase|adapter-postgres))/',
        pathNot: '\\.(test|spec)\\.tsx?$',
      },
      to: { path: '^packages/testkit/' },
    },
    {
      name: 'no-deep-package-imports',
      severity: 'error',
      comment: 'Cross-package imports go through the package index (its public API), never into src/.',
      from: { path: '^(apps/[^/]+|packages/[^/]+)/' },
      to: {
        path: '^packages/[^/]+/src/(?!index\\.ts$)',
        pathNot: '^$1/',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['/dist/', '/coverage/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
