import { ActionPanel } from './ActionPanel';
import { GoToOverlay } from './GoToOverlay';
import { PrintHost } from './PrintHost';
import { SavingOverlay } from './SavingOverlay';
import { ScreenHost } from './ScreenHost';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';
import { useScope, useServices, useSubscriptions } from './hooks';

/**
 * The frame around every screen: top bar, the current screen (with its action panel on the right at the third level),
 * the status bar of the universal keys, and (when open) the Go To overlay. It declares the global keyboard scope and does nothing else keyboardy.
 */
export function Shell() {
  const { ui } = useServices();
  useScope('global', 'global');
  useSubscriptions(ui);

  return (
    <div class="shell">
      <TopBar />
      <div class="workarea">
        <ScreenHost />
        <ActionPanel />
      </div>
      <StatusBar />
      {ui.gotoOpen && <GoToOverlay />}
      <SavingOverlay />
      <PrintHost />
    </div>
  );
}
