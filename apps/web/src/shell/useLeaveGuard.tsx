import type { ComponentChild } from 'preact';
import { useState } from 'preact/hooks';
import { ConfirmLeaveDialog } from './ConfirmLeaveDialog';
import { useServices } from './hooks';

/**
 * What a creation/alteration window uses to guard Esc. Its `app.back` handler calls `ask()` when something is entered (and lets the
 * global "back" close the window when nothing is); render `dialog` anywhere in the screen. Yes closes the window through the screen stack
 * directly (not through the command), so the question is never asked twice.
 */
export function useLeaveGuard(message?: string): { ask: () => void; asking: boolean; dialog: ComponentChild } {
  const { app } = useServices();
  const [asking, setAsking] = useState(false);
  return {
    ask: () => setAsking(true),
    asking,
    dialog: asking ? (
      <ConfirmLeaveDialog
        message={message}
        onStay={() => setAsking(false)}
        onLeave={() => {
          setAsking(false);
          app.back();
        }}
      />
    ) : null,
  };
}
