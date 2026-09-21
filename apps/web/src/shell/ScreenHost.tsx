import type { Frame } from '@minimalerp/command';
import { CompanyCreateScreen, CompanyResetScreen } from '../screens/CompanyScreens';
import { KeymapSettingsScreen } from '../screens/KeymapSettingsScreen';
import { MasterFormScreen } from '../screens/MasterFormScreen';
import { MasterListScreen } from '../screens/MasterListScreen';
import { ReportScreen } from '../screens/ReportScreen';
import { VoucherScreen } from '../screens/VoucherScreen';
import { MenuScreen } from '../screens/MenuScreen';
import { PlaceholderScreen } from '../screens/PlaceholderScreen';
import { useScope, useServices, useSubscriptions } from './hooks';
import type { ScreenRef } from './router';

function ScreenBody({ frame }: { frame: Frame<ScreenRef> }) {
  const ref = frame.screen;
  // The screen's keyboard scope: bindings and handlers scoped to `screen:<type>` are live only while it is on top.
  useScope(`screen:${ref.type}`, 'screen');
  switch (ref.type) {
    case 'menu':
      return <MenuScreen frame={frame} menuId={ref.id} />;
    case 'planned':
      return <PlaceholderScreen commandId={ref.id} />;
    case 'settings-keyboard':
      return <KeymapSettingsScreen frame={frame} />;
    case 'company-new':
      return <CompanyCreateScreen frame={frame} />;
    case 'company-reset':
      return <CompanyResetScreen />;
    case 'master':
      return <MasterFormScreen frame={frame} kind={ref.kind} mode={ref.mode} id={ref.id} seed={ref.seed} inline={ref.inline} />;
    case 'master-list':
      return <MasterListScreen frame={frame} kind={ref.kind} />;
    case 'voucher':
      return <VoucherScreen frame={frame} mode={ref.mode} typeKey={ref.typeKey} id={ref.id} fromOrder={ref.fromOrder} />;
    case 'report':
      return <ReportScreen frame={frame} report={ref.report} ledgerId={ref.ledgerId} itemId={ref.itemId} kind={ref.kind} groupId={ref.groupId} />;
  }
}

/**
 * Shows the top of the screen stack. Only the top frame is mounted; the ones beneath keep their
 * state in the stack (see useFrameState), so Esc lands you exactly where you were.
 */
export function ScreenHost() {
  const { screens } = useServices();
  useSubscriptions(screens);
  const frame = screens.top;
  return (
    <main class="main" id="main">
      {/* keyed by frame id: a different screen is a different component instance, with fresh scopes */}
      <ScreenBody key={frame.id} frame={frame} />
    </main>
  );
}
