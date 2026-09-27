import type { AssistantScreen, AssistantTurn } from '@minimalerp/ports';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Busy } from '../ui/Busy';
import { Kbd } from '../ui/Kbd';
import { useCommandHandler, useServices, useSubscriptions } from './hooks';

const SCOPE = 'overlay:assistant';
const PLACE_KEY = 'minimalerp.assistant.place';
/** How many turns go with a question (the server takes at most 40). */
const KEEP = 20;

interface Line extends AssistantTurn {
  readonly sources?: readonly string[];
  /** A problem saying the question could not be answered (not part of the conversation sent back). */
  readonly problem?: boolean;
}

const SOURCE_WORDS: Record<string, string> = { find_items: 'items', stock: 'stock', orders: 'orders', outstanding: 'outstanding', invoices: 'invoices' };

/** Where the ✦ button was dragged to on this device (per-device convenience; the page works without it). */
function loadPlace(): { right: number; bottom: number } | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(PLACE_KEY) ?? 'null') as { right?: unknown; bottom?: unknown } | null;
    return v && typeof v.right === 'number' && typeof v.bottom === 'number' ? { right: v.right, bottom: v.bottom } : undefined;
  } catch {
    return undefined;
  }
}
function savePlace(p: { right: number; bottom: number }): void {
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(p));
  } catch {
    /* private window: the place is simply not remembered */
  }
}

/** What is on screen: the top screen's type and id (the server reads the record itself), and its heading as the person sees it. */
function screenNow(ref: { type: string; id?: string; kind?: string }): AssistantScreen & { readonly label: string } {
  const heading = document.querySelector('.workarea h1, .workarea .vtitle')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return { type: ref.type, ...(ref.id ? { id: ref.id } : {}), ...(ref.kind ? { kind: ref.kind } : {}), ...(heading ? { title: heading.slice(0, 200) } : {}), label: heading };
}

/**
 * The floating assistant, on every screen: a ✦ button (drag it anywhere; Alt+Q) that opens a chat over whatever is open. It answers from
 * the open company's books through the `assistant` function (read only), and anything else like a general assistant. The conversation
 * lives here while the tab is open — across screens, until ⟲ or a change of company — and is never stored.
 */
export function AssistantHost() {
  const { ui, books, screens, keymapStore, app } = useServices();
  useSubscriptions(ui, books, screens, keymapStore);
  const company = books.current;
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [place, setPlace] = useState(loadPlace);
  const companyId = company?.companyId;
  const drag = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean } | undefined>(undefined);

  // another company, another conversation: nothing of one business may leak into the other's questions
  useEffect(() => setLines([]), [companyId]);

  if (!company) return null;
  const top = screens.top.screen as { type: string; id?: string; kind?: string };
  const chord = keymapStore.keymap.chordsFor('assistant.toggle')[0];

  const ask = async (question: string) => {
    const q = question.trim();
    if (q === '' || busy) return;
    const next = [...lines, { role: 'user' as const, text: q }];
    setLines(next);
    setBusy(true);
    const { label: _label, ...screen } = screenNow(top);
    const history = next.filter((l) => !l.problem).slice(-KEEP).map(({ role, text }) => ({ role, text }));
    const r = await company.askAssistant(history, screen);
    setBusy(false);
    setLines((now) => [...now, r.ok ? { role: 'model', text: r.value.answer, sources: r.value.sources } : { role: 'model', text: r.issues.map((i) => i.message).join('; '), problem: true }]);
  };

  // the button: a tap opens / closes; a drag moves it (and is remembered here)
  const onDown = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault(); // the field being edited keeps the focus
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    d.moved = true;
    const clamp = (v: number, max: number) => Math.max(4, Math.min(max, v));
    setPlace({ right: clamp(d.right - dx, window.innerWidth - 56), bottom: clamp(d.bottom - dy, window.innerHeight - 56) });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = undefined;
    if (!d) return;
    if (d.moved) {
      if (place) savePlace(place);
    } else app.toggleAssistant();
  };

  return (
    <>
      <button
        type="button"
        class={ui.assistantOpen ? 'assistant-fab open' : 'assistant-fab'}
        style={place ? { right: `${place.right}px`, bottom: `${place.bottom}px` } : undefined}
        tabIndex={-1}
        aria-label="Assistant"
        title={chord ? `Assistant (${chord})` : 'Assistant'}
        data-testid="assistant-button"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onMouseDown={(e) => e.preventDefault()}
      >
        ✦
      </button>
      {ui.assistantOpen && <AssistantPanel lines={lines} busy={busy} onAsk={(q) => void ask(q)} onNew={() => setLines([])} screenLabel={screenNow(top).label} chord={chord} />}
    </>
  );
}

function AssistantPanel(p: { lines: readonly Line[]; busy: boolean; onAsk: (q: string) => void; onNew: () => void; screenLabel: string; chord: string | undefined }) {
  const { app } = useServices();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // take the focus on open; give it back on close (like Go To)
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => before?.focus?.();
  }, []);
  // the newest line in view
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [p.lines.length, p.busy]);

  const send = () => {
    if (text.trim() === '' || p.busy) return false;
    p.onAsk(text);
    setText('');
    return true;
  };
  const lastQuestion = [...p.lines].reverse().find((l) => l.role === 'user')?.text;

  useCommandHandler(SCOPE, 'app.back', () => {
    app.toggleAssistant();
    return true;
  });
  // Enter sends (Shift+Enter is a new line: not a key the keymap binds, so the text box keeps it)
  useCommandHandler(SCOPE, 'nav.activate', () => send());
  // Up in an empty box brings back the last question
  useCommandHandler(SCOPE, 'nav.up', () => {
    if (text !== '' || !lastQuestion) return false;
    setText(lastQuestion);
    return true;
  });

  return (
    <section class="assistant-panel" role="dialog" aria-label="Assistant" data-testid="assistant-panel">
      <header class="assistant-head">
        <strong>Assistant</strong>
        <span class="spacer" />
        <button type="button" class="assistant-icon" title="New conversation" aria-label="New conversation" onMouseDown={(e) => e.preventDefault()} onClick={p.onNew}>
          ⟲
        </button>
        <button type="button" class="assistant-icon" title={p.chord ? `Close (Esc)` : 'Close'} aria-label="Close" onMouseDown={(e) => e.preventDefault()} onClick={() => app.toggleAssistant()}>
          ✕
        </button>
      </header>
      {p.screenLabel && <div class="assistant-on" data-testid="assistant-on">on: {p.screenLabel}</div>}
      <div class="assistant-lines" ref={listRef} aria-live="polite">
        {p.lines.length === 0 && (
          <div class="assistant-hello">
            <p>Ask about stock, customers’ orders, invoices or money owed — or anything else. In English, Hindi or Marathi — on a phone, the keyboard’s mic works too.</p>
            <p class="assistant-try">
              {['Stock of 14188?', 'Open orders due this week?', 'Who owes us the most?'].map((q) => (
                <button key={q} type="button" class="chip-q" onMouseDown={(e) => e.preventDefault()} onClick={() => p.onAsk(q)}>
                  {q}
                </button>
              ))}
            </p>
            <p class="assistant-note">
              Teach it: “remember: we keep 50 blanks of 14188”.{' '}
              <button type="button" class="linklike" onMouseDown={(e) => e.preventDefault()} onClick={() => p.onAsk('What have you been taught?')}>
                What do you know?
              </button>
            </p>
          </div>
        )}
        {p.lines.map((l, i) => (
          <div key={i} class={`assistant-line ${l.role}${l.problem ? ' problem' : ''}`}>
            <div class="assistant-text">{l.text}</div>
            {l.sources && l.sources.length > 0 && <div class="assistant-src">from ERP · {l.sources.map((s) => SOURCE_WORDS[s] ?? s).join(', ')}</div>}
          </div>
        ))}
        {p.busy && <Busy label="Looking it up…" />}
      </div>
      <div class="assistant-ask">
        <textarea
          ref={inputRef}
          class="assistant-input"
          rows={2}
          value={text}
          placeholder="Ask anything…"
          aria-label="Your question"
          onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
        />
        <button type="button" class="assistant-send" aria-label="Send" disabled={text.trim() === '' || p.busy} onMouseDown={(e) => e.preventDefault()} onClick={send}>
          ➤
        </button>
      </div>
      <div class="assistant-keys">
        <Kbd chord="Enter" /> send · <Kbd chord="Esc" /> close{p.chord ? ' · ' : ''}
        {p.chord ? <Kbd chord={p.chord} /> : null}
      </div>
    </section>
  );
}
