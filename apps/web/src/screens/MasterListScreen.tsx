import { type EntityDoc, type Frame, searchEntities } from '@minimalerp/command';
import { type MasterKind, isMasterActive, listMasters } from '@minimalerp/domain';
import { useEffect, useRef } from 'preact/hooks';
import { PLURALS } from '../books/books';
import { hasStockLedger, ledgersOfRecord, summaryOf } from '../books/entities';
import { FORMS } from '../books/forms';
import { useFrameState, useListNavigation, useServices, useSubscriptions } from '../shell/hooks';
import { Only } from '../shell/Only';
import type { ScreenRef } from '../shell/router';
import { Kbd } from '../ui/Kbd';
import { ListView } from '../ui/ListView';

const SCOPE = 'screen:master-list';

interface Row {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly inactive: boolean;
}

/**
 * Every record of one kind. Type to narrow it (the same matcher as Go To), Enter shows the record, Alt+A alters it,
 * Alt+C creates another. Rows keep their order while you type only if nothing matches better — best match first.
 */
export function MasterListScreen({ frame, kind }: { frame: Frame<ScreenRef>; kind: MasterKind }) {
  const { books: host, app, keymapStore } = useServices();
  useSubscriptions(host, keymapStore);
  const books = host.current;
  const [text, setText] = useFrameState(frame, 'text', '');
  const [index, setIndex] = useFrameState(frame, 'index', 0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const all: Row[] = books
    ? listMasters(books.masters, kind).map((r) => {
        const s = summaryOf(kind, books.masters, r);
        return { id: (r as { id: string }).id, title: s.title, subtitle: s.subtitle, inactive: !isMasterActive(kind, r) };
      })
    : [];

  let rows = all;
  if (text.trim() !== '') {
    const docs: EntityDoc[] = all.map((r) => ({ key: r.id, kind: '', scope: 'list', title: r.title, subtitle: r.subtitle, commandId: '', args: r.id }));
    const order = new Map(searchEntities(docs, text, { limit: 500 }).map((h, i) => [h.key, i]));
    rows = all.filter((r) => order.has(r.id)).sort((a, b) => (order.get(a.id) as number) - (order.get(b.id) as number));
  } else {
    rows = [...all].sort((a, b) => a.title.localeCompare(b.title));
  }
  const safeIndex = Math.min(index, Math.max(0, rows.length - 1));

  const open = (i: number, mode: 'display' | 'alter' = 'display') => {
    const row = rows[i];
    if (row) app.navigate({ type: 'master', kind, mode, id: row.id });
  };

  useListNavigation(SCOPE, { count: rows.length, index: safeIndex, setIndex, onActivate: (i) => open(i), wrap: true, homeEnd: false });
  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];
  const noun = FORMS[kind].noun;

  return (
    <section class="screen" aria-labelledby="list-title" data-testid="master-list">
      {rows.length > 0 && kind !== 'company' && (
        <Only
          scope={SCOPE}
          command="master.alter"
          run={() => {
            open(safeIndex, 'alter');
            return true;
          }}
        />
      )}
      {books && rows[safeIndex] && ledgersOfRecord(books.masters, kind, rows[safeIndex].id)[0] !== undefined && (
        <Only
          scope={SCOPE}
          command="master.ledgerReport"
          run={() => {
            const ledger = ledgersOfRecord(books.masters, kind, (rows[safeIndex] as Row).id)[0];
            if (ledger) app.navigate({ type: 'report', report: 'ledger', ledgerId: ledger.id });
            return true;
          }}
        />
      )}
      {books && rows[safeIndex] && hasStockLedger(books.masters, kind, rows[safeIndex].id) && (
        <Only
          scope={SCOPE}
          command="master.stockLedger"
          run={() => {
            app.navigate({ type: 'report', report: 'stock-item', itemId: (rows[safeIndex] as Row).id });
            return true;
          }}
        />
      )}
      {kind !== 'company' && (
        <Only
          scope={SCOPE}
          command="master.createInline"
          run={() => {
            app.navigate({ type: 'master', kind, mode: 'create' });
            return true;
          }}
        />
      )}
      <h1 id="list-title">{PLURALS[kind]}</h1>
      <p class="lede">
        {all.length} in total. Type to search · <Kbd chord={chord('nav.activate') ?? 'Enter'} /> display
        {chord('master.alter') && (
          <>
            {' '}
            · <Kbd chord={chord('master.alter') as string} /> alter
          </>
        )}
        {books && rows[safeIndex] && ledgersOfRecord(books.masters, kind, rows[safeIndex].id)[0] !== undefined && chord('master.ledgerReport') && (
          <>
            {' '}
            · <Kbd chord={chord('master.ledgerReport') as string} /> ledger report
          </>
        )}
        {books && rows[safeIndex] && hasStockLedger(books.masters, kind, rows[safeIndex].id) && chord('master.stockLedger') && (
          <>
            {' '}
            · <Kbd chord={chord('master.stockLedger') as string} /> stock ledger
          </>
        )}
        {chord('master.createInline') && (
          <>
            {' '}
            · <Kbd chord={chord('master.createInline') as string} /> new {noun.toLowerCase()}
          </>
        )}
      </p>
      <input
        ref={inputRef}
        class="field-input list-filter"
        type="text"
        aria-label={`Search ${PLURALS[kind].toLowerCase()}`}
        placeholder={`Search ${PLURALS[kind].toLowerCase()}…`}
        autocomplete="off"
        spellcheck={false}
        value={text}
        onInput={(e) => {
          setText((e.target as HTMLInputElement).value);
          setIndex(0);
        }}
      />
      {!books ? (
        <p class="empty">Open a company first.</p>
      ) : rows.length === 0 ? (
        <p class="empty" data-testid="list-empty">
          {all.length === 0 ? `No ${PLURALS[kind].toLowerCase()} yet.` : `No matches for “${text.trim()}”.`}
        </p>
      ) : (
        <ListView
          items={rows}
          index={safeIndex}
          itemKey={(r) => r.id}
          label={PLURALS[kind]}
          onActivate={(i) => {
            setIndex(i);
            open(i);
          }}
          renderItem={(r) => (
            <>
              <span class="row-title">{r.title}</span>
              {r.subtitle && <span class="row-desc">{r.subtitle}</span>}
              <span class="row-meta">{r.inactive && <span class="badge">Inactive</span>}</span>
            </>
          )}
        />
      )}
    </section>
  );
}
