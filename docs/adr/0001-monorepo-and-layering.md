# ADR-0001: pnpm monorepo with enforced layering

Status: accepted (2026-09-18)

## Context
The domain must stay independent of UI and backend for years. Convention alone erodes.

## Decision
pnpm workspaces; source-only internal packages (`exports` → `src/index.ts`, no build step). Layering rules are executable: dependency-cruiser (`tooling/dependency-cruiser.cjs`) and ESLint. `tooling/guards.test.ts` plants violations and requires the tools to fail, so loosening a rule breaks the build. TypeScript is pinned to the 6.0 line: typescript-eslint 8.70 does not yet support TS 7 (native compiler); revisit when it does.

## Consequences
Every new package must declare its dependencies (undeclared imports are unresolvable and fail). Edge Function bundling (Phase 2) needs esbuild since packages are not prebuilt.
