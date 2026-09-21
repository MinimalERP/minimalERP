# ADR-0006: Party is a profile with 0..n ledgers; only ledgers post

Status: accepted (2026-09-18)

## Context
Tally treats a party as a ledger, but ERP needs one business entity that can be both customer and supplier (common in manufacturing/job work).

## Decision
`parties` holds identity (GSTIN, PAN, addresses, contacts, credit terms). `ledgers.party_id` links 0..n ledgers (typically one debtor, optionally one creditor). Vouchers reference ledgers only.

## Consequences
Accounting stays single-sourced in ledgers. Search shows both the party and its ledgers.
