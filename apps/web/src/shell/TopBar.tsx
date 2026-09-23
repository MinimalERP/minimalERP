import { FORMS, titleOf } from '../books/forms';
import { PLURALS } from '../books/books';
import { kindTitle } from '../vouchers/kinds';
import { Kbd } from '../ui/Kbd';
import { PANEL_SCREENS } from './ActionPanel';
import { useServices, useSubscriptions } from './hooks';
import type { ScreenRef } from './router';

/** The human name of a screen, for the breadcrumb. */
export function useScreenTitle() {
  const { registry } = useServices();
  return (ref: ScreenRef): string => {
    switch (ref.type) {
      case 'menu':
        return ref.id === 'gateway' ? 'Gateway' : (registry.menuSections().find((s) => s.id === ref.id)?.title ?? ref.id);
      case 'planned':
        return registry.get(ref.id)?.title ?? ref.id;
      case 'settings-keyboard':
        return 'Keyboard Shortcuts';
      case 'company-new':
        return 'Create Company';
      case 'company-reset':
        return 'Close Company';
      case 'invoice-settings':
        return 'Invoice / PDF Settings';
      case 'inbox':
        return 'AI Inbox';
      case 'master-list':
        return PLURALS[ref.kind];
      case 'master':
        return ref.mode === 'create' ? titleOf(ref.kind, 'create') : FORMS[ref.kind].noun;
      case 'voucher':
        return ref.mode === 'create' ? `New ${kindTitle(ref.typeKey ?? '') ?? ''} Voucher`.replace('  ', ' ') : 'Voucher';
      case 'report':
        return ref.report === 'daybook' ? 'Day Book' : ref.report === 'stock-summary' ? 'Stock Summary' : ref.report === 'stock-item' ? 'Stock Ledger' : 'Ledger';
    }
  };
}

export function TopBar() {
  const { screens, keymapStore, app, books, ui } = useServices();
  useSubscriptions(screens, keymapStore, books, ui);
  const titleOf = useScreenTitle();
  const goto = keymapStore.keymap.chordsFor('goto.open')[0];

  const trail = screens.all;
  return (
    <header class="topbar">
      <span class="brand">MinimalERP</span>
      <nav class="crumbs" aria-label="You are here">
        {trail.map((frame, i) => (
          <span key={frame.id} class={i === trail.length - 1 ? 'here' : ''} aria-current={i === trail.length - 1 ? 'page' : undefined}>
            {i > 0 && <span class="sep"> › </span>}
            {titleOf(frame.screen)}
          </span>
        ))}
      </nav>
      <span class="spacer" />
      <span class="company" data-testid="company-name">{books.current?.masters.company.name ?? 'No company open'}</span>
      {app.account && (
        <>
          <span class="account" data-testid="account-email" title={app.account.email}>
            {app.account.email}
          </span>
          <button type="button" class="goto-button" onClick={() => void app.account?.signOut()} aria-label="Sign out">
            <span>Sign out</span>
          </button>
        </>
      )}
      {app.localBooks && (
        <>
          <span class="account" data-testid="local-books" title="Your books are kept in this browser only">
            This browser only
          </span>
          <button type="button" class="goto-button" onClick={() => app.localBooks?.signIn()} aria-label="Sign in">
            <span>Sign in</span>
          </button>
        </>
      )}
      {PANEL_SCREENS.includes(screens.top.screen.type) && (
        <button type="button" class="goto-button keys-toggle" onClick={() => ui.toggleKeys()} aria-pressed={ui.keysOpen} aria-label="Keys">
          <span>Keys</span>
        </button>
      )}
      <button type="button" class="goto-button" onClick={() => app.openGoTo()} aria-label="Go To">
        <span>Go To</span>
        {goto && <Kbd chord={goto} />}
      </button>
    </header>
  );
}
