import { type PreparedTarget, matchPrepared, normalize, prepareTarget, queryTerms } from './fuzzy';
import type { HitAction, ParsedQuery, SearchHit, SearchProvider } from './types';

/**
 * Anything that is not a command but can be found and opened: a ledger, a party, a stock item, later a voucher.
 * The app turns its master data into these; this package stays ignorant of what a ledger is.
 */
export interface EntityDoc {
  /** Stable identity, e.g. `ledger:<id>` — recents and favourites are keyed by it. */
  readonly key: string;
  /** "Ledger", "Party", "Stock Item" — the row label. */
  readonly kind: string;
  /** The `l:`/`@`/`i:` scope it answers to. */
  readonly scope: string;
  readonly title: string;
  /** Shown under the title and matched weakly: the group of a ledger, the GSTIN of a party. */
  readonly subtitle?: string | undefined;
  /** Exact-ish lookups that should win outright: code, alias, GSTIN, phone, HSN. */
  readonly identifiers?: readonly string[] | undefined;
  /** Weaker words that also find it. */
  readonly keywords?: readonly string[] | undefined;
  readonly badge?: string | undefined;
  /** What Enter does. */
  readonly commandId: string;
  readonly args?: unknown;
  readonly actions?: readonly HitAction[] | undefined;
  /** Inactive records are still found, just ranked lower and marked. */
  readonly inactive?: boolean | undefined;
}

const INACTIVE_FACTOR = 0.7;

/** How well a query (already stripped to letters and digits) matches a code-like value: exact 0.98, prefix 0.88, inside (4+ chars) 0.6. */
function identifierScore(q: string, id: string): number {
  if (q.length === 0 || id.length === 0) return 0;
  if (id === q) return 0.98;
  if (q.length >= 2 && id.startsWith(q)) return 0.88;
  if (q.length >= 4 && id.includes(q)) return 0.6;
  return 0;
}

interface Prepared {
  readonly title: PreparedTarget;
  readonly extras: readonly PreparedTarget[];
  readonly identifiers: readonly string[];
}

/** Normalising thousands of names on every keystroke is the slow part, so it is done once per document object. */
const prepared = new WeakMap<EntityDoc, Prepared>();
function prepare(doc: EntityDoc): Prepared {
  let p = prepared.get(doc);
  if (!p) {
    p = {
      title: prepareTarget(doc.title),
      extras: [...(doc.subtitle ? [doc.subtitle] : []), ...(doc.keywords ?? [])].map(prepareTarget),
      // The title counts as a code too, letters and digits only: "14188-1" must find "14188-1 - ORIF ,24 MM" even though the word matcher
      // splits a hyphenated code into pieces it cannot put back together.
      identifiers: [...(doc.identifiers ?? []), doc.title].map((i) => normalize(i).replace(/[^a-z0-9]/g, '')),
    };
    prepared.set(doc, p);
  }
  return p;
}

export interface EntitySearchOptions {
  /** Only documents of this scope (`l:`, `@`…). */
  readonly scope?: string | undefined;
  /** Only documents whose `kind` is one of these — how a field picker restricts to, say, Sundry Debtors. */
  readonly kinds?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

/**
 * The one entity matcher: Go To uses it through `entityProvider`, and field pickers call it directly, so a name
 * matches identically in both places. Best matches first; ties broken by title.
 */
export function searchEntities(docs: readonly EntityDoc[], text: string, options: EntitySearchOptions = {}): SearchHit[] {
  const limit = options.limit ?? 30;
  const terms = queryTerms(text);
  const compact = normalize(text).replace(/[^a-z0-9]/g, '');
  const scored: SearchHit[] = [];
  for (const doc of docs) {
    if (options.scope !== undefined && doc.scope !== options.scope) continue;
    if (options.kinds !== undefined && !options.kinds.includes(doc.kind)) continue;

    const p = prepare(doc);
    const byName = matchPrepared(terms, p.title, p.extras);
    let score = byName?.score ?? 0;
    let ranges = byName?.ranges;
    for (const id of p.identifiers) {
      const s = identifierScore(compact, id);
      if (s > score) {
        score = s;
        ranges = undefined;
      }
    }
    if (score === 0) continue;
    if (doc.inactive) score *= INACTIVE_FACTOR;
    scored.push({
      key: doc.key,
      kind: doc.kind,
      title: doc.title,
      subtitle: doc.subtitle,
      badge: doc.inactive ? 'Inactive' : doc.badge,
      commandId: doc.commandId,
      args: doc.args,
      score,
      ranges,
      actions: doc.actions,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return scored.slice(0, limit);
}

export interface EntityProviderOptions {
  readonly id: string;
  /** The `l:`-style scopes it answers to (must include every `scope` its documents use). */
  readonly scopes: readonly string[];
  /** Read on every search, so it always sees the current master data. */
  readonly docs: () => readonly EntityDoc[];
}

export function entityProvider<Ctx>(options: EntityProviderOptions): SearchProvider<Ctx> {
  return {
    id: options.id,
    scopes: options.scopes,
    search: (query: ParsedQuery) => searchEntities(options.docs(), query.text, { scope: query.scope }),
  };
}
