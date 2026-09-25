# MinimalERP for Google Workspace

Two things, both in one Apps Script project (ADR-0023):

- **Send to ERP**: a panel in Gmail. Open a customer's PO, a supplier's bill or a payment advice, pick the attachment (or the mail text) and
  press **Send to ERP → Sales Order / Purchase Bill / Sales Invoice / Receipt / Payment**. Gemini reads it on the ERP's server, the ERP
  matches the party and the items, and the result waits in **Transactions › AI Inbox** as a *proposal*. Nothing is posted until you open it
  there, complete it (items the ERP does not know show the mail's own words: Enter picks one, Alt+C creates it) and accept it with Ctrl+A.
  **Send to ERP → Eclipse Receipt** is for Eclipse Combustion's remittance advice PDF: the ERP reads it by a fixed rule, not Gemini (each
  invoice settled by Net + WHT, WHT as TDS; the GST Hold stays open), so it is in the AI Inbox in seconds. A PDF the rule does not
  recognise, or whose rows do not add up to its total, arrives as a line saying so — it is never guessed.
- **Daily report**: every morning at 8 a mail to you with yesterday's sales, purchases, receipts and payments, receivables and what is
  overdue, what to pay this week, **every customer order item that is late or due this week, with its due date and customer PO**, the GST
  net for the month, and how many documents wait in the AI Inbox. Optionally the same figures go into a Google Sheet.

Nothing watches your mailbox: a mail reaches the ERP only when you press a button, and the add-on can read only the mail that is open.
The ERP keeps only the proposal (and the mail's subject and sender) until you accept or reject it — never the document.

## One-time setup

### 1. Gemini key (free)
1. Go to <https://aistudio.google.com/apikey> with your Google account and create an API key.
2. Choose the model: one that reads PDFs and images on the free tier (a current *Flash* model). The name is set as a secret below, so a
   renamed or newer model is a secret change, not a code change.

> **Free tier, know this:** on Google's free tier, what is sent (the document and its reading) may be used by Google to improve its
> products and may be seen by reviewers. Your customers' and suppliers' documents are included. A paid key (same code, only the secret
> changes) is not used that way. The free tier also limits requests per minute and per day: when the limit is hit the panel says
> "try again in a minute" and nothing is lost.

### 2. The ERP side (Supabase)
From outside the repository (see `supabase/README.md`):

```
supabase db push --project-ref <ref>                         # adds the AI Inbox table and the `automation` role
pnpm build:functions                                         # builds post-voucher and intake
supabase functions deploy post-voucher --project-ref <ref>
supabase functions deploy intake --project-ref <ref>
supabase secrets set GEMINI_API_KEY=<key> GEMINI_MODEL=<model> --project-ref <ref>
```

### 3. The add-on's own sign-in
The add-on signs in as its own ERP user, which can send documents and read reports and **cannot post anything**.

1. Supabase › Authentication › Users › *Add user*: e.g. `erp-bot@yourdomain`, with a long password (not an invitation).
2. SQL editor, once (with your company's id from `select id, name from companies`):
   ```sql
   insert into public.company_members (company_id, user_id, role)
   select '<company id>', id, 'automation' from auth.users where email = 'erp-bot@yourdomain';
   ```

### 4. The Apps Script project
1. <https://script.google.com> › New project, name it *MinimalERP*.
2. Project Settings › *Show "appsscript.json"*; replace its content with `appsscript.json` from this folder. Add the three `.gs` files
   (`Erp.gs`, `SendToErp.gs`, `DailyReport.gs`) with the same content.
3. Project Settings › **Script properties**:

   | Property | Value |
   |---|---|
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `SUPABASE_ANON_KEY` | the project's anon key (public by design) |
   | `ERP_EMAIL` / `ERP_PASSWORD` | the add-on's sign-in from step 3 |
   | `REPORT_TO` | your address — the daily report goes only here |
   | `REPORT_SHEET_ID` | optional: the id of a Google Sheet (from its URL) for the figures |
   | `COMPANY_ID` | optional: only if that sign-in belongs to more than one company |

4. **Deploy › Test deployments › Gmail › Install**. Open any mail: the MinimalERP icon appears in Gmail's right-hand panel. Google asks
   you to allow the permissions once.
5. For the daily report: in the editor choose `installDailyReport` and **Run** (once). Run `sendDailyReport` to see a report now.

### 5. Emailing vouchers to their party (optional)

Alt+E on a saved Sales Invoice, Sales Order, Quotation, Purchase or Purchase Order emails it to that party from your Gmail
(`SendVoucher.gs`). You may attach your own PDF — for example one you printed from the ERP and signed with your DSC in Adobe.

1. Script properties: add `MAIL_SECRET` — a long random string (e.g. from a password generator).
2. **Deploy › New deployment**, type **Web app**, *Execute as: Me*, *Who has access: Anyone*. Copy the `/exec` address.
   (Anyone can reach the address, but a request without the secret is refused; only the ERP's server knows it.)
3. Give the ERP the address and the secret (from outside the repository, see `supabase/README.md`):
   `supabase secrets set MAIL_SCRIPT_URL=<the /exec address> MAIL_SCRIPT_SECRET=<the same secret> --project-ref <ref>`
4. The mail goes from your Gmail and shows in your Sent folder. Gmail allows about 100 recipients a day on a personal account,
   1,500 on Google Workspace.

## What it may do (the permissions it asks for)
- `gmail.addons.current.message.readonly` — read the mail you have open, when you use the panel (not your mailbox)
- `script.external_request` — talk to the ERP
- `script.send_mail` — send the daily report to `REPORT_TO`
- `script.scriptapp` — run the report at 8 every day
- `spreadsheets` — write the figures into the sheet you named

It does not ask to change your mail. Which mails were already sent to the ERP is remembered in your own Google account (so sending one twice
asks first), not in the ERP.
