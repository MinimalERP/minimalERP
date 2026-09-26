import { PrintView } from '../ui/PrintView';
import { COPY_COUNT_OPTIONS, printCompanyOf } from '../ui/printing';
import { ChooseOneDialog } from '../screens/ReportDialogs';
import { useServices, useSubscriptions } from './hooks';

/**
 * The one place `print` (a `PrintCoordinator`) is rendered: the copy-count dialog when a voucher print is choosing, and
 * `#print-root` once there is something to print. Mounted directly under `.shell` in `Shell.tsx` — `#print-root` must be a
 * DIRECT child there, not nested inside a screen, for the print stylesheet's `.shell > *:not(#print-root) { display: none }`
 * to actually reach it (see `PrintCoordinator`'s own note).
 */
export function PrintHost() {
  const { print, books } = useServices();
  useSubscriptions(print);
  const masters = books.current?.masters;

  return (
    <>
      {print.dialogOpen && <ChooseOneDialog title="Print" options={COPY_COUNT_OPTIONS} onDone={(v) => print.choose(v)} />}
      {print.docs.length > 0 && print.copies && masters && (
        <PrintView docs={print.docs} company={printCompanyOf(masters)} copies={print.copies} layouts={books.current?.printLayouts} />
      )}
    </>
  );
}
