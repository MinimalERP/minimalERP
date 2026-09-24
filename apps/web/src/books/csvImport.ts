import { deterministicUuid, parseItemsCsv, parsePartiesCsv, parseVouchersCsv, resolveItemRow, resolvePartyRow } from '@minimalerp/domain';
import type { Books } from './books';

export interface BulkImportSummary {
  readonly created: number;
  readonly updated: number;
  readonly errors: readonly { readonly row: number; readonly message: string }[];
}

/** Items and Parties import DIRECTLY in bulk (they're master data — nothing to review row by row): each row is
 *  matched against the company's masters by name (case-insensitive, the same key the database itself enforces
 *  uniqueness on); a match becomes an alteration of the existing record, no match a new one with a deterministic
 *  id (so re-running the same file twice is a safe, idempotent replay, not a duplicate). */
export async function importItemsCsv(books: Books, csvText: string): Promise<BulkImportSummary> {
  const rows = parseItemsCsv(csvText);
  let created = 0;
  let updated = 0;
  const errors: { row: number; message: string }[] = [];
  await books.bulk(async () => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as NonNullable<(typeof rows)[number]>;
      const resolved = resolveItemRow(row, books.masters);
      if (!resolved.ok) {
        errors.push({ row: i + 1, message: resolved.errors.join('; ') });
        continue;
      }
      const existing = books.masters.stockItems.find((it) => it.name.toLowerCase() === row.name.toLowerCase());
      const id = existing?.id ?? deterministicUuid(`import|stockItem|${row.name.toLowerCase()}`);
      const done = await books.execute({ op: existing ? 'alter' : 'create', kind: 'stockItem', id, data: resolved.data });
      if (!done.ok) errors.push({ row: i + 1, message: done.issues.map((iss) => iss.message).join('; ') });
      else if (existing) updated++;
      else created++;
    }
  });
  return { created, updated, errors };
}

export async function importPartiesCsv(books: Books, csvText: string): Promise<BulkImportSummary> {
  const rows = parsePartiesCsv(csvText);
  let created = 0;
  let updated = 0;
  const errors: { row: number; message: string }[] = [];
  await books.bulk(async () => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as NonNullable<(typeof rows)[number]>;
      const resolved = resolvePartyRow(row);
      if (!resolved.ok) {
        errors.push({ row: i + 1, message: resolved.errors.join('; ') });
        continue;
      }
      const existing = books.masters.parties.find((p) => p.name.toLowerCase() === row.name.toLowerCase());
      const id = existing?.id ?? deterministicUuid(`import|party|${row.name.toLowerCase()}`);
      const done = await books.execute({ op: existing ? 'alter' : 'create', kind: 'party', id, data: resolved.data });
      if (!done.ok) errors.push({ row: i + 1, message: done.issues.map((iss) => iss.message).join('; ') });
      else if (existing) updated++;
      else created++;
    }
  });
  return { created, updated, errors };
}

export interface VoucherImportSummary {
  readonly staged: number;
  readonly errors: readonly { readonly docRef: string; readonly message: string }[];
}

/** Vouchers and Sales Orders import via the SAME AI Inbox staged review as any other document: each `docRef`
 *  group becomes one queued proposal, reviewed and accepted one at a time (Alt+C fixes an unmatched party/item),
 *  never posted directly by the import itself. */
export async function importVouchersCsv(books: Books, csvText: string): Promise<VoucherImportSummary> {
  const entries = parseVouchersCsv(csvText);
  let staged = 0;
  const errors: { docRef: string; message: string }[] = [];
  for (const entry of entries) {
    const sent = await books.sendDocument(entry.kind, { extraction: entry.extraction }, entry.docRef);
    if (!sent.ok) errors.push({ docRef: entry.docRef, message: sent.issues.map((iss) => iss.message).join('; ') });
    else staged++;
  }
  return { staged, errors };
}
