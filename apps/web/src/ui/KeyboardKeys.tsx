import { useEffect, useState } from 'preact/hooks';
import { Kbd } from './Kbd';

/** How much of the window the on-screen keyboard must take before it counts as open (an address bar sliding away is less). */
const KEYBOARD_MIN = 150;
const STRIP_H = 48;

/**
 * Esc and Enter, floating just above a phone's on-screen keyboard — which covers the status bar that has them. A tap sends the
 * real key to whatever has focus, so it does exactly what the key does there (next field, pick, close…); the tap never takes the
 * focus, so the keyboard stays up. Touch screens only, and only while the keyboard is open: anywhere else this draws nothing.
 */
export function KeyboardKeys() {
  const [top, setTop] = useState<number | undefined>(undefined);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !window.matchMedia('(pointer: coarse)').matches) return;
    const sync = () => setTop(window.innerHeight - vv.height > KEYBOARD_MIN ? vv.offsetTop + vv.height - STRIP_H : undefined);
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, []);

  if (top === undefined) return null;

  const press = (key: 'Enter' | 'Escape') => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
  };
  const keep = (e: Event) => e.preventDefault(); // the text field keeps the focus, and the keyboard stays open

  return (
    <div class="kbd-keys" style={{ top: `${top}px`, height: `${STRIP_H}px` }} data-testid="keyboard-keys">
      <button type="button" class="kbd-key" tabIndex={-1} onPointerDown={keep} onMouseDown={keep} onClick={() => press('Escape')} aria-label="Esc">
        <Kbd chord="Esc" />
      </button>
      <button type="button" class="kbd-key" tabIndex={-1} onPointerDown={keep} onMouseDown={keep} onClick={() => press('Enter')} aria-label="Enter">
        <Kbd chord="Enter" />
      </button>
    </div>
  );
}
