# @minimalerp/migrate-zoho

A one-off script that stages a Zoho Books "Invoices" CSV export as **AI Inbox proposals** — the same
review queue Gmail- and Upload-sourced documents land in. It never posts anything: each invoice waits in
the Inbox until a person opens it, matches/creates the party and any unmatched items (Alt+C), and accepts
it (or rejects it).

## Why staging, not posting

The CSV is already structured data, so no OCR/reading step is needed — each invoice is turned directly into
the same `Extraction` shape a document reader would have produced, matched against the company's masters
with the existing AI Inbox matcher (`proposeFromExtraction`), and queued with `submitInbox`. Re-running the
script is safe: each invoice's inbox item id is derived deterministically from its Zoho Invoice ID, so
submitting the same invoice twice is a no-op.

## Usage

```
pnpm --filter @minimalerp/migrate-zoho stage -- \
  --csv /path/to/Invoice.csv \
  --company <company-uuid> \
  --actor <a company_members.user_id with inbox.submit permission> \
  --db-url postgres://... \
  [--only "26-27/001..26-27/090"] \
  [--out report.json]
```

- `--db-url` may instead be set via the `DATABASE_URL` environment variable. Get the connection string from
  the Supabase dashboard (Project Settings → Database) — it is a direct Postgres connection and bypasses
  RLS, so treat it like any other production credential. **Never commit it, and never commit the CSV** —
  both carry real customer and financial data.
- `--only` restricts the batch to a range (`"26-27/001..26-27/090"`, compared on the numeric part after the
  last `/`) or a comma-separated list of exact invoice numbers. Omit it to stage every invoice in the file.
- The report (`--out`, default `zoho-import-report.json`) lists, per Zoho invoice: the matched party (if
  any), any notes the proposal carries (unmatched party/items, a total mismatch), and the resulting Inbox
  item id — a checklist for working through the queue, not a pass/fail gate.

## What it does not do

- It does not post anything — accepting each queued item in the app **is** the posting step.
- It does not create parties ahead of time — an unmatched party is a note on the proposal, resolved the
  same way any AI Inbox item's unmatched party is (Alt+C, in the voucher window).
- It does not try to make totals match Zoho's `Round Off` column by adjusting a line's rate — minimalERP's
  own Round Off feature (rounding the posted total to the nearest rupee) accounts for it once the invoice is
  accepted.

## A previous financial year

Invoices dated before the company's first financial year need that year first: **Settings → Financial Years → create**, starting the
day after the earlier year begins (e.g. `2025-04-01` for 2025-26). The year brings a numbering series for every voucher type; set the
2025-26 Sales series' prefix to match Zoho's numbering, and if Zoho's first invoice is not number 1, move the series to it (Alt+N). Then
run `post` without `--commit` (a rehearsal that writes nothing), read `zoho-post-report.json`, and run it again with `--commit`.

`post` takes each line's GST rate from Zoho's CGST/SGST/IGST columns, and stops on any invoice whose total does not match Zoho's.

A Zoho number missing from the export (deleted or voided in Zoho) is posted as a ₹1 placeholder and cancelled at once, dated like the
invoice before it: the Sales register keeps every number, the missing ones shown as cancelled, and they count for nothing in the books.
The rehearsal lists them ("Missing in Zoho, will be posted as CANCELLED: …") before anything is written. The two halves of one year go in ONE run (`--csv Invoice.csv --csv Invoice1.csv`): Zoho sometimes numbers an invoice in one half but dates
it in the other (24-25/170), and only a single run sees that it is neither missing nor duplicated. A fraction of a whole-number unit
("18.50 Nos" of scrap) is posted as a description line, like a service. A line with no item name (only a
description) is posted as a description line, like a service, not as a stock item.

## Payments received (Receipts)

```
pnpm --filter @minimalerp/migrate-zoho receipts -- --csv 1.csv [--csv 2.csv] --company <uuid> --actor <uuid> --bank "Yes Bank" [--commit]
```

Zoho's "Payments Received" export (all fields): one Receipt per payment, into the bank or cash ledger `--bank` names for Zoho's "Deposit To" account (`--bank "Yes Bank 5491"` for all, or `--bank "Petty Cash=Cash"` per account; a plain one is the rest's), keeping Zoho's payment number, reference and notes in its narration, each settling the
invoices Zoho applied it to — for the amount applied plus the TDS the customer withheld (to TDS Receivable). An unused amount goes on
account (a Customer Advance: as an advance). The invoices must already be in the books: a payment naming one that is not, or settling
more than is open on it, stops the run before anything is written. A customer the books do not have is created. Re-running skips what
is already posted.
