import type { ScreenStack } from '@minimalerp/command';
import type { MasterKind } from '@minimalerp/domain';
import type { InboxItem } from '@minimalerp/ports';
import { isMasterKindName } from '../books/forms';

/**
 * A screen is described by data, never by a component: `{ type, id }`. The router below is the only
 * place that turns that into a URL (and back); ScreenHost is the only place that turns it into UI.
 */
export type ScreenRef =
  | { readonly type: 'menu'; readonly id: string } // 'gateway' or a menu section id
  | { readonly type: 'planned'; readonly id: string } // a command that is on the roadmap but not built yet
  | { readonly type: 'settings-keyboard' }
  | { readonly type: 'company-new' }
  | { readonly type: 'company-reset' }
  | { readonly type: 'invoice-settings' }
  | { readonly type: 'import-export' }
  /** A master record's form. `seed` pre-fills a new one (Alt+C from a field) and `inline` makes it hand its result back; neither is part of the address. */
  | {
      readonly type: 'master';
      readonly kind: MasterKind;
      readonly mode: MasterMode;
      readonly id?: string;
      readonly seed?: Readonly<Record<string, string>>;
      readonly inline?: boolean;
    }
  | { readonly type: 'master-list'; readonly kind: MasterKind }
  /** A voucher: `create` names a base kind ("payment") or a voucher type id; display/alter name the voucher. `fromOrder` starts a new sales invoice from a sales order's pending lines (not part of the address). */
  | {
      readonly type: 'voucher';
      readonly mode: VoucherMode;
      readonly typeKey?: string;
      readonly id?: string;
      readonly fromQuotation?: string;
      readonly fromOrder?: string;
      /** A new voucher made from an AI Inbox proposal (ADR-0023): it posts under the proposal's id. Not part of the address. */
      readonly fromInbox?: InboxItem;
    }
  /** The AI Inbox: proposals made from documents sent from Gmail, waiting to be accepted or rejected. */
  | { readonly type: 'inbox' }
  /** A report. The Ledger report names its ledger; without one it asks for it. */
  | { readonly type: 'report'; readonly report: ReportKind; readonly ledgerId?: string; readonly itemId?: string; readonly kind?: string; readonly groupId?: string };

export type MasterMode = 'create' | 'display' | 'alter';
export type VoucherMode = 'create' | 'display' | 'alter';
export type ReportKind = 'daybook' | 'ledger' | 'stock-summary' | 'stock-item' | 'sales-orders' | 'purchase-orders' | 'sales-register' | 'vouchers' | 'trial-balance' | 'book' | 'profit-loss' | 'balance-sheet' | 'outstanding' | 'gstr1' | 'gstr3b' | 'gst-purchases';
const MODES: readonly string[] = ['create', 'display', 'alter'];

export const GATEWAY: ScreenRef = { type: 'menu', id: 'gateway' };

export const sameScreen = (a: ScreenRef, b: ScreenRef): boolean => refToHash(a) === refToHash(b);

/** `#/gateway`, `#/menu/masters`, `#/planned/report.trialBalance`, `#/settings/keyboard`, `#/master/ledger/create`, `#/master/party/alter/<id>`, `#/masters/ledger` */
export function refToHash(ref: ScreenRef): string {
  switch (ref.type) {
    case 'menu':
      return ref.id === 'gateway' ? '#/gateway' : `#/menu/${encodeURIComponent(ref.id)}`;
    case 'planned':
      return `#/planned/${encodeURIComponent(ref.id)}`;
    case 'settings-keyboard':
      return '#/settings/keyboard';
    case 'company-new':
      return '#/company/new';
    case 'company-reset':
      return '#/company/reset';
    case 'invoice-settings':
      return '#/company/invoice-settings';
    case 'inbox':
      return '#/inbox';
    case 'import-export':
      return '#/import-export';
    case 'master':
      return ref.mode === 'create' || ref.id === undefined
        ? `#/master/${ref.kind}/create`
        : `#/master/${ref.kind}/${ref.mode}/${encodeURIComponent(ref.id)}`;
    case 'master-list':
      return `#/masters/${ref.kind}`;
    case 'voucher':
      return ref.mode === 'create' || ref.id === undefined
        ? `#/voucher/new/${encodeURIComponent(ref.typeKey ?? '')}`
        : `#/voucher/${ref.mode}/${encodeURIComponent(ref.id)}`;
    case 'report':
      if (ref.report === 'ledger' && ref.ledgerId) return `#/report/ledger/${encodeURIComponent(ref.ledgerId)}`;
      if (ref.report === 'stock-item' && ref.itemId) return `#/report/stock-item/${encodeURIComponent(ref.itemId)}`;
      if (ref.report === 'trial-balance' && ref.groupId) return `#/report/trial-balance/${encodeURIComponent(ref.groupId)}`;
      if (ref.report === 'book' && ref.kind) return `#/report/book/${encodeURIComponent(ref.kind)}`;
      if (ref.report === 'outstanding' && ref.kind) return `#/report/outstanding/${encodeURIComponent(ref.kind)}${ref.ledgerId ? `/${encodeURIComponent(ref.ledgerId)}` : ''}`;
      if (ref.report === 'vouchers' && ref.kind) return `#/report/vouchers/${encodeURIComponent(ref.kind)}`;
      if ((ref.report === 'gstr1' || ref.report === 'gstr3b' || ref.report === 'gst-purchases') && ref.kind) return `#/report/${ref.report}/${encodeURIComponent(ref.kind)}`;
      if (ref.report === 'sales-orders' && ref.itemId) return `#/report/sales-orders/${encodeURIComponent(ref.itemId)}`;
      if (ref.report === 'purchase-orders' && ref.itemId) return `#/report/purchase-orders/${encodeURIComponent(ref.itemId)}`;
      return `#/report/${ref.report}`;
  }
}

/** The screen an address points at, or undefined if it is not one we recognise. */
export function hashToRef(hash: string): ScreenRef | undefined {
  const path = hash.replace(/^#/, '');
  if (path === '' || path === '/' || path === '/gateway') return GATEWAY;
  if (path === '/settings/keyboard') return { type: 'settings-keyboard' };
  if (path === '/company/new') return { type: 'company-new' };
  if (path === '/company/reset') return { type: 'company-reset' };
  if (path === '/company/invoice-settings') return { type: 'invoice-settings' };
  if (path === '/inbox') return { type: 'inbox' };
  if (path === '/import-export') return { type: 'import-export' };
  const record = /^\/master\/([A-Za-z]+)\/(create|display|alter)(?:\/(.+))?$/.exec(path);
  if (record) {
    const [, kind = '', mode = '', rawId] = record;
    if (!isMasterKindName(kind) || !MODES.includes(mode)) return undefined;
    if (mode === 'create') return { type: 'master', kind, mode: 'create' };
    if (rawId === undefined) return undefined;
    try {
      return { type: 'master', kind, mode: mode as MasterMode, id: decodeURIComponent(rawId) };
    } catch {
      return undefined;
    }
  }
  const voucher = /^\/voucher\/(new|display|alter)\/(.+)$/.exec(path);
  if (voucher) {
    try {
      const value = decodeURIComponent(voucher[2] ?? '');
      return voucher[1] === 'new' ? { type: 'voucher', mode: 'create', typeKey: value } : { type: 'voucher', mode: voucher[1] as VoucherMode, id: value };
    } catch {
      return undefined;
    }
  }
  const report = /^\/report\/(daybook|ledger|stock-summary|stock-item|sales-orders|purchase-orders|sales-register|vouchers|trial-balance|book|profit-loss|balance-sheet|outstanding|gstr1|gstr3b|gst-purchases)(?:\/(.+))?$/.exec(path);
  if (report) {
    if (report[1] === 'daybook') return { type: 'report', report: 'daybook' };
    if (report[1] === 'stock-summary') return { type: 'report', report: 'stock-summary' };
    if (report[1] === 'sales-register') return { type: 'report', report: 'sales-register' };
    try {
      if (report[1] === 'profit-loss') return { type: 'report', report: 'profit-loss' };
      if (report[1] === 'balance-sheet') return { type: 'report', report: 'balance-sheet' };
      if (report[1] === 'trial-balance') return report[2] ? { type: 'report', report: 'trial-balance', groupId: decodeURIComponent(report[2]) } : { type: 'report', report: 'trial-balance' };
      if (report[1] === 'book') return report[2] === 'cash' || report[2] === 'bank' ? { type: 'report', report: 'book', kind: report[2] } : undefined;
      if (report[1] === 'outstanding') {
        const [side, party] = (report[2] ?? '').split('/');
        if (side !== 'receivable' && side !== 'payable') return undefined;
        return party ? { type: 'report', report: 'outstanding', kind: side, ledgerId: decodeURIComponent(party) } : { type: 'report', report: 'outstanding', kind: side };
      }
      if (report[1] === 'gstr1' || report[1] === 'gstr3b' || report[1] === 'gst-purchases') {
        if (report[2] === undefined) return { type: 'report', report: report[1] };
        return /^\d{4}-(0[1-9]|1[0-2])$/.test(report[2]) ? { type: 'report', report: report[1], kind: report[2] } : undefined;
      }
      if (report[1] === 'vouchers') return report[2] ? { type: 'report', report: 'vouchers', kind: decodeURIComponent(report[2]) } : undefined;
      if (report[1] === 'sales-orders') return report[2] ? { type: 'report', report: 'sales-orders', itemId: decodeURIComponent(report[2]) } : { type: 'report', report: 'sales-orders' };
      if (report[1] === 'purchase-orders') return report[2] ? { type: 'report', report: 'purchase-orders', itemId: decodeURIComponent(report[2]) } : { type: 'report', report: 'purchase-orders' };
      if (report[1] === 'stock-item') return report[2] ? { type: 'report', report: 'stock-item', itemId: decodeURIComponent(report[2]) } : { type: 'report', report: 'stock-item' };
      return report[2] ? { type: 'report', report: 'ledger', ledgerId: decodeURIComponent(report[2]) } : { type: 'report', report: 'ledger' };
    } catch {
      return undefined;
    }
  }
  const list = /^\/masters\/([A-Za-z]+)$/.exec(path);
  if (list) return isMasterKindName(list[1] ?? '') ? { type: 'master-list', kind: list[1] as MasterKind } : undefined;
  const m = /^\/(menu|planned)\/(.+)$/.exec(path);
  if (!m) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(m[2] as string);
  } catch {
    return undefined;
  }
  return m[1] === 'menu' ? { type: 'menu', id } : { type: 'planned', id };
}

/** Only what the router needs from `window`, so it can be tested without a browser. */
export interface RouterWindow {
  readonly location: { hash: string };
  readonly history: { replaceState(data: unknown, unused: string, url?: string | null): void };
  addEventListener(type: 'hashchange', listener: () => void): void;
  removeEventListener(type: 'hashchange', listener: () => void): void;
}

/**
 * Keeps the address bar and the screen stack in step.
 *   - on load, the address decides the screen (Gateway beneath it, so Esc has somewhere to go)
 *   - as the user navigates, the address follows the top screen (no history clutter: Esc is "back")
 *   - if the address is edited by hand, the stack follows it
 */
export function bindRouter(screens: ScreenStack<ScreenRef>, win: RouterWindow): () => void {
  const fromAddress = () => {
    const ref = hashToRef(win.location.hash);
    if (!ref) return;
    if (sameScreen(ref, GATEWAY)) screens.reset(GATEWAY);
    else screens.reset(GATEWAY, ref);
  };
  const toAddress = () => {
    const hash = refToHash(screens.top.screen);
    if (win.location.hash !== hash) win.history.replaceState(null, '', hash);
  };

  if (win.location.hash) fromAddress();
  toAddress();
  const offStack = screens.subscribe(toAddress);
  const onHash = () => {
    if (win.location.hash !== refToHash(screens.top.screen)) fromAddress();
  };
  win.addEventListener('hashchange', onHash);
  return () => {
    offStack();
    win.removeEventListener('hashchange', onHash);
  };
}
