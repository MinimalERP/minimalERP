import { useEffect } from 'preact/hooks';

/**
 * A bare letter (no Ctrl/Alt/Meta) calls `onLetter` with it upper-cased; return true to consume the key. A low-level primitive,
 * apart from the app's configurable shortcuts (the keymap refuses bare letters, since they are for typing): use it only on a
 * screen that is a pure list, where no text field ever has focus — a key typed into a field is always left alone.
 */
export function useLetterKeys(onLetter: (letter: string) => boolean, deps: readonly unknown[]): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.repeat || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key.length !== 1 || !/[a-zA-Z]/.test(e.key)) return;
      if (onLetter(e.key.toUpperCase())) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, deps);
}
