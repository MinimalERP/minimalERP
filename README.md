# MinimalERP

A browser-based, Tally-style accounting + ERP application: a real posting engine with a keyboard-first
interaction layer and Universal Search / Go To (Alt+G) at the centre of navigation.
Manufacturing-focused; India / INR / GST first.

**Read [docs/architecture.md](docs/architecture.md) first.** Decisions are recorded in [docs/adr/](docs/adr/).

```
Gateway → Universal Search/Go To → Masters → Vouchers → Posting Engine → Books → Reports → Drill-down
```

Invariant: every posted transaction flows `Voucher → Validation → Posting Engine → Journal / Stock ledger → Reports`,
and `Total Debit = Total Credit`. The UI never manipulates balances.

## Setup

Requires Node ≥ 22 and pnpm (version pinned in `package.json`):

```
corepack enable        # or: npm i -g pnpm
pnpm install
pnpm dev               # web app. (Plain `npm run dev` at the repo root is refused by npm because the root pins Deno in
                       # devEngines for the Edge Function tests; `cd apps/web && npm run dev` works without pnpm.)
pnpm test              # fast unit tests (domain, in-memory backend, adapters, guardrails)
pnpm test:db           # real PostgreSQL (embedded, no Docker): migrations, RLS, triggers, concurrency, Edge Function on Deno
pnpm test:e2e          # real-browser, keyboard-only tests (uses your installed Chrome; CI installs Chromium)
pnpm check             # everything: typecheck + lint + boundaries + unit + db + build + e2e (what CI runs)
```

## Try it

`pnpm dev`, open the link, press **Alt+G** and type `demo` → *Load Demo Company*. Then Alt+G again and try `abc`
(a party and a stock item), `@27AAPFU` (a GSTIN), `i:bolt`, `l:rent`, or `industrys` (a typo). Press **→** on a result
for more actions. *Masters → Parties → Alt+C* creates a customer, a vendor or both in one form (billing and shipping address, terms, opening balances) — its ledgers come with it. *Masters → Create Ledger* is fully keyboard-driven: Enter/Tab next field, Shift+Tab back, **Ctrl+A** accept,
**Esc** back; in a picker, **Alt+C** creates the missing record and returns to where you were. The company is kept in this
browser (IndexedDB); *Close Company* forgets it.

**Vouchers and books:** press **F5** (Payment), **F6** (Receipt), **F4** (Contra) or **F7** (Journal). Inside a voucher the same keys *switch
the type* (the bottom bar lists them), **F2** changes the date, **Ctrl+A** accepts, **Alt+C** creates a missing ledger or party and returns, **Alt+P**
opens Party Details (billing / shipping, GSTIN). Paying a supplier offers its open bills. Then *Alt+G → day book*: **Alt+S** sorts the
column (Tab picks it), **Alt+L** filters it, **Alt+T** filters by voucher type, **Alt+K** clears, **Enter** opens a voucher and **Esc**
brings you back to the same row. **F10** opens a Stock Journal (stock moving between godowns or being converted — no accounting effect; stock can never go below zero), and *Alt+G → stock summary* shows every item's opening, inward, outward and closing stock with its value (**Enter** on an item opens its ledger). **F8** opens a Sales Invoice and **Shift+F8** a Sales Order (one window; each line of an order has its own due date; an invoice can be entered against order lines, and over-delivery is refused). Choosing a customer's Cust PO brings the remaining items of that order; **Alt+I** on an order invoices what is pending. *Alt+G → sales order register* shows every order line with its fill (12/18) and status; the Stock Summary shows what is committed to open orders. *Gateway → Transactions* is grouped (Sales, Purchase, Inventory, General): each row opens the **list** of that voucher type (newest first; sales orders show Open / Partially filled / Closed, invoices Open / Paid / Overdue) with **New** on its panel; **Ctrl+A** saves and closes back to the list, **Alt+N** saves and starts a new one. A new stock item can bring its opening stock. *Alt+G → ledger* (or a ledger in Go To → **→** → *Ledger report*) shows a running balance. *Gateway → Reports* is grouped: **Statements** (Trial Balance — every primary group with opening, debit, credit and closing, **Enter** opens a group, then a ledger; Profit & Loss and Balance Sheet, both two-sided, **F2** sets the period / "as on" date, **Enter** on a line opens its group), **Books** (Day Book, Ledger, Cash Book, Bank Book), **Outstanding** (receivables and payables: a row per party with its bills aged from each bill's due date — not yet due, 1–30, 31–60, 61–90, over 90 days — plus advances and what is not in a bill; **Enter** on a party lists its bills, **Enter** on a bill opens the voucher), and **Inventory & Sales** (Stock Summary, Sales Order Register). **F9** opens a Purchase Invoice and **Shift+F9** a Purchase Order — the same window as Sales, for buying: the supplier, our PO, the purchase ledger, the **supplier's invoice number** (it names the bill, and can be used once per supplier), a godown to receive into, and a line can be received against an order line (receiving more than is pending is refused). A purchase brings the stock in at its rate, books the purchase and raises the supplier's bill — which then ages in *Outstanding Payables* and is settled by a Payment against that number. **Alt+I** on a Purchase Order makes the invoice for what is pending on it; *Reports › Purchase Order Register* shows every order line, and the Stock Summary shows what is **On order**. **GST**: in *Company Settings* set **Charge GST** to Yes (the demo company ships with it off) and every Sales/Purchase invoice gets a **GST %** per line (from the item, editable) — CGST + SGST inside the state, IGST outside it — with the tax in the invoice total, the bill and the Output/Input GST ledgers. On a **Receipt**, a bill line has a **TDS** cell: the bank gets the amount less the TDS, *TDS Receivable* holds it and the bill settles in full. *Reports › GST* has **GSTR-1** (by invoice and rate, **Alt+V** for the HSN summary, **F2** for the financial year and month, a check of what is missing, then **Alt+B** exports JSON / **Alt+M** CSV) and **GSTR-3B** (output tax, input tax *to review* — never claimed automatically — and the net); every figure opens the invoice behind it and reconciles to its tax ledger.

## Layout

| Path | Role |
|---|---|
| `apps/web` | Vite + Preact shell, generic screens, feature modules (`modules/`), the open company (`books/`), UI primitives. Composition root is `src/main.tsx`. |
| `packages/domain` | Pure accounting/ERP logic. No I/O, no DOM, no framework. |
| `packages/ports` | Interfaces (repositories, gateways). |
| `packages/adapter-memory` | In-memory ports: the reference implementation and test oracle. |
| `packages/adapter-postgres` | Server-side posting service over PostgreSQL (runs in the Edge Function). |
| `packages/adapter-supabase` | Browser adapter: calls the Edge Function, reads under RLS. |
| `packages/db-tests` | Integration tests against a real PostgreSQL. A leaf: nothing imports it. |
| `packages/command` | Command Registry, Universal Search (Go To) service and providers, recents/favourites, screen stack. |
| `packages/keyboard` | Chords, keymap (+ persisted overrides), scope stack, the one KeyboardManager, list/form/grid navigators. |
| `packages/testkit` | Demo company, scenario builders, property-test generators, and cross-package behaviour tests. |
| `supabase/` | Migrations and the `post-voucher` Edge Function. See `supabase/README.md`. |

Layering is enforced by `pnpm boundaries` and ESLint; `tooling/guards.test.ts` proves the guards fail when violated.
