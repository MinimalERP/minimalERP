# ADR-0007: Scope, assumptions, and no speculative schema

Status: accepted (2026-09-18)

## Context
Broad ERP ambitions risk building unused structure. Two assumptions were confirmed by approving the plan on 2026-09-18.

## Decision
Assumptions: India / INR / GST first; online-only (unsaved drafts persisted in IndexedDB). Manufacturing is the first module after the accounting core (Phase 10). No reserved columns, tables or stubs for unbuilt modules; additive nullable columns are cheap in Postgres and will be added with the feature.

## Consequences
Multi-currency, offline sync and the items in docs/architecture.md §13 are out of scope until a new ADR.
