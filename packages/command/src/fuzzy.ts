/**
 * Forgiving text matching for Go To. Typing "trb", "trial bal", "trail balance" (a typo) or
 * "daybook" (missing space) should all find "Trial Balance" / "Day Book", best matches first.
 *
 * Every whitespace-separated term of the query must match somewhere; the score is the average of
 * how well each did. From best to worst a term can match as:
 *   the whole word · the start of a word · inside a word · across joined words · a typo · scattered letters
 */
export interface Match {
  /** 0..1; higher is better. */
  readonly score: number;
  /** [start, end) ranges in the ORIGINAL target to highlight. Empty when the match has no clean location. */
  readonly ranges: readonly (readonly [number, number])[];
}

/** Lower-case, accent-stripped. */
export const normalize = (s: string): string =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

interface Word {
  readonly text: string;
  readonly start: number;
}

function wordsOf(normalized: string): Word[] {
  const out: Word[] = [];
  for (const m of normalized.matchAll(/[a-z0-9]+/g)) out.push({ text: m[0], start: m.index ?? 0 });
  return out;
}

/** Optimal-string-alignment distance (edits + adjacent transposition), which is what typos look like. */
export function editDistance(a: string, b: string): number {
  const prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, (prev2[j - 2] ?? Number.POSITIVE_INFINITY) + 1);
      }
      cur[j] = d;
    }
    prev2.splice(0, prev2.length, ...prev);
    prev = cur;
  }
  return prev[b.length] as number;
}

const rowA = new Int16Array(96);
const rowB = new Int16Array(96);
const rowC = new Int16Array(96);

/**
 * `editDistance(a, b) <= max`, without allocating and without finishing the table once every path is already too
 * expensive. Searching thousands of records per keystroke is dominated by this test, and almost every record fails it early.
 */
export function withinEdits(a: string, b: string, max: number): boolean {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return false;
  if (m >= rowA.length || n >= rowA.length) return editDistance(a, b) <= max;
  let prev2 = rowC;
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const bj = b.charCodeAt(j - 1);
      let d = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (ai === bj ? 0 : 1));
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj) d = Math.min(d, (prev2[j - 2] as number) + 1);
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return false;
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return (prev[m] as number) <= max;
}

interface TermMatch {
  readonly score: number;
  readonly ranges: readonly (readonly [number, number])[];
}

function matchTerm(term: string, view: PreparedTarget): TermMatch | undefined {
  const { text: target, words, joined } = view;
  let best: TermMatch | undefined;
  const consider = (m: TermMatch) => {
    if (!best || m.score > best.score) best = m;
  };

  const exact = words.find((w) => w.text === term);
  if (exact) consider({ score: 0.95, ranges: [[exact.start, exact.start + term.length]] });

  const prefixIdx = words.findIndex((w) => w.text.startsWith(term));
  if (prefixIdx !== -1) {
    const w = words[prefixIdx] as Word;
    consider({ score: prefixIdx === 0 ? 0.9 : 0.85, ranges: [[w.start, w.start + term.length]] });
  }

  for (const w of words) {
    const at = w.text.indexOf(term);
    if (at > 0) {
      consider({ score: 0.65, ranges: [[w.start + at, w.start + at + term.length]] });
      break;
    }
  }

  // "daybook" inside "day book": matches across word boundaries.
  if (term.length >= 3 && joined.includes(term)) consider({ score: 0.6, ranges: [] });

  // The remaining stages score at most 0.5 (typo) and 0.45 (abbreviation): skip them once something is already better.
  if (best && (best as TermMatch).score >= 0.5) return best;

  if (term.length >= 4) {
    const allowed = term.length >= 8 ? 2 : 1;
    for (const w of words) {
      // An edit distance can never be smaller than the difference in length: skip the expensive comparison.
      if (w.text.length + allowed < term.length) continue;
      if (withinEdits(term, w.text.slice(0, term.length), allowed) || (w.text.length <= term.length + allowed && withinEdits(term, w.text, allowed))) {
        consider({ score: 0.5, ranges: [[w.start, w.start + w.text.length]] });
        break;
      }
    }
  }

  // Scattered letters are an ABBREVIATION ("trb" → Trial Balance): short, and starting at the beginning of a
  // word. Anything looser matches long words by accident ("create" inside "Outstanding Receivables").
  const startsAWord = words.some((w) => w.text.startsWith(term[0] ?? ''));
  if (!best && term.length >= 2 && term.length <= 5 && startsAWord) {
    const positions: number[] = [];
    let from = 0;
    for (const ch of term) {
      const at = target.indexOf(ch, from);
      if (at === -1) break;
      positions.push(at);
      from = at + 1;
    }
    if (positions.length === term.length) {
      const span = (positions.at(-1) as number) - (positions[0] as number) + 1;
      const ranges: [number, number][] = [];
      for (const p of positions) {
        const last = ranges.at(-1);
        if (last && last[1] === p) last[1] = p + 1;
        else ranges.push([p, p + 1]);
      }
      consider({ score: 0.25 + 0.2 * (term.length / span), ranges });
    }
  }
  return best;
}

/** A target string normalised and split into words once, so many queries (or many documents) do not repeat that work. */
export interface PreparedTarget {
  readonly original: string;
  readonly text: string;
  readonly words: readonly Word[];
  /** The words run together ("daybook" matches "Day Book"). */
  readonly joined: string;
  /** Highlight ranges are only trustworthy when normalisation did not change string length. */
  readonly rangesUsable: boolean;
}

export function prepareTarget(target: string): PreparedTarget {
  const text = normalize(target);
  const words = wordsOf(text);
  return { original: target, text, words, joined: words.map((w) => w.text).join(''), rangesUsable: text.length === target.length };
}

/**
 * The terms of a query. A term with no letters or digits (the "&" in "Profit & Loss") can never match a word;
 * it is dropped rather than letting it veto the whole query.
 */
export function queryTerms(query: string): string[] {
  return normalize(query).split(/\s+/).filter((t) => /[a-z0-9]/.test(t));
}

/**
 * Matches `query` against `target` (and, more weakly, against `extras` such as keywords).
 * Returns undefined if any term of the query matches nowhere.
 */
export function fuzzyMatch(query: string, target: string, extras: readonly string[] = []): Match | undefined {
  return matchPrepared(queryTerms(query), prepareTarget(target), extras.map(prepareTarget));
}

/** `fuzzyMatch` for callers that have already compiled the query and prepared the targets (a search over thousands of records). */
export function matchPrepared(terms: readonly string[], target: PreparedTarget, extras: readonly PreparedTarget[] = []): Match | undefined {
  if (terms.length === 0) return undefined;
  const { text: normTarget, words: targetWords, rangesUsable, original } = target;

  if (terms.length === 1 && normTarget === terms[0]) {
    return { score: 1, ranges: rangesUsable ? [[0, original.length]] : [] };
  }

  const scores: number[] = [];
  const ranges: (readonly [number, number])[] = [];
  for (const term of terms) {
    const inTarget = matchTerm(term, target);
    let bestScore = inTarget?.score ?? 0;
    let bestRanges = inTarget?.ranges ?? [];
    for (const view of extras) {
      const m = matchTerm(term, view);
      if (m && m.score * 0.8 > bestScore) {
        bestScore = m.score * 0.8;
        bestRanges = [];
      }
    }
    if (bestScore === 0) return undefined;
    scores.push(bestScore);
    ranges.push(...bestRanges);
  }

  let score = scores.reduce((a, b) => a + b, 0) / scores.length;
  // Prefer results that START with what was typed.
  if (targetWords[0]?.text.startsWith(terms[0] as string)) score += 0.04;
  score = Math.min(1, score);

  return { score, ranges: rangesUsable ? mergeRanges(ranges) : [] };
}

function mergeRanges(ranges: readonly (readonly [number, number])[]): (readonly [number, number])[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export interface Segment {
  readonly text: string;
  readonly match: boolean;
}

/** Splits `text` into alternating plain / highlighted pieces for rendering. */
export function highlightSegments(text: string, ranges: readonly (readonly [number, number])[] = []): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  for (const [s, e] of mergeRanges(ranges)) {
    if (s > at) segments.push({ text: text.slice(at, s), match: false });
    segments.push({ text: text.slice(s, e), match: true });
    at = e;
  }
  if (at < text.length) segments.push({ text: text.slice(at), match: false });
  return segments.length > 0 ? segments : [{ text, match: false }];
}
