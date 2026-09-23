import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Kbd } from '../ui/Kbd';
import { useCommandHandler, useScope, useServices, useSubscriptions } from './hooks';

const SCOPE = 'overlay:confirm';

interface Props {
  readonly title?: string | undefined;
  readonly message?: string | undefined;
  /** Keep working. Also what Esc does: an accidental double-Esc must never throw work away. */
  readonly onStay: () => void;
  readonly onLeave: () => void;
}

/**
 * "Close and leave?" — the question a creation or alteration window asks when Esc is pressed with something entered.
 * It is a modal overlay (nothing beneath it reacts), focus starts on No, Esc means No, and only Yes — chosen with ←/→/Tab and Enter,
 * or Alt+Y — leaves. (The keymap refuses plain letters as shortcuts, so Yes/No are Alt+Y / Alt+N.)
 */
export function ConfirmLeaveDialog({ title = 'Close and leave?', message = 'What you have entered has not been saved.', onStay, onLeave }: Props) {
  const { keymapStore } = useServices();
  useSubscriptions(keymapStore);
  useScope(SCOPE, 'overlay', true);
  const [choice, setChoice] = useState<'yes' | 'no'>('no');
  const noRef = useRef<HTMLButtonElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);

  // Take focus off the field underneath (typing must not reach it) and give it back when the question is closed.
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    noRef.current?.focus();
    return () => before?.focus?.();
  }, []);
  useLayoutEffect(() => (choice === 'yes' ? yesRef : noRef).current?.focus(), [choice]);

  const toggle = () => (setChoice((c) => (c === 'no' ? 'yes' : 'no')), true);
  useCommandHandler(SCOPE, 'field.next', toggle);
  useCommandHandler(SCOPE, 'field.prev', toggle);
  useCommandHandler(SCOPE, 'nav.left', toggle);
  useCommandHandler(SCOPE, 'nav.right', toggle);
  useCommandHandler(SCOPE, 'nav.up', toggle);
  useCommandHandler(SCOPE, 'nav.down', toggle);
  useCommandHandler(SCOPE, 'nav.activate', () => (choice === 'yes' ? onLeave() : onStay(), true));
  useCommandHandler(SCOPE, 'confirm.yes', () => (onLeave(), true));
  useCommandHandler(SCOPE, 'confirm.no', () => (onStay(), true));
  useCommandHandler(SCOPE, 'app.back', () => (onStay(), true));

  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];
  return (
    <div class="overlay-backdrop" data-testid="leave-dialog-backdrop">
      <div class="palette dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="leave-title" aria-describedby="leave-message" data-testid="leave-dialog">
        <h2 id="leave-title" class="dialog-title">
          {title}
        </h2>
        <p id="leave-message" class="confirm-message">
          {message}
        </p>
        <div class="confirm-actions">
          <button ref={noRef} type="button" class={choice === 'no' ? 'button chosen' : 'button'} data-choice="no" onClick={onStay}>
            No, stay {chord('confirm.no') && <Kbd chord={chord('confirm.no') as string} />}
          </button>
          <button ref={yesRef} type="button" class={choice === 'yes' ? 'button chosen' : 'button'} data-choice="yes" onClick={onLeave}>
            Yes, close {chord('confirm.yes') && <Kbd chord={chord('confirm.yes') as string} />}
          </button>
        </div>
      </div>
    </div>
  );
}
