/**
 * "Use without signing in": the books kept in this browser instead of online. The choice is remembered on this device, so the next visit goes
 * straight to those books; signing in (from the top bar, or by choosing to) puts it back. Nothing about the online books changes: an account
 * and its company are exactly where they were, and the browser-only company is never sent anywhere.
 */
const KEY = 'minimalerp.mode';
const LOCAL = 'local';

/** Whether this browser was told to keep its own books. Storage can throw or be missing (private windows): then the answer is no. */
export function prefersLocalBooks(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return storage?.getItem(KEY) === LOCAL;
  } catch {
    return false;
  }
}

export function chooseLocalBooks(storage: Pick<Storage, 'setItem'> | undefined): void {
  try {
    storage?.setItem(KEY, LOCAL);
  } catch {
    /* not remembered: the next visit asks again, which is harmless */
  }
}

export function chooseOnlineBooks(storage: Pick<Storage, 'removeItem'> | undefined): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}
