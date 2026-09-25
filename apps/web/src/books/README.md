# Books layer (`apps/web/src/books`)

The open company lives here: what the UI reads and writes, and where it is stored.

| Module | Role |
|--------|------|
| `books.ts` | `BooksHost` — the façade commands and screens use (`masters`, `vouchers`, `post`, `stock`, …). |
| `local.ts` / `cloud.ts` | Factories that build a `BooksHost` from in-memory + IndexedDB or from Supabase + the Edge Function. Wired only in `main.tsx`. |
| `store.ts` / `idb.ts` | Persistence for the in-browser company snapshot and draft vouchers. |
| `saving.ts` | Tracks in-flight saves for the status bar / overlay (`SaveTracker`). |
| `entities.ts` | Normalised in-memory shapes the host keeps (vouchers, lines, masters snapshot). |
| `forms.ts` | Master create/edit payloads (party, ledger, stock item, …) used by master screens. |
| `demo.ts` | Demo company seed for “Load Demo Company”. |
| `csvImport.ts` | CSV import helpers for the import/export screen. |
| `voucherDocs.ts` | Helpers to load voucher documents for display. |

**Rule:** posting still goes `VoucherService` → domain → adapter; nothing in `books/` derives balances or writes the journal directly.

See `docs/architecture.md` §3–4 and ADR-0020 (online books).
