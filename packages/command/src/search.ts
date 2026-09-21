import { fuzzyMatch } from './fuzzy';
import { parseQuery } from './query';
import type { RecentEntry, RecentStore } from './recents';
import type { CommandRegistry } from './registry';
import type { SearchContext, SearchHit, SearchProvider } from './types';

export interface SearchServiceOptions<Ctx> {
  /** Read on every search, so modules registered later are included. */
  readonly providers: () => readonly SearchProvider<Ctx>[];
  readonly recents: RecentStore;
  /** Can this command be run right now? Recents of unavailable commands are not offered. */
  readonly isRunnable: (commandId: string) => boolean;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly signal?: AbortSignal;
  /** Called each time a provider answers with everything found so far — fast local results appear first. */
  readonly onUpdate?: (hits: readonly SearchHit[]) => void;
}

const FRECENCY_WEIGHT = 0.25;
const PINNED_BONUS = 0.1;

/**
 * The one Go To search. It fans a query out to every provider (commands and reports now; ledgers,
 * parties, items, vouchers as their phases land), merges and ranks the answers, and lifts things
 * you use a lot. There is no other search implementation in the app — field pickers use this too.
 */
export class SearchService<Ctx> {
  constructor(private readonly options: SearchServiceOptions<Ctx>) {}

  async search(text: string, context: SearchContext<Ctx>, options: SearchOptions = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? 30;
    const query = parseQuery(text);
    if (query.terms.length === 0) return this.suggestions(limit);

    const providers = this.options.providers().filter((p) =>
      query.scope === undefined ? true : (p.scopes ?? []).includes(query.scope),
    );

    const collected = new Map<string, SearchHit>();
    const merge = (hits: readonly SearchHit[]) => {
      for (const hit of hits) {
        const seen = collected.get(hit.key);
        if (!seen || hit.score > seen.score) collected.set(hit.key, hit);
      }
      return this.rank([...collected.values()], limit);
    };

    await Promise.all(
      providers.map(async (provider) => {
        let hits: readonly SearchHit[];
        try {
          hits = await provider.search(query, context, options.signal);
        } catch (error) {
          // One failing provider (say, the server is unreachable) must not blank the whole palette.
          if (options.signal?.aborted) return;
          console.error(`Search provider ${provider.id} failed`, error);
          return;
        }
        if (options.signal?.aborted) return;
        // Merge FIRST: `options.onUpdate?.(merge(hits))` would skip the merge entirely when there is no callback.
        const merged = merge(hits);
        options.onUpdate?.(merged);
      }),
    );
    if (options.signal?.aborted) return [];
    return this.rank([...collected.values()], limit);
  }

  /** What to show before anything is typed: pinned items first, then what you use most. */
  suggestions(limit = 12): SearchHit[] {
    const toHit = (e: RecentEntry, kind: string): SearchHit => ({
      key: e.key, kind, title: e.title, subtitle: e.subtitle, badge: e.badge,
      commandId: e.commandId, args: e.args, score: 1,
    });
    const runnable = (e: RecentEntry) => this.options.isRunnable(e.commandId);
    const pinned = this.options.recents.pinned().filter(runnable).map((e) => toHit(e, 'Favourite'));
    const recent = this.options.recents.recents(limit).filter(runnable).map((e) => toHit(e, 'Recent'));
    return [...pinned, ...recent].slice(0, limit);
  }

  private rank(hits: readonly SearchHit[], limit: number): SearchHit[] {
    const { recents } = this.options;
    const scored = hits.map((hit) => ({
      hit,
      final: hit.score + FRECENCY_WEIGHT * recents.frecency(hit.key) + (recents.isPinned(hit.key) ? PINNED_BONUS : 0),
    }));
    scored.sort((a, b) => b.final - a.final || a.hit.title.localeCompare(b.hit.title));
    return scored.slice(0, limit).map((s) => s.hit);
  }
}

/**
 * Makes every available, non-hidden command searchable by its title, with its keywords and
 * category as weaker matches. This is what lets a new module appear in Go To just by registering commands.
 */
export function commandProvider<Ctx>(registry: CommandRegistry<Ctx>): SearchProvider<Ctx> {
  return {
    id: 'commands',
    scopes: ['command'],
    search(query, context) {
      const hits: SearchHit[] = [];
      for (const command of registry.all()) {
        if (command.hidden || !command.run) continue;
        if (command.when && !command.when(context.app)) continue;
        const match = fuzzyMatch(query.text, command.title, [command.category, ...(command.keywords ?? [])]);
        if (!match) continue;
        hits.push({
          key: `cmd:${command.id}`,
          kind: command.category,
          title: command.title,
          subtitle: command.description,
          badge: command.badge,
          commandId: command.id,
          score: match.score,
          ranges: match.ranges,
        });
      }
      return hits;
    },
  };
}
