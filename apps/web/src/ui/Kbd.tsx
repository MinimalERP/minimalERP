import { keyEventInitOf, parseChord } from '@minimalerp/keyboard';
import type { Chord } from '@minimalerp/keyboard';

const GLYPHS: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→', Esc: 'Esc' };

/**
 * A shortcut drawn as key caps: `Alt` `G`. A tap on it presses it — a phone has no Alt key, so "Alt+C creates it" must work by touch too.
 * The key goes to whatever has the focus, exactly as if typed, and the tap never takes the focus (the field keeps its caret and its open
 * list). Inside a button the button decides; `tap={false}` where a chord is only shown (the shortcut editor's list).
 */
export function Kbd({ chord, tap = true }: { chord: Chord | string; tap?: boolean }) {
  const { modifiers, key } = parseChord(chord as Chord);
  const init = tap ? keyEventInitOf(chord as Chord) : undefined;
  const inButton = (el: EventTarget | null) => el instanceof Element && el.parentElement?.closest('button, a') != null;
  const keep = (e: Event) => {
    if (!inButton(e.currentTarget)) e.preventDefault();
  };
  return (
    <span
      class={init ? 'kbd-group kbd-tap' : 'kbd-group'}
      aria-label={`shortcut ${chord}`}
      {...(init
        ? {
            onPointerDown: keep,
            onMouseDown: keep,
            onClick: (e: MouseEvent) => {
              if (inButton(e.currentTarget)) return;
              e.stopPropagation();
              (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', init));
            },
          }
        : {})}
    >
      {[...modifiers, key].map((part, i) => (
        <kbd key={i} class="kbd">
          {GLYPHS[part] ?? part}
        </kbd>
      ))}
    </span>
  );
}
