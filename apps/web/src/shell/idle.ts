import type { RefObject } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

/**
 * Clicking blank space in a window deactivates the active field: it loses the cursor and its highlight, and nothing looks selected until a
 * field is clicked or the window is moved on by a key command (Tab, Enter…), which calls `wake`. Clicks on fields, buttons, lists and
 * dialogs are not blank.
 */
const NOT_BLANK = 'input, button, select, textarea, a, [role="option"], [role="listbox"], .picker, .overlay-backdrop';

export function useIdleOnBlankClick(root: RefObject<HTMLElement>): { idle: boolean; wake: () => void } {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const down = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest(NOT_BLANK)) {
        setIdle(false);
        return;
      }
      (document.activeElement as HTMLElement | null)?.blur?.();
      setIdle(true);
    };
    el.addEventListener('mousedown', down);
    return () => el.removeEventListener('mousedown', down);
  }, [root]);
  const wake = useCallback(() => setIdle(false), []);
  return { idle, wake };
}
