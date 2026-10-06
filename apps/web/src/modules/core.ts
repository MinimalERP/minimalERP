import type { Command, ModuleManifest } from '@minimalerp/command';
import { isTouch, switchUi } from '../mobile/device';
import type { AppContext } from '../shell/services';

/**
 * The commands that make the shell itself work. Note how little is here: navigation is a handful of
 * commands, and list movement (`nav.*`) is not code at all — it is a NAME. Whichever screen or overlay
 * is active supplies the behaviour (see useListNavigation), and the keymap decides which key triggers it.
 */
const contextual = (id: string, title: string, extra: Partial<Command<AppContext>> = {}): Command<AppContext> => ({
  id,
  title,
  category: 'Navigation',
  hidden: true,
  configurable: false,
  ...extra,
});

const commands: Command<AppContext>[] = [
  {
    id: 'goto.open',
    title: 'Go To…',
    category: 'Navigation',
    hidden: true,
    configurable: true,
    allowInModal: true, // pressing it again closes the palette
    statusBar: { label: 'Go To', order: 10 },
    run: (app) => app.toggleGoTo(),
  },
  {
    id: 'assistant.toggle',
    title: 'Assistant',
    category: 'Navigation',
    keywords: ['assistant', 'ask', 'chat', 'ai', 'help', 'question', 'gemini', 'bot'],
    description: 'Ask about stock, orders, invoices and money owed — or anything else',
    configurable: true,
    allowInModal: true, // pressing it again closes the assistant
    run: (app) => app.toggleAssistant(),
  },
  {
    id: 'app.back',
    title: 'Back',
    category: 'Navigation',
    hidden: true,
    configurable: true,
    statusBar: { label: 'Back', order: 20 },
    // Unavailable on the Gateway, so Esc there is left alone rather than swallowed.
    when: (app) => app.canGoBack(),
    run: (app) => void app.back(),
  },
  {
    // The panel's first button on every level-3 screen. A click means "close this window" — it does not walk back through popups and
    // fields the way Esc does — but a window with something entered still asks "Close and leave?" first (see useLeaveGuard).
    id: 'app.close',
    title: 'Close window',
    category: 'Navigation',
    hidden: true,
    configurable: false,
    panel: { label: 'Close', group: 'Window', order: 0, on: ['voucher', 'report', 'master', 'master-list'], keyOf: 'app.back' },
    when: (app) => app.canGoBack(),
    run: (app) => void app.back(),
  },
  {
    id: 'gateway.open',
    title: 'Gateway',
    category: 'Navigation',
    keywords: ['home', 'main menu', 'start'],
    description: 'The main menu',
    run: (app) => app.goHome(),
  },
  {
    // Only where there is a touch screen: the touch interface (look-up and quick entry), remembered on this device. It comes back with
    // "Desktop version" there.
    id: 'ui.mobile',
    title: 'Mobile version',
    category: 'Settings',
    keywords: ['mobile', 'phone', 'touch', 'simple'],
    description: 'The touch interface for a phone: look things up and enter the everyday vouchers',
    configurable: false,
    when: () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && isTouch(window),
    run: () => switchUi('mobile'),
  },
  {
    id: 'settings.keyboard',
    title: 'Keyboard Shortcuts',
    category: 'Settings',
    keywords: ['hotkeys', 'keys', 'keymap', 'bindings', 'customise', 'remap'],
    description: 'See and change every keyboard shortcut',
    run: (app) => app.navigate({ type: 'settings-keyboard' }),
  },
  {
    id: 'settings.gatewayShortcuts',
    title: 'Gateway Shortcuts',
    category: 'Settings',
    keywords: ['home shortcuts', 'gateway links', 'quick links', 'favorites'],
    description: 'Choose which links appear in the Gateway Shortcuts panel',
    run: (app) => app.navigate({ type: 'settings-gateway-shortcuts' }),
  },
  {
    id: 'account.signOut',
    title: 'Sign Out',
    category: 'Account',
    keywords: ['log out', 'logout', 'leave', 'switch user'],
    description: 'Sign out of this account',
    when: (app) => app.account !== undefined,
    run: (app) => void app.account?.signOut(),
  },
  {
    id: 'account.signIn',
    title: 'Sign In',
    category: 'Account',
    keywords: ['log in', 'login', 'online books', 'account'],
    description: 'Sign in to your online books (the books in this browser stay as they are)',
    when: (app) => app.localBooks !== undefined,
    run: (app) => app.localBooks?.signIn(),
  },
  {
    id: 'settings.resetKeymap',
    title: 'Reset Keyboard Shortcuts',
    category: 'Settings',
    keywords: ['restore', 'default', 'hotkeys'],
    description: 'Put every shortcut back to its default',
    run: (app) => app.resetKeymap(),
  },

  // ---- contextual commands: behaviour comes from whichever screen/overlay is active ----
  contextual('nav.up', 'Move up'),
  contextual('nav.down', 'Move down', { statusBar: { label: 'Move', order: 1, also: 'nav.up' } }),
  contextual('nav.pageUp', 'Page up'),
  contextual('nav.pageDown', 'Page down'),
  contextual('nav.first', 'First row'),
  contextual('nav.last', 'Last row'),
  contextual('nav.activate', 'Open selected', { statusBar: { label: 'Select', order: 2 } }),
  contextual('nav.left', 'Move left'),
  contextual('nav.right', 'Move right'),
  contextual('field.next', 'Next field'),
  contextual('field.prev', 'Previous field'),
  contextual('goto.togglePin', 'Pin / unpin result', { statusBar: { label: 'Pin', order: 12 } }),
  contextual('goto.actions', 'More actions for this result'),
  contextual('keymap.change', 'Change shortcut', { statusBar: { label: 'Change shortcut', order: 3 } }),
  contextual('keymap.unbind', 'Remove shortcut', { statusBar: { label: 'Remove', order: 4 } }),
  contextual('keymap.reset', 'Restore default shortcut', { statusBar: { label: 'Restore default', order: 5 } }),
  // The "Close and leave?" prompt (shell/ConfirmLeaveDialog): the keymap refuses plain letters, so Yes/No are Alt+Y / Alt+N.
  contextual('confirm.yes', 'Yes, close and leave'),
  contextual('confirm.no', 'No, stay here'),
];

export const coreModule: ModuleManifest<AppContext> = {
  id: 'core',
  commands,
  bindings: [
    { commandId: 'goto.open', chord: 'Alt+G' },
    { commandId: 'assistant.toggle', chord: 'Alt+Q' },
    { commandId: 'app.back', chord: 'Esc' },

    { commandId: 'nav.up', chord: 'Up' },
    { commandId: 'nav.down', chord: 'Down' },
    { commandId: 'nav.pageUp', chord: 'PageUp' },
    { commandId: 'nav.pageDown', chord: 'PageDown' },
    { commandId: 'nav.first', chord: 'Home' },
    { commandId: 'nav.last', chord: 'End' },
    { commandId: 'nav.activate', chord: 'Enter' },
    { commandId: 'nav.left', chord: 'Left' },
    { commandId: 'nav.right', chord: 'Right' },
    { commandId: 'field.next', chord: 'Tab' },
    { commandId: 'field.prev', chord: 'Shift+Tab' },

    { commandId: 'goto.togglePin', chord: 'Alt+P', scope: 'overlay:goto' },
    { commandId: 'goto.actions', chord: 'Right', scope: 'overlay:goto' },

    // Scoped: while the shortcut editor is open, Enter means "change this shortcut", not "open".
    { commandId: 'keymap.change', chord: 'Enter', scope: 'screen:settings-keyboard' },
    { commandId: 'keymap.unbind', chord: 'Delete', scope: 'screen:settings-keyboard' },
    { commandId: 'keymap.reset', chord: 'Ctrl+Delete', scope: 'screen:settings-keyboard' },

    { commandId: 'confirm.yes', chord: 'Alt+Y', scope: 'overlay:confirm' },
    { commandId: 'confirm.no', chord: 'Alt+N', scope: 'overlay:confirm' },
  ],
  menuSections: [
    { id: 'utilities', title: 'Utilities & Settings', order: 4, description: 'Preferences and tools' },
    // Not a list of commands: MenuScreen shows the tasks themselves here (kept off the Gateway, which must open at once).
    { id: 'tasks', title: 'Tasks', order: 5, description: 'Due this week, tasks and enquiries' },
  ],
  menu: [
    { section: 'utilities', commandId: 'settings.keyboard', order: 1 },
    { section: 'utilities', commandId: 'settings.gatewayShortcuts', order: 2 },
    { section: 'utilities', commandId: 'ui.mobile', order: 8 },
    { section: 'utilities', commandId: 'account.signOut', order: 9 },
    { section: 'utilities', commandId: 'account.signIn', order: 9 },
  ],
};
