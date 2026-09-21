import { type JournalLine, journalLineFromWire, parseMoney, ZERO, formatMoney } from '@minimalerp/domain';
import type { JournalQuery, JournalRepository } from '@minimalerp/ports';
import type { SupabaseLike } from './client';

/** PostgREST returns at most 1000 rows per request by default; we page until a short page. */
export const PAGE_SIZE = 1000;

/**
 * Reads journal lines through PostgREST. Row-level security decides what the signed-in user may see
 * (report.view, own company only) — the adapter adds no filtering of its own beyond the query.
 * Amounts are selected as TEXT (`debit::text`): PostgREST would otherwise send JSON numbers, which lose
 * precision beyond 2^53.
 */
export class SupabaseJournalRepository implements JournalRepository {
  constructor(private readonly client: SupabaseLike) {}

  async lines(query: JournalQuery): Promise<readonly JournalLine[]> {
    const out: JournalLine[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      let q = this.client
        .from('journal_lines')
        .select('voucher_id, line_no, entry_date, ledger_id, debit:debit::text, credit:credit::text, narration')
        .eq('company_id', query.companyId);
      if (query.ledgerId !== undefined) q = q.eq('ledger_id', query.ledgerId);
      if (query.voucherId !== undefined) q = q.eq('voucher_id', query.voucherId);
      if (query.from !== undefined) q = q.gte('entry_date', query.from);
      if (query.to !== undefined) q = q.lte('entry_date', query.to);
      q = q
        .order('entry_date', { ascending: true })
        .order('voucher_id', { ascending: true })
        .order('line_no', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      const { data, error } = await q;
      if (error) throw new Error(`Could not read the journal: ${error.message}`);
      const rows = data ?? [];
      for (const row of rows) out.push(lineFromRow(row));
      if (rows.length < PAGE_SIZE) return out;
    }
  }
}

function lineFromRow(row: Record<string, unknown>): JournalLine {
  const debit = parseMoney(String(row['debit'])) ?? ZERO;
  const credit = parseMoney(String(row['credit'])) ?? ZERO;
  return journalLineFromWire({
    voucherId: String(row['voucher_id']),
    lineNo: Number(row['line_no']),
    date: String(row['entry_date']),
    ledgerId: String(row['ledger_id']),
    side: debit > 0n ? 'debit' : 'credit',
    amount: formatMoney(debit > 0n ? debit : credit),
    narration: typeof row['narration'] === 'string' ? row['narration'] : null,
  });
}
