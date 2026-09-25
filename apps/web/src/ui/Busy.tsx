/**
 * The one "working on it" animation: a turning ring, the words, and a bar that sweeps underneath. The same for opening the books and for
 * saving, so a person learns it once. It is status text for screen readers; the motion slows down under prefers-reduced-motion.
 */
export function Busy({ label, announce = true }: { label: string; announce?: boolean }) {
  // inside a panel that is already a status region (the saving panel), it does not announce itself a second time
  return (
    <div class="busy" role={announce ? 'status' : undefined} aria-live={announce ? 'polite' : undefined}>
      <div class="busy-line">
        <span class="busy-ring" aria-hidden="true" />
        <span class="busy-label">{label}</span>
      </div>
      <span class="busy-bar" aria-hidden="true">
        <span class="busy-bar-fill" />
      </span>
    </div>
  );
}
