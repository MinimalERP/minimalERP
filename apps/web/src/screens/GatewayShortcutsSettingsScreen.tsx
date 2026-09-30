import type { Frame } from '@minimalerp/command';
import { useFrameState, useListNavigation, useServices, useSubscriptions } from '../shell/hooks';
import type { ScreenRef } from '../shell/router';
import { Kbd } from '../ui/Kbd';
import { ListView } from '../ui/ListView';

const SCOPE = 'screen:settings-gateway-shortcuts';

/** Select the useful command links shown in the small Shortcuts panel on the Gateway. */
export function GatewayShortcutsSettingsScreen({ frame }: { frame: Frame<ScreenRef> }) {
  const { registry, gatewayShortcuts } = useServices();
  useSubscriptions(registry, gatewayShortcuts);
  const [index, setIndex] = useFrameState(frame, 'index', 0);
  const rows = registry
    .all()
    .filter((c) => !c.hidden && (c.category === 'Voucher' || c.category === 'Report') && c.run !== undefined)
    .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  const safeIndex = Math.min(index, Math.max(0, rows.length - 1));
  const toggle = (at: number) => {
    const command = rows[at];
    if (!command) return;
    const selected = gatewayShortcuts.ids;
    gatewayShortcuts.set(selected.includes(command.id) ? selected.filter((id) => id !== command.id) : [...selected, command.id]);
  };

  useListNavigation(SCOPE, { count: rows.length, index: safeIndex, setIndex, onActivate: toggle });

  return (
    <section class="screen" aria-labelledby="gateway-shortcuts-title" data-testid="gateway-shortcuts-settings">
      <h1 id="gateway-shortcuts-title">Gateway Shortcuts</h1>
      <p class="lede">Choose the links to show in the Shortcuts panel below the Gateway sections. Changes apply immediately.</p>
      <div class="toolbar">
        <button type="button" class="button" onClick={() => gatewayShortcuts.set(['voucher.new.sales', 'report.salesOrders'])}>
          Restore defaults
        </button>
      </div>
      <ListView
        items={rows}
        index={safeIndex}
        itemKey={(command) => command.id}
        label="Gateway shortcuts"
        onActivate={toggle}
        renderItem={(command) => (
          <>
            <span class="row-title"><span aria-hidden="true">{gatewayShortcuts.ids.includes(command.id) ? '☑' : '☐'}</span>{' '}{command.title}</span>
            <span class="row-kind">{command.category}</span>
          </>
        )}
      />
      <p class="lede"><Kbd chord="Enter" /> toggles a link. Open Utilities &amp; Settings → Keyboard Shortcuts to change keyboard keys.</p>
    </section>
  );
}
