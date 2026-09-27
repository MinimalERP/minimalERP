import { ActionPanel } from './ActionPanel';
import { AssistantHost } from './AssistantHost';
import { GoToOverlay } from './GoToOverlay';
import { PrintHost } from './PrintHost';
import { SavingOverlay } from './SavingOverlay';
import { ScreenHost } from './ScreenHost';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';
import { useScope, useServices, useSubscriptions } from './hooks';
import { KeyboardKeys } from '../ui/KeyboardKeys';

/**
 * The frame around every screen: top bar, the current screen (with its action panel on the right at the third level),
 * the status bar of the universal keys, (when open) the Go To overlay, and the floating assistant. It declares the global keyboard scope and does nothing else keyboardy.
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
      <KeyboardKeys />
      {ui.gotoOpen && <GoToOverlay />}
      <AssistantHost />
      <SavingOverlay />
      <PrintHost />
    </div>
  );
}
