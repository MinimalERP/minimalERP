import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { BankStatementRow, ParsedStatement } from './bankStatementCsv';

GlobalWorkerOptions.workerSrc = workerUrl;

interface TextItemLike {
  readonly str: string;
  readonly transform: readonly number[];
}

const dateFromYesBank = (text: string): BankStatementRow['date'] | undefined => {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!match) return undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` as BankStatementRow['date'];
};

const amountFromText = (text: string): bigint | undefined => {
  const cleaned = text.replace(/[₹,\s]/g, '').replace(/[()]/g, (c) => c === '(' ? '-' : '').replace(/\)$/, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const negative = cleaned.startsWith('-');
  const [whole = '0', fraction = ''] = cleaned.replace(/^-/, '').split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -minor : minor;
};

/** Reads the transaction table from a text-based YES BANK consolidated monthly statement. The password is held only for this call. */
export async function parseYesBankPdf(data: Uint8Array, password: string): Promise<ParsedStatement> {
  const document = await getDocument({ data, password, useWorkerFetch: false, isEvalSupported: false }).promise;
  const rows: BankStatementRow[] = [];
  const errors: { row: number; message: string }[] = [];
  try {
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const textItems = content.items.filter((item): item is typeof item & TextItemLike => 'str' in item && 'transform' in item);
    const allText = textItems.map((item) => item.str).join(' ');
    if (!/withdrawals/i.test(allText) || !/deposits/i.test(allText)) continue;
    const height = page.getViewport({ scale: 1 }).height;
    const items = textItems
      .map((item) => ({ text: item.str.trim(), x: item.transform[4] ?? 0, top: height - (item.transform[5] ?? height) }))
      .filter((item) => item.text !== '')
      .sort((a, b) => a.top - b.top || a.x - b.x);

    let current: { date: BankStatementRow['date']; description: string[]; reference: string[]; debit: bigint; credit: bigint; balance?: bigint } | undefined;
    const commit = () => {
      if (!current) return;
      if (current.debit === 0n && current.credit === 0n) {
        errors.push({ row: rows.length + errors.length + 1, message: `No withdrawal or deposit amount was found for ${current.date}.` });
      } else {
        rows.push({ date: current.date, description: current.description.join(' ').trim(), reference: current.reference.join(' ').trim(), debit: current.debit, credit: current.credit, ...(current.balance === undefined ? {} : { balance: current.balance }) });
      }
    };

    for (const item of items) {
      if (item.x < 135 && /^(opening|total|closing|transaction\s+codes?)/i.test(item.text)) {
        commit();
        current = undefined;
        continue;
      }
      const date = item.x < 86 ? dateFromYesBank(item.text) : undefined;
      if (date) {
        commit();
        current = { date, description: [], reference: [], debit: 0n, credit: 0n };
        continue;
      }
      if (!current) continue;
      if (item.x >= 345) {
        const amount = amountFromText(item.text);
        if (amount === undefined) continue;
        if (item.x < 415) current.debit = amount < 0n ? -amount : amount;
        else if (item.x < 480) current.credit = amount < 0n ? -amount : amount;
        else current.balance = amount;
      } else if (item.x >= 270) current.reference.push(item.text);
      else if (item.x >= 135) current.description.push(item.text);
    }
    commit();
  }

  if (rows.length === 0 && errors.length === 0) {
    return { rows: [], errors: [{ row: 1, message: 'No YES BANK transaction table could be read. Scanned/image-only PDFs are not supported; use a text-based statement PDF.' }] };
  }
  return { rows, errors };
  } finally {
    await document.destroy();
  }
}
