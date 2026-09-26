import { FORMS, titleOf } from '../books/forms';
import { PLURALS } from '../books/books';
import { kindTitle } from '../vouchers/kinds';
import { Kbd } from '../ui/Kbd';
import { useEffect, useRef, useState } from 'preact/hooks';
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
      case 'company-switch':
        return 'Switch Company';
      case 'company-user':
        return 'Company User';
      case 'company-gmail':
        return 'Company Gmail';
      case 'exchange-sent':
        return 'Sent to Companies';
      case 'invoice-settings':
        return 'Invoice / PDF Settings';
      case 'inbox':
        return 'AI Inbox';
      case 'import-export':
        return 'Import / Export';
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
  const { screens, keymapStore, app, books, ui, registry, scopes } = useServices();
  useSubscriptions(screens, keymapStore, books, ui);
  const titleOf = useScreenTitle();
  const goto = keymapStore.keymap.chordsFor('goto.open')[0];
  const [refreshing, setRefreshing] = useState(false);

  const trail = screens.all;

  // A click on an earlier crumb closes the windows above it one at a time, exactly as the × does — so a window with something entered
  // still asks "Close and leave?", and the walk stops there. One window per render: the next top screen's keys are registered by then.
  const target = useRef<number | undefined>(undefined);
  const closeOne = () => {
    const depth = screens.depth;
    const active = scopes.snapshot();
    registry.dispatch('app.close', { scopes: active.ids, modal: active.modal });
    if (screens.depth === depth) target.current = undefined; // it asked (or could not close): stop here
  };
  useEffect(() => {
    if (target.current === undefined) return;
    if (screens.depth <= target.current) {
      target.current = undefined;
      return;
    }
    const t = setTimeout(closeOne, 0);
    return () => clearTimeout(t);
  }, [trail.length]);
  const goToCrumb = (i: number) => {
    if (i >= trail.length - 1) return;
    target.current = i + 1;
    closeOne();
  };

  const refresh = async () => {
    if (refreshing || !books.current) return;
    setRefreshing(true);
    try {
      await books.current.reload();
    } catch (error) {
      console.error('Could not refresh the books', error);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <header class="topbar">
      <span class="brand">MinimalERP</span>
      <nav class="crumbs" aria-label="You are here">
        {trail.map((frame, i) => (
          <span key={frame.id} class={i === trail.length - 1 ? 'here' : ''} aria-current={i === trail.length - 1 ? 'page' : undefined}>
            {i > 0 && <span class="sep"> › </span>}
            {i === trail.length - 1 ? (
              titleOf(frame.screen)
            ) : (
              <button type="button" class="crumb-link" data-testid="crumb" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => goToCrumb(i)}>
                {titleOf(frame.screen)}
              </button>
            )}
          </span>
        ))}
      </nav>
      <span class="spacer" />
      {books.canSwitch && books.ownsOpenCompany && books.current ? (
        <button
          type="button"
          class="company company-switch"
          data-testid="company-name"
          title="Switch company"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => registry.dispatch('company.switch', { scopes: scopes.snapshot().ids, modal: scopes.snapshot().modal })}
        >
          {books.current.masters.company.name} ▾
        </button>
      ) : (
        <span class="company" data-testid="company-name">{books.current?.masters.company.name ?? 'No company open'}</span>
      )}
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
      {books.current && (
        <button
          type="button"
          class="goto-button"
          data-testid="refresh"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label="Refresh"
          title="Load the books again (what others saved meanwhile)"
        >
          {refreshing && <span class="busy-ring" aria-hidden="true" />}
          <span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
        </button>
      )}
      <button type="button" class="goto-button" onClick={() => app.openGoTo()} aria-label="Go To">
        <span>Go To</span>
        {goto && <Kbd chord={goto} />}
      </button>
    </header>
  );
}
