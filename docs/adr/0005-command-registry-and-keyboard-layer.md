# ADR-0005: Central Command Registry, Universal Search and one keyboard layer

Status: accepted (2026-09-18)

## Context
Per-screen search boxes and per-component key handlers become unmaintainable and make future shortcut configuration impossible.

## Decision
All actions are Commands in one registry contributed by module manifests. Alt+G queries a SearchService over providers (commands, cached masters, server index, recents). Field pickers use the same service in constrained mode. One KeyboardManager with a scope stack and data keymap; lint bans key handlers elsewhere. Phase 3 is built before masters/vouchers so screens are born on it.

## Consequences
Screens declare scopes/commands instead of listeners. Some browser-reserved keys can't be captured (Ctrl+N/T/W): ship as PWA, provide a startup key self-test, keep everything remappable.
