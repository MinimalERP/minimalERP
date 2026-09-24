/**
 * CSV, read and written, with no library: the format is simple and well-known enough that a hand-rolled
 * RFC4180-ish reader/writer keeps parity with the rest of this package (only `zod` is a real dependency).
 * Used by the GST reports' export (`csvOf`, promoted from what was a private helper there) and by the
 * bulk Import/Export feature and the Zoho migration script (`parseCsv`/`parseCsvRecords`).
 */

/** Quotes a cell only when it must be (a comma, quote or newline), doubling any quote inside it. */
export function csvOf(rows: readonly (readonly (string | number)[])[]): string {
  return rows.map((r) => r.map((c) => (typeof c === 'string' && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : String(c))).join(',')).join('\n');
}

/** Parses CSV text into rows of cells: quoted fields, embedded commas/newlines inside them, `""` for a literal quote,
 *  and either CRLF or LF line endings. A trailing newline at end of file does not produce an extra empty row. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** `parseCsv`, with the first row as column names: one object per remaining row, keyed by header text (trimmed). A row
 *  shorter than the header simply has "" for the missing columns; a row longer than it drops the extra cells. */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim());
  return rows.slice(1).map((row) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      rec[h] = row[i] ?? '';
    });
    return rec;
  });
}
