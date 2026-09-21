# ADR-0013: The Party is the one thing you create — its ledgers come with it

Status: accepted (2026-09-22)

## Context
Creating a customer or supplier took two steps that had to be kept in agreement by hand: a *Party* (GSTIN, address, credit terms) and a
*Ledger* under Sundry Debtors/Creditors linked to it. The user asked for one step. A party can be a customer, a vendor, or both at once,
and it needs billing and shipping addresses in the same form. As always: extend the current UI and architecture, do not change them.

## Decisions

1. **A party has roles; each role has a ledger of its own.** `Party.roles` is `customer`, `vendor` or both. A customer's ledger sits under
   Sundry Debtors, a vendor's under Sundry Creditors, so the balance sheet, GST, ageing and credit terms behave exactly as they did. A party that is
   *both* has **two** ledgers — `Name` (receivable) and `Name (Vendor)` (payable) — and the user still sees **one** party. A single ledger for
   both was rejected: a receivable and a payable are different things on the balance sheet, and netting them silently would misstate both.
2. **The ledgers are derived, not remembered.** `partyLedgerId(partyId, role)` is a deterministic id, so the create command is idempotent (a retry is
   a replay) and the interface knows a party's ledger without a lookup. `Ledger.partyRole` marks a ledger as party-owned.
3. **One command, several records.** `prepareMasterCommand` for a party returns `PreparedMaster { change, changes[], masters }`: the party first, then its
   ledgers. Creating makes them; renaming renames them; a role gained creates the missing ledger (and a vendor who becomes a customer too hands its
   plain name to the new customer ledger — same record, same history); deactivating or reactivating the party does the same to its ledgers. A
   name clash on any ledger refuses the whole party, reported on the party's name. Roles only grow: a role cannot be taken away, because its ledger may hold entries.
4. **A party's ledger is not edited on its own.** Its name and status follow the party; altering it (or deactivating it) directly is refused with a pointer to
   the party. Opening the ledger in the interface says whose it is, and *Alter* on it opens the party.
5. **The database commits all of it or none.** `master_apply` accepts `{ changes: [...] }` (a single `{kind, op, id, row}` is still accepted) and
   applies them in order in one transaction: one version bump, one audit entry per record. Backstop triggers re-enforce what the application already
   enforces: a party ledger sits under the right group and never moves to another party or role; a party may gain a role but never lose one;
   one ledger per party and role; a role needs a party. The search index shows one hit per party (with its roles) and none for the party's own ledgers.
   `MasterOutcome.created` lists the extra records so the caller can act on them — the party form posts each opening balance to the ledger it just got, with its bill reference.
6. **Addresses live on the party.** Billing is `address`, `stateCode`, `pincode`, `country`; shipping is an optional `shipping` object (absent means "same as billing").
   The Party Details window in a voucher prefills both from the party; the address book (extra saved addresses) is unchanged. Pincodes are six digits and
   state codes are GST state codes, validated by the same domain code in the browser and on the server.
7. **The forms stay generic.** The party form is a field list like every other (`books/forms.ts`), with three small additions to the field model —
   a section `heading`, a `visibleIf` rule and a per-record `choicesFor` — plus `toData`/`fromRecord` hooks where a form's shape differs from the record
   (Type ↔ roles, Ship to ↔ shipping). Opening balances are form-only fields, posted after the party exists. The ledger form no longer offers Sundry
   Debtors/Creditors ("customers and suppliers are created as a Party") and lost its Party field (kept hidden so altering an older linked ledger keeps its link).
8. **Go To and vouchers.** One hit per party (subtitle "Customer · Vendor · GSTIN…"); actions Display, Alter and a *Ledger report* per ledger ("as customer" / "as vendor"
   when both). In a voucher a receipt offers a both-party's customer ledger first and a payment its vendor ledger first; **Alt+C** on a party line asks *Ledger* or
   *Customer / Vendor (Party)* — Party opens the party form (type pre-set from the voucher), and the voucher returns with the right ledger chosen. A cash/bank
   account is always just a ledger, so Alt+C goes straight to Create Ledger there.

## Consequences
- Existing tests that described the old two-step flow changed, each for that reason: Go To no longer lists a ledger *and* a party of one name (the party is one hit, and
  `l:` finds only non-party ledgers); the party form has a Type field after the name; the ledger form has one field fewer; Alt+C in a voucher asks first; the ledger form's
  Alt+C-to-create-a-party test became "there is nothing to link". Everything else is untouched.
- **Not enforced in the engine:** that a ledger under Sundry Debtors/Creditors must belong to a party. Tests and older data create such ledgers directly and still work; the
  ledger form simply does not offer those groups. (An earlier plan made it a rule; the cost was rewriting most seeds in the test suite for little safety, since a party-owned
  ledger is already protected.)
- A company saved in the browser before this change still replays its log (old parties have no roles and make no ledgers). Altering such a party to give it a role tries to
  create a ledger with its name and is refused if the old hand-made ledger already has that name — load the demo company again, or create the party anew.
- Deferred: a party statement that nets its two ledgers; removing a role; balance-based deactivation; Phase 6b sales documents, which will choose the ledger by document type.
