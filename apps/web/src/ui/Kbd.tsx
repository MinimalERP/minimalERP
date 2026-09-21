import { parseChord } from '@minimalerp/keyboard';
import type { Chord } from '@minimalerp/keyboard';

const GLYPHS: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→', Esc: 'Esc' };

/** A shortcut drawn as key caps: `Alt` `G`. Purely presentational. */
export function Kbd({ chord }: { chord: Chord | string }) {
  const { modifiers, key } = parseChord(chord as Chord);
  return (
    <span class="kbd-group" aria-label={`shortcut ${chord}`}>
      {[...modifiers, key].map((part, i) => (
        <kbd key={i} class="kbd">
          {GLYPHS[part] ?? part}
        </kbd>
      ))}
    </span>
  );
}
