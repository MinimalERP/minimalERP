import { type SearchHit, highlightSegments } from '@minimalerp/command';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Kbd } from '../ui/Kbd';
import { Hint } from './Hint';
import { ListView } from '../ui/ListView';
import { useCommandHandler, useListNavigation, useServices, useSubscriptions } from './hooks';

const SCOPE = 'overlay:goto';

/**
 * Universal Search / Go To. A modal overlay driven entirely by commands:
 *   Up/Down/Tab → move · Enter → open · Alt+P → pin · Esc (or Alt+G again) → close
 * It has no key listener; it handles those commands inside the modal scope UiState opened for it. Results come from
 * SearchService, so the same engine will serve field pickers later.
 */
export function GoToOverlay() {
  const { search, ui, registry, keymapStore, recents, app, books } = useServices();
  // Its modal keyboard scope is pushed by UiState the instant it opens (not here), so there is no gap.
  useSubscriptions(recents, keymapStore);

  const [text, setText] = useState('');
  const [hits, setHits] = useState<readonly SearchHit[]>(() => search.suggestions());
  const [index, setIndex] = useState(0);
  // "More actions" for the highlighted result (Display / Alter…). While set, the list shows those instead.
  const [actionsFor, setActionsFor] = useState<SearchHit | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const inflight = useRef<AbortController | undefined>(undefined);

  // Take focus on open; give it back to whatever had it on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => before?.focus?.();
  }, []);

  // Search from the INPUT HANDLER, not from an effect. An effect runs after the browser paints, so fast typing
  // followed by Enter would act on the PREVIOUS query's results. Local providers answer within microtasks, so
  // results are current before the next keystroke; slower providers refine them as they arrive.
  const runSearch = (value: string) => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const show = (h: readonly SearchHit[]) => {
      if (controller.signal.aborted) return;
      setActionsFor(undefined);
      setHits(h);
      setIndex(0);
    };
    void search.search(value, { app, scopes: ui.gotoContext }, { signal: controller.signal, onUpdate: show }).then(show);
  };
  useEffect(() => () => inflight.current?.abort(), []);

  const rows: readonly SearchHit[] = actionsFor
    ? (actionsFor.actions ?? []).map((a) => ({
        key: `${actionsFor.key}|${a.label}`,
        kind: 'Action',
        title: a.label,
        subtitle: actionsFor.title,
        commandId: a.commandId,
        args: a.args,
        score: 1,
      }))
    : hits;

  const activate = (i: number) => {
    const hit = rows[i];
    if (!hit) return;
    recents.record(hit);
    app.closeGoTo();
    registry.run(hit.commandId, hit.args);
  };

  useListNavigation(SCOPE, { count: rows.length, index, setIndex, onActivate: activate, wrap: true, homeEnd: false });
  useCommandHandler(SCOPE, 'app.back', () => {
    if (actionsFor) {
      setActionsFor(undefined); // Esc leaves the action list first; a second Esc closes Go To
      return true;
    }
    app.closeGoTo();
    return true;
  });
  useCommandHandler(SCOPE, 'goto.actions', () => {
    // Only when the caret is at the end of the text: Right must still move it inside a query being edited.
    const input = inputRef.current;
    if (actionsFor || (input && input.selectionStart !== input.value.length)) return false;
    const hit = hits[index];
    if (!hit?.actions?.length) return false;
    setActionsFor(hit);
    setIndex(0);
    return true;
  });
  useCommandHandler(SCOPE, 'goto.togglePin', () => {
    const hit = rows[index];
    if (!hit || actionsFor) return false;
    recents.togglePinned(hit);
    if (text.trim() === '') setHits(search.suggestions());
    return true;
  });

  const chordOf = (id: string) => keymapStore.keymap.chordsFor(id)[0];
  const empty = text.trim() === '';

  return (
    <div
      class="overlay-backdrop"
      data-testid="goto-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) app.closeGoTo();
      }}
    >
      <div class="palette" role="dialog" aria-modal="true" aria-label="Go To" data-testid="goto">
        <input
          ref={inputRef}
          class="palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="goto-results"
          aria-label="Go To"
          placeholder={books.current ? 'Go to a report, a ledger, a party, an item…' : 'Go to a report, create a record, open a setting…'}
          autocomplete="off"
          spellcheck={false}
          value={text}
          onInput={(e) => {
            const value = (e.target as HTMLInputElement).value;
            setText(value);
            runSearch(value);
          }}
        />
        <div class="palette-results" id="goto-results">
          {rows.length === 0 ? (
            <p class="empty" data-testid="goto-empty">
              {empty ? (
                <>
                  {books.current ? 'Type to search commands, reports, settings — and your ledgers, parties and items.' : 'Type to search commands, reports and settings.'}
                  <br />
                  {books.current ? 'Try “abc”, “l:cash” for ledgers, “@” for parties, or “i:bolt” for items.' : 'Try “trial balance”, “new sales”, or “keyboard”.'}
                </>
              ) : (
                <>No matches for “{text.trim()}”.</>
              )}
            </p>
          ) : (
            <ListView
              items={rows}
              index={index}
              itemKey={(h) => h.key}
              label="Results"
              onActivate={activate}
              renderItem={(h) => {
                const chord = chordOf(h.commandId);
                return (
                  <>
                    <span class="row-kind">{h.kind}</span>
                    <span class="row-title" data-testid="goto-title">
                      {highlightSegments(h.title, h.ranges).map((s, i) =>
                        s.match ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>,
                      )}
                    </span>
                    {/* Records (which have actions) say what they are: two "ABC Industries" rows differ by group / GSTIN. */}
                    {h.actions && h.subtitle && <span class="row-desc">{h.subtitle}</span>}
                    <span class="row-meta">
                      {recents.isPinned(h.key) && <span aria-label="pinned">★</span>}
                      {h.badge && <span class="badge">{h.badge}</span>}
                      {chord && <Kbd chord={chord} />}
                    </span>
                  </>
                );
              }}
            />
          )}
        </div>
        <div class="palette-foot">
          <Hint command="nav.down" also="nav.up">
            select
          </Hint>
          <Hint command="nav.activate">open</Hint>
          {hits[index]?.actions?.length && !actionsFor && chordOf('goto.actions') ? <Hint command="goto.actions">actions</Hint> : null}
          <Hint command="goto.togglePin">pin</Hint>
          <Hint command="app.back">close</Hint>
        </div>
      </div>
    </div>
  );
}
