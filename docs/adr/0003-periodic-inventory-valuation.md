# ADR-0003: Tally-style periodic inventory first

Status: accepted (2026-09-18)

## Context
Perpetual inventory needs COGS journals and complicates back-dated entries; Tally users expect closing stock computed from movements.

## Decision
Sales/Purchase post to sales/purchase ledgers; `stock_movements` hold quantities and values; a separate valuation module (weighted average) produces closing stock shown in P&L and Balance Sheet. Posting rules are pluggable so perpetual COGS can be added later.

## Consequences
Simple, familiar, back-dating works by recomputing from ordered movements. Perpetual, FIFO/LIFO deferred (see docs/architecture.md §13).
