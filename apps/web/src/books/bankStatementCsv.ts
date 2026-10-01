import type { JournalLine, LocalDate } from '@minimalerp/domain';

export interface BankStatementRow {
  readonly date: LocalDate;
  readonly description: string;
  readonly reference: string;
  /** Positive values from the bank's debit / credit columns. */
  readonly debit: bigint;
  readonly credit: bigint;
  readonly balance?: bigint;
}

export interface ParsedStatement {
  readonly rows: readonly BankStatementRow[];
  readonly errors: readonly { readonly row: number; readonly message: string }[];
}

/** Parse common YES BANK and generic bank CSV exports without assuming a fixed column order. */
export function parseBankStatementCsv(text: string): ParsedStatement {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return { rows: [], errors: [{ row: 1, message: 'The CSV must contain a header and at least one transaction.' }] };
  const delimiter = (lines[0]?.match(/;/g)?.length ?? 0) > (lines[0]?.match(/,/g)?.length ?? 0) ? ';' : ',';
  const cells = (line: string) => {
    const result: string[] = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (char === '"' && line[i + 1] === '"' && quoted) { value += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (char === delimiter && !quoted) { result.push(value.trim()); value = ''; }
      else value += char;
    }
    result.push(value.trim());
    return result;
  };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const header = cells(lines[0]!).map(norm);
  const find = (...names: string[]) => header.findIndex((h) => names.some((name) => h === name || h.includes(name)));
  const dateCol = find('transactiondate', 'valuedate', 'date');
  const descCol = find('description', 'narration', 'particulars', 'remarks');
  const refCol = find('referenceno', 'chequeno', 'chqno', 'utr', 'refno');
  const debitCol = find('debit', 'withdrawal', 'dr');
  const creditCol = find('credit', 'deposit', 'cr');
  const amountCol = find('amount', 'transactionamount');
  const balanceCol = find('balance', 'closingbalance');
  if (dateCol < 0 || (debitCol < 0 && creditCol < 0 && amountCol < 0)) {
    return { rows: [], errors: [{ row: 1, message: 'Required columns not found. Include Date and Debit/Credit columns, or Date and Amount.' }] };
  }
  const parseDate = (value: string): LocalDate | undefined => {
    const v = value.trim();
    let y = 0, m = 0, d = 0;
    let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(v);
    if (match) [, y, m, d] = match.map(Number) as [number, number, number, number];
    else {
      match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(v);
      if (!match) return undefined;
      const first = Number(match[1]), second = Number(match[2]), year = Number(match[3]);
      // Bank statements commonly use DD/MM/YYYY. If the first component cannot be a month, use DD/MM.
      if (first > 12) { d = first; m = second; } else { d = second; m = first; }
      y = year < 100 ? 2000 + year : year;
    }
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
    return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}` as LocalDate;
  };
  const parseMoney = (value: string): bigint | undefined => {
    const cleaned = value.replace(/[₹,\s]/g, '').replace(/[()]/g, (c) => c === '(' ? '-' : '').replace(/\)$/, '');
    if (!cleaned) return 0n;
    if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
    const neg = cleaned.startsWith('-');
    const [whole = '0', fraction = ''] = cleaned.replace(/^-/, '').split('.');
    const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    return neg ? -minor : minor;
  };
  const rows: BankStatementRow[] = [];
  const errors: { row: number; message: string }[] = [];
  lines.slice(1).forEach((line, index) => {
    const row = cells(line);
    const date = parseDate(row[dateCol] ?? '');
    const rawDebit = debitCol >= 0 ? parseMoney(row[debitCol] ?? '') : 0n;
    const rawCredit = creditCol >= 0 ? parseMoney(row[creditCol] ?? '') : 0n;
    const rawAmount = amountCol >= 0 ? parseMoney(row[amountCol] ?? '') : undefined;
    if (!date) { errors.push({ row: index + 2, message: 'Invalid date.' }); return; }
    if (rawDebit === undefined || rawCredit === undefined || (amountCol >= 0 && rawAmount === undefined)) { errors.push({ row: index + 2, message: 'Invalid debit, credit or amount.' }); return; }
    let debit = rawDebit < 0n ? -rawDebit : rawDebit;
    let credit = rawCredit < 0n ? -rawCredit : rawCredit;
    if (debitCol < 0 && creditCol < 0 && rawAmount !== undefined) {
      const amount = rawAmount;
      if (amount < 0n) debit = -amount; else credit = amount;
    }
    if (debit > 0n && credit > 0n) { errors.push({ row: index + 2, message: 'A transaction cannot have both debit and credit amounts.' }); return; }
    const balance = balanceCol >= 0 ? parseMoney(row[balanceCol] ?? '') : undefined;
    if (balance === undefined && balanceCol >= 0) { errors.push({ row: index + 2, message: 'Invalid balance.' }); return; }
    rows.push({ date, description: descCol >= 0 ? row[descCol] ?? '' : '', reference: refCol >= 0 ? row[refCol] ?? '' : '', debit, credit, ...(balanceCol >= 0 && balance !== undefined ? { balance } : {}) });
  });
  return { rows, errors };
}

export interface StatementMatch {
  readonly row: BankStatementRow;
  readonly journalLine?: JournalLine;
}

/** Match each statement row at most once, by date, amount and bank-side direction. */
export function matchStatementRows(rows: readonly BankStatementRow[], lines: readonly JournalLine[], ledgerId: string): StatementMatch[] {
  const available = lines.filter((line) => line.ledgerId === ledgerId);
  const used = new Set<string>();
  return rows.map((row) => {
    // Bank debit means cash received; bank credit means cash paid.
    const side = row.debit > 0n ? 'credit' : 'debit';
    const amount = row.debit > 0n ? row.debit : row.credit;
    const candidate = available.find((line) => {
      const key = `${line.voucherId}:${line.lineNo}`;
      return !used.has(key) && line.date === row.date && line.side === side && line.amount === amount;
    });
    if (candidate) used.add(`${candidate.voucherId}:${candidate.lineNo}`);
    return { row, ...(candidate ? { journalLine: candidate } : {}) };
  });
}
