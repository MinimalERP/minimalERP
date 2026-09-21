import { useCommandHandler, useServices } from '../shell/hooks';

/**
 * The voucher types a window cannot turn itself into (an accounting voucher cannot become a sales invoice: its lines mean something else) still
 * answer their keys and panel buttons: they open a NEW voucher of that type. A window with nothing entered is replaced rather than left behind.
 * `kinds` must be the same list on every render (each one is a hook).
 */
export function useOtherVoucherHandlers(scope: string, kinds: readonly string[], isBlank: () => boolean): void {
  const { app } = useServices();
  for (const kind of kinds) {
    // biome-ignore lint/correctness/useHookAtTopLevel: the list is a module constant, so the number of hooks never changes
    useCommandHandler(scope, `voucher.switch.${kind}`, () => {
      if (isBlank()) app.back();
      app.navigate({ type: 'voucher', mode: 'create', typeKey: kind });
      return true;
    });
  }
}
