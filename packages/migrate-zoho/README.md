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
