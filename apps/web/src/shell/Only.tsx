import { useCommandHandler } from './hooks';

/**
 * Registers a screen's handler for one command while it is rendered. A command is "available" — and its action-panel button live —
 * only in the modes that render this, so the panel greys what would do nothing.
 */
export function Only({ scope, command, run }: { scope: string; command: string; run: () => boolean | void }) {
  useCommandHandler(scope, command, run);
  return null;
}
