/**
 * Self-test for the architecture guardrails: plants a deliberate violation, runs the real tool,
 * and requires it to FAIL for the right reason. If someone loosens a rule, this test breaks.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const planted: string[] = [];

function plant(relPath: string, source: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, source);
  planted.push(abs);
}

function run(args: string[]) {
  const r = spawnSync(`pnpm exec ${args.join(' ')}`, { cwd: root, shell: true, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout}\n${r.stderr}` };
}

const depcruise = () =>
  run(['depcruise', 'apps', 'packages', '--config', 'tooling/dependency-cruiser.cjs']);

afterEach(() => {
  for (const f of planted.splice(0)) rmSync(f, { force: true });
});

// Each test runs the real dependency-cruiser over the whole tree, which takes seconds — more when the whole suite runs in parallel.
describe('architecture guardrails', { timeout: 60_000 }, () => {
  it('pass on the clean tree', () => {
    const r = depcruise();
    expect(r.out).not.toMatch(/error/i);
    expect(r.code).toBe(0);
  });

  it('domain may not import another workspace package', () => {
    plant('packages/domain/src/__guard_domain.ts', "import '../../keyboard/src/index';\nexport {};\n");
    const r = depcruise();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('domain-is-pure');
  });

  it('command may not import the domain', () => {
    plant('packages/command/src/__guard_command.ts', "import '../../domain/src/index';\nexport {};\n");
    const r = depcruise();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('keyboard-and-command-are-generic');
  });

  it('screens may not import an adapter (only main.tsx may)', () => {
    plant(
      'apps/web/src/screens/__guard_screen.ts',
      "import '../../../../packages/adapter-supabase/src/index';\nexport {};\n",
    );
    const r = depcruise();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('only-composition-root-imports-adapters');
  });

  it('undeclared workspace dependencies fail as unresolvable', () => {
    plant('packages/command/src/__guard_undeclared.ts', "import '@minimalerp/domain';\nexport {};\n");
    const r = depcruise();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('not-to-unresolvable');
  });

  it('the Postgres adapter (bundled into the Edge Function) may not import another adapter', () => {
    plant('packages/adapter-postgres/src/__guard_pg.ts', "import '../../adapter-memory/src/index';\nexport {};\n");
    const r = depcruise();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('adapter-postgres-is-independent');
  });

  it('nothing may depend on db-tests', () => {
    plant('packages/domain/src/__guard_dbtests.ts', "import '../../db-tests/src/harness/testDb';\nexport {};\n");
    const r = depcruise();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('nothing-depends-on-db-tests');
  });

  it('packages may not deep-import another package', () => {
    plant('packages/ports/src/__guard_deep.ts', "import '../../domain/src/__guard_target';\nexport {};\n");
    plant('packages/domain/src/__guard_target.ts', 'export {};\n');
    const r = depcruise();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('no-deep-package-imports');
  });

  it('components may not attach key handlers', () => {
    plant(
      'apps/web/src/screens/__guard_keys.tsx',
      'export const X = () => <input onKeyDown={() => undefined} />;\n',
    );
    const r = run(['eslint', 'apps/web/src/screens/__guard_keys.tsx']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('no-restricted-syntax');
  });

  it('raw keydown listeners are banned outside packages/keyboard', () => {
    plant(
      'apps/web/src/screens/__guard_listener.ts',
      "window.addEventListener('keydown', () => undefined);\n",
    );
    const r = run(['eslint', 'apps/web/src/screens/__guard_listener.ts']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('no-restricted-syntax');
  });

  it('packages/keyboard may handle key events', () => {
    plant(
      'packages/keyboard/src/__guard_ok.ts',
      "window.addEventListener('keydown', () => undefined);\n",
    );
    const r = run(['eslint', 'packages/keyboard/src/__guard_ok.ts']);
    expect(r.code).toBe(0);
  });
});
