import { type EntityDoc, type Frame, searchEntities } from '@minimalerp/command';
import { type Money, type Voucher, formatQty, formatRate, isQtyText, parseQty, partyLedgerId } from '@minimalerp/domain';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { Only } from '../shell/Only';
import { WindowClose } from '../shell/WindowClose';
import { useIdleOnBlankClick } from '../shell/idle';
import { useCommandHandler, useFrameState, useServices, useSubscriptions } from '../shell/hooks';
import type { InboxItem } from '@minimalerp/ports';
import type { ScreenRef, VoucherMode } from '../shell/router';
import { inboxBanner, itemSeedOf, partySeedOf, salesFormFromProposal } from '../vouchers/proposalForms';
import { useLeaveGuard } from '../shell/useLeaveGuard';
import { Kbd } from '../ui/Kbd';
import { ListView } from '../ui/ListView';
import { defaultDate, fyOf, resolveTypeId } from '../vouchers/entryHelpers';
import { addDays, formatAmount, formatDate, formatQuantity, parseDateInput } from '../vouchers/format';
import { ENTRY_KINDS, type SalesKind, docProfile, invoiceKindOf } from '../vouchers/kinds';
import {
  type Option,
  type OrderOption,
  type SalesForm,
  type SalesLineForm,
  blankSalesForm,
  blankSalesLine,
  customerOptions,
  defaultSalesLedger,
  dueDateFor,
  gstDefaults,
  godownWithStock,
  hiddenItemReason,
  invoiceFormFromOrder,
  isBlankSales,
  itemOptions,
  openOrderLines,
  openOrdersOf,
  orderCallName,
  partyDetailsOfParty,
  previewSales,
  salesFormFromVoucher,
  salesKindOf,
  salesLedgerOptions,
  switchSales,
  trimPlaces,
  withOrderLines,
} from '../vouchers/salesModel';
import { useOtherVoucherHandlers } from '../vouchers/otherVoucher';
import { PartyDetailsDialog } from './PartyDetailsDialog';
import { FieldsDialog } from './ReportDialogs';
import type { CreatedMaster } from './MasterFormScreen';
import type { InvoiceDoc } from '../ui/PrintView';
import { placeOfSupplyText } from '../ui/printing';

const SCOPE = 'screen:voucher';
const MAX_OPTIONS = 8;

type Kind = 'date' | 'party' | 'ref' | 'eway' | 'sledger' | 'billno' | 'due' | 'item' | 'wh' | 'ord' | 'ldue' | 'qty' | 'rate' | 'gst' | 'narration';
interface Field {
  readonly key: string;
  readonly kind: Kind;
  readonly line?: number;
}

/** A problem's cell (`line.2.qty`) → the key of the field that shows it (`l2.qty`); header problems already use their field's key. */
const focusKeyOf = (field: string): string => {
  const m = /^line\.(\d+)\.(\w+)$/.exec(field);
  return m ? `l${m[1]}.${m[2]}` : field;
};

/**
 * Date first (F2 only), then who it is for, then each line, then the narration. An invoice also asks for its sales (or purchase) ledger — and,
 * on a purchase, the supplier's invoice number — and the date the bill falls due, and each line for a godown and (optionally) the order line
 * it fills; an order asks each line for its own due date.
 */
function fieldsOf(form: SalesForm, kind: SalesKind, gstOn = false): Field[] {
  const p = docProfile(kind);
  const out: Field[] = [
    { key: 'date', kind: 'date' },
    { key: 'party', kind: 'party' },
    { key: 'ref', kind: 'ref' },
  ];
  if (p.invoice) {
    if (p.side === 'sales') out.push({ key: 'eway', kind: 'eway' });
    out.push({ key: 'sledger', kind: 'sledger' });
    if (p.side === 'purchase') out.push({ key: 'billno', kind: 'billno' });
    out.push({ key: 'due', kind: 'due' });
  }
  form.lines.forEach((l, i) => {
    out.push({ key: `l${i}.item`, kind: 'item', line: i });
    // a one-time (written) line has no godown and no order line: its HSN, qty and unit are in its Alt+T form
    if (p.invoice && !l.oneTime) out.push({ key: `l${i}.wh`, kind: 'wh', line: i }, { key: `l${i}.ord`, kind: 'ord', line: i });
    else out.push({ key: `l${i}.ldue`, kind: 'ldue', line: i });
    out.push({ key: `l${i}.qty`, kind: 'qty', line: i }, { key: `l${i}.rate`, kind: 'rate', line: i });
    if (gstOn) out.push({ key: `l${i}.gst`, kind: 'gst', line: i });
  });
  out.push({ key: 'narration', kind: 'narration' });
  return out;
}

const orderId = (o: { orderId: string; lineId: string }): string => `${o.orderId}|${o.lineId}`;

interface Props {
  readonly frame: Frame<ScreenRef>;
  readonly books: Books;
  readonly mode: VoucherMode;
  readonly typeId: string;
  readonly voucher: Voucher | undefined;
  /** A new invoice starts with the pending lines of this sales order. */
  readonly fromOrder?: string | undefined;
  /** A new document made from an AI Inbox proposal (ADR-0023): it posts under the proposal's id. */
  readonly fromInbox?: InboxItem | undefined;
}

/**
 * The window for the item-line documents: the Sales Order (what a customer asked for, each line with its own due date) and the Sales
 * Invoice (goods delivered and billed, each line optionally against an order line), and their mirror on the buying side — the Purchase Order
 * and the Purchase Invoice (goods received and billed by the supplier's invoice number). The same worksheet as every other voucher — compact
 * header, the entry grid straight under it, narration at the foot, its actions in the panel — and an invoice and its order switch into each
 * other in place (F8 / Shift+F8, F9 / Shift+F9) keeping the party, the reference and the lines. What differs between the four is in `docProfile`.
 */
export function SalesVoucherEntry({ frame, books, mode, typeId, voucher, fromOrder, fromInbox }: Props) {
  const { app, keymapStore, print } = useServices();
  useSubscriptions(books, keymapStore);
  const masters = books.masters;
  const readOnly = mode === 'display';
  const propKind = (salesKindOf(masters, typeId) ?? 'sales') as SalesKind;
  /** The godown and the sales / purchase ledger a new document starts with (the ledger is the one of ITS side). */
  const extra = (k: SalesKind = propKind) => ({ warehouse: defaultGodown(books), salesLedger: defaultSalesLedger(masters, docProfile(k).side) });
  const blankForm = (): SalesForm => blankSalesForm(crypto.randomUUID(), typeId, defaultDate(masters), crypto.randomUUID(), extra());
  /** A new invoice "for what is pending on that order": its customer, PO and a line per pending order line. Blank if there is nothing to invoice. */
  const fromOrderForm = (): SalesForm | undefined => {
    const order = fromOrder ? books.voucher(fromOrder) : undefined;
    return order ? invoiceFormFromOrder(order, books.orders, masters, { id: crypto.randomUUID(), typeId, date: defaultDate(masters), newKey: () => crypto.randomUUID(), stock: books.stock, ...extra() }) : undefined;
  };
  const inboxForm = (): SalesForm | undefined =>
    fromInbox
      ? salesFormFromProposal(fromInbox, masters, {
          typeId,
          newKey: () => crypto.randomUUID(),
          ...extra(),
          orders: books.orders,
          stock: books.stock,
          order: fromInbox.proposal.fromOrderId ? books.voucher(fromInbox.proposal.fromOrderId) : undefined,
        })
      : undefined;
  const startForm = (): SalesForm => (voucher ? salesFormFromVoucher(voucher, masters, books.orders) : (mode === 'create' && (inboxForm() ?? fromOrderForm())) || blankForm());
  /** A proposal is its own starting point: it neither loads nor leaves a half-entered draft (that belongs to the ordinary New voucher). */
  const drafts = mode === 'create' && !fromInbox;

  const [form, setFormState] = useFrameState<SalesForm>(frame, 'form', startForm());
  // a proposal opens on the first thing the reading could not settle: the party, else the first line without an item
  const firstOpen = (): string => {
    if (form.partyId === '') return 'party';
    const i = form.lines.findIndex((l) => l.itemId === '');
    return i >= 0 ? `l${i}.item` : 'l0.qty';
  };
  const [focusKey, setFocusKey] = useFrameState<string>(frame, 'focus', mode === 'create' ? (fromInbox ? firstOpen() : form.partyId !== '' ? 'l0.qty' : 'party') : 'date');
  const [dateText, setDateText] = useFrameState<string>(frame, 'dateText', formatDate(form.date));
  const [showErrors, setShowErrors] = useFrameState<boolean>(frame, 'showErrors', false);
  const [partyOpen, setPartyOpen] = useState(false);
  /** The line whose one-time form (Alt+T) is open. */
  const [oneTimeFor, setOneTimeFor] = useState<number | undefined>(undefined);
  const [pick, setPick] = useState({ index: 0, touched: false });
  const [pickerClosed, setPickerClosed] = useState<string | undefined>(undefined);
  const [banner, setBanner] = useState<{ text: string; tone: 'error' | 'ok' | 'note' } | undefined>(inboxBanner(fromInbox));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<'cancel' | 'close' | undefined>(undefined);
  const leave = useLeaveGuard('This document has not been saved.');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Clicking blank space deactivates the active field until a field is clicked or a key pressed. */
  const { idle, wake } = useIdleOnBlankClick(rootRef);
  const draftReady = useRef(mode !== 'create');

  const kind = (salesKindOf(masters, form.typeId) ?? 'sales') as SalesKind;
  const p = docProfile(kind);
  /** A company that charges GST: each invoice line has a GST % (from its item), and the tax is stated under the grid. */
  const gstOn = p.invoice && masters.company.chargeGst === true;
  const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
  const type = masters.voucherType(form.typeId as never);
  const fields = fieldsOf(form, kind, gstOn);
  const at = Math.max(0, fields.findIndex((f) => f.key === focusKey));
  const current = fields[at] as Field;

  const fresh = (): SalesForm => (frame.state.get('form') as SalesForm | undefined) ?? form;
  const update = (fn: (f: SalesForm) => SalesForm) => setFormState(fn(fresh()));
  const setLine = (i: number, patch: Partial<SalesLineForm>) => update((f) => ({ ...f, lines: f.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) }));

  // ---- drafts: a half-entered document survives a reload ----
  const draftKey = `sales:${form.typeId}`;

  // Leaving the window — Esc, ×, saving, another screen on top — leaves nothing behind: the next New voucher opens clean. (A page reload never runs
  // this, so a half-entered document still survives a reload.)
  const draftKeyNow = useRef(draftKey);
  draftKeyNow.current = draftKey;
  useEffect(
    () => () => {
      if (drafts) void books.clearDraft(draftKeyNow.current);
    },
    [],
  );
  useEffect(() => {
    if (!drafts || frame.state.has('form-loaded')) {
      draftReady.current = true;
      return;
    }
    frame.state.set('form-loaded', true);
    void books.loadDraft(draftKey).then((saved) => {
      const d = saved as SalesForm | undefined;
      if (d && isBlankSales(fresh()) && d.typeId === typeId && Array.isArray(d.lines)) {
        setFormState(d);
        setDateText(formatDate(d.date));
      }
      draftReady.current = true;
    });
  }, []);
  useEffect(() => {
    if (!drafts || !draftReady.current) return;
    const t = setTimeout(() => void (isBlankSales(form) ? books.clearDraft(draftKey) : books.saveDraft(draftKey, form)), 350);
    return () => clearTimeout(t);
  }, [form]);

  // ---- the stock and the orders WITHOUT this voucher (what its own lines are checked and shown against), and the engine's verdict ----
  const base = useMemo(() => books.stock.withChange({ remove: [form.id as never] }), [books.stock, form.id]);
  const preview = useMemo(() => previewSales(form, kind, masters, books.stock, books.orders, undefined, books.vouchers), [form, kind, masters, books.stock, books.orders, books.vouchers]);
  /** The posted voucher as a plain invoice/order document — every amount comes from `preview.amounts`/`total`/`gst`/`grand`,
   * indexed exactly as `previewSales` computed them, so a printed figure can never disagree with what the screen showed. */
  const buildPrintDoc = (): InvoiceDoc | undefined => {
    if (!voucher || !type) return undefined;
    const details = form.partyDetails;
    const lines = form.lines
      .map((l, i) => ({ l, amount: preview.amounts.get(i) }))
      .filter((x): x is { l: SalesLineForm; amount: Money } => (x.l.itemId !== '' || x.l.oneTime === true) && x.amount !== undefined)
      .map(({ l, amount }) => {
        const item = l.itemId !== '' ? masters.stockItem(l.itemId as never) : undefined;
        // a one-time line prints with the unit chosen in its Alt+T form
        const unit = item ? masters.unit(item.unitId) : masters.units.find((u) => u.symbol === l.unit);
        const q = parseQty(l.qty.trim());
        return {
          desc: l.itemLabel,
          hsn: l.hsn,
          qty: q !== undefined ? `${formatQuantity(q, unit?.decimals ?? 0)} ${unit?.symbol ?? l.unit ?? ''}`.trim() : l.qty,
          rate: l.rate,
          amount,
          gstRate: l.gstRate,
        };
      });
    return {
      kind: 'invoice',
      docTitle: kind === 'sales' && masters.company.chargeGst === true ? 'Tax Invoice' : type.name,
      numberLabel: kind === 'sales' ? 'Invoice No.' : undefined,
      number: voucher.number,
      date: voucher.date,
      poNo: form.reference || undefined,
      ewayBillNo: kind === 'sales' ? form.ewayBillNo || undefined : undefined,
      placeOfSupply: placeOfSupplyText(details?.shipTo?.stateCode ?? details?.billTo?.stateCode ?? details?.placeOfSupply),
      party: { name: details?.mailingName ?? form.partyLabel, gstin: details?.gstin, billTo: details?.billTo, shipTo: details?.shipTo },
      lines,
      subtotal: preview.total,
      gst: preview.gst,
      grandTotal: preview.grand,
      narration: form.narration || undefined,
    };
  };
  const issueAt = (key: string): string | undefined => fieldErrors[key] || (showErrors ? preview.issues.find((i) => i.field === key)?.message : undefined);
  const general = showErrors ? preview.issues.filter((i) => i.field === 'general').map((i) => i.message) : [];
  /** A posted order as the order book reads it now: its status and what each line has had delivered. */
  const orderState = voucher && p.order ? books.orders.state(voucher.id as never) : undefined;

  // ---- focus ----
  useLayoutEffect(() => {
    if (idle || partyOpen) return; // idle: a blank click deactivated the field. A dialog has the focus; the field gets it back when it closes
    const el = rootRef.current?.querySelector<HTMLInputElement>(`[data-vf="${current.key}"]`);
    el?.focus();
    if (el && el.type === 'text') el.select();
  }, [focusKey, mode, form.lines.length, partyOpen, idle]);
  const go = (key: string) => {
    wake();
    setPick({ index: 0, touched: false });
    setPickerClosed(undefined);
    setFocusKey(key);
  };
  const nextKey = (from = at): string | undefined => fields[from + 1]?.key;
  const prevKey = (from = at): string | undefined => fields[from - 1]?.key;

  // ---- pickers: customers, the sales ledger, items, godowns and the order lines an invoice line can fill ----
  const line = current.line !== undefined ? form.lines[current.line] : undefined;
  const parties = useMemo(() => customerOptions(masters, p.side), [masters, p.side]);
  const salesLedgers = useMemo(() => salesLedgerOptions(masters, p.side), [masters, p.side]);
  const items = useMemo(() => itemOptions(masters), [masters]);
  const godowns: Option[] = useMemo(() => masters.warehouses.filter((w) => w.isActive).map((w) => ({ id: w.id, name: w.name, sub: '' })), [masters]);
  const shownDue = (d: string): string => formatDate(d).replace(/-20(\d\d)$/, '-$1');
  const orderChoices: OrderOption[] = useMemo(
    () => (current.kind === 'ord' && form.partyId !== '' ? openOrderLines(books.orders, form.partyId, line?.itemId, form.id, p.side) : []),
    [current.kind, form.partyId, line?.itemId, form.id, books.orders, p.side],
  );
  const orderOptions: Option[] = orderChoices.map((o) => ({
    id: orderId(o),
    name: o.number,
    sub: [
      o.reference,
      line?.itemId ? undefined : masters.stockItem(o.itemId as never)?.name,
      `due ${shownDue(o.due)}`,
      `${qtyText(masters, o.itemId, o.pending)} pending of ${qtyText(masters, o.itemId, o.ordered)}`,
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  // An invoice's PO / ref offers the party's open orders (a PO the customer sent us; on the purchase side, ours): choosing one fills the PO and, on an empty invoice, its pending lines.
  const openOrders = useMemo(() => (p.invoice && form.partyId !== '' ? openOrdersOf(books.orders, form.partyId, form.id, p.side) : []), [p.invoice, p.side, form.partyId, form.id, books.orders]);
  const refOptions: Option[] = openOrders.map((o) => ({
    id: o.orderId,
    name: orderCallName(o, p.side),
    sub: [p.side === 'sales' ? (o.reference !== '' ? o.number : undefined) : o.reference !== '' ? `supplier ref ${o.reference}` : undefined, `${o.lines} line${o.lines === 1 ? '' : 's'} pending`, `due ${shownDue(o.due)}`].filter(Boolean).join(' · '),
  }));
  // a one-time line's item cell is plain text: no item list
  const writtenHere = current.kind === 'item' && current.line !== undefined && form.lines[current.line]?.oneTime === true;
  const pickerKind = writtenHere
    ? undefined
    : ((['party', 'sledger', 'item', 'wh', 'ord'] as const).find((k) => k === current.kind) ?? (current.kind === 'ref' && refOptions.length > 0 ? ('ref' as const) : undefined));
  const options: Option[] =
    pickerKind === 'party' ? parties : pickerKind === 'sledger' ? salesLedgers : pickerKind === 'item' ? items : pickerKind === 'wh' ? godowns : pickerKind === 'ord' ? orderOptions : pickerKind === 'ref' ? refOptions : [];
  const pickerOn = !readOnly && pickerKind !== undefined;
  const typedLabel =
    pickerKind === 'party' ? form.partyLabel : pickerKind === 'sledger' ? form.salesLedgerLabel : pickerKind === 'item' ? (line?.itemLabel ?? '') : pickerKind === 'wh' ? (line?.warehouseLabel ?? '') : pickerKind === 'ord' ? (line?.orderLabel ?? '') : pickerKind === 'ref' ? form.reference : '';
  const storedId =
    pickerKind === 'party' ? form.partyId : pickerKind === 'sledger' ? form.salesLedgerId : pickerKind === 'item' ? (line?.itemId ?? '') : pickerKind === 'wh' ? (line?.warehouseId ?? '') : pickerKind === 'ord' ? (line && line.orderId !== '' ? orderId({ orderId: line.orderId, lineId: line.orderLineId }) : '') : pickerKind === 'ref' ? (refOptions.find((o) => o.name === form.reference)?.id ?? '') : '';
  const storedName = pickerKind === 'ord' ? (line && line.orderId !== '' ? line.orderLabel : '') : (options.find((o) => o.id === storedId)?.name ?? '');
  const pickerDismissed = pickerClosed !== undefined && pickerClosed === current.key;
  const hits: Option[] = useMemo(() => {
    if (!pickerOn) return [];
    const typed = typedLabel.trim();
    // A list opens when something is TYPED and offers only what matches; an empty (or already chosen) field shows no list. The two order pickers are
    // the exception: what they list is the party's own open orders — the way an order is chosen at all.
    if (typed === '' || typed === storedName) return pickerKind === 'ord' || pickerKind === 'ref' ? options.slice(0, MAX_OPTIONS) : [];
    const docs: EntityDoc[] = options.map((o) => ({ key: o.id, kind: '', scope: 'v', title: o.name, subtitle: o.sub, commandId: '', args: o.id }));
    return searchEntities(docs, typed, { limit: MAX_OPTIONS }).map((h) => options.find((o) => o.id === h.key) as Option);
  }, [pickerOn, pickerKind, options.length, current.key, typedLabel, storedName, form.partyId, line?.itemId]);
  const pickIndex = Math.min(pick.index, Math.max(0, hits.length - 1));

  /** What the book holds of an item on the document's date, said the way a person reads it: "120 Nos". */
  const stockOf = (itemId: string): string | undefined => {
    const item = masters.stockItem(itemId as never);
    if (!item) return undefined;
    const unit = masters.unit(item.unitId);
    const pos = base.positionAt(item.id, form.date as never);
    return `${formatQuantity(pos.qty, unit?.decimals ?? 0)} ${unit?.symbol ?? ''}`.trim();
  };

  /** The godown an invoice line for this item starts in: the main one if it holds the goods, otherwise the one that does. */
  /** Which godowns hold an item on the document's date, and how much: "Main Location 50". */
  const heldIn = (itemId: string): string => {
    const item = masters.stockItem(itemId as never);
    const decimals = (item ? masters.unit(item.unitId)?.decimals : 0) ?? 0;
    return masters.warehouses
      .filter((w) => w.isActive)
      .map((w) => ({ name: w.name, q: base.qtyAt(itemId as never, w.id, form.date as never) }))
      .filter((w) => w.q > 0n)
      .map((w) => `${w.name} ${formatQuantity(w.q, decimals)}`)
      .join(', ');
  };
  const godownFor = (itemId: string, qty: bigint = 1n) => godownWithStock(masters, books.stock, itemId, fresh().date, defaultGodown(books), qty);

  /** Adds an order's remaining (pending) lines to the invoice; returns how many were added. */
  const bringOrderLines = (orderId: string): number => {
    const f = fresh();
    const pending = openOrderLines(books.orders, f.partyId, undefined, f.id, p.side).filter((l) => l.orderId === orderId);
    // goods leaving start in the godown that holds them; goods arriving start in the main one
    const r = withOrderLines(f, pending, masters, () => crypto.randomUUID(), p.side === 'sales' ? godownFor : () => defaultGodown(books));
    if (r.added > 0) setFormState(r.form);
    return r.added;
  };

  const choose = (o: Option, f: Field = current) => {
    if (f.kind === 'party') {
      const party = masters.party(o.id as never);
      if (!party) return;
      const changed = fresh().partyId !== party.id;
      update((x) => {
        // Another party's order lines cannot stay on the lines.
        const dropped = changed && x.lines.some((l) => l.orderId !== '');
        return {
          ...x,
          partyId: party.id,
          partyLabel: party.name,
          partyDetails: partyDetailsOfParty(party),
          ...(p.invoice && !x.dueTouched ? { due: dueDateFor(masters, party.id, x.date), dueText: formatDate(dueDateFor(masters, party.id, x.date)) } : {}),
          lines: dropped ? x.lines.map((l) => (l.orderId === '' ? l : { ...l, orderId: '', orderLineId: '', orderLabel: '' })) : x.lines,
        };
      });
      if (changed && fresh().lines.some((l) => l.orderId !== '')) setBanner({ text: `The order references were cleared: they belonged to another ${p.noun}.`, tone: 'note' });
      // Choosing a party pulls nothing in from its orders: an invoice is a regular invoice until an order is CHOSEN (in the PO / ref field, on a line, or
      // with Alt+I from the order itself).
      setFieldErrors((e) => ({ ...e, party: '' }));
      return;
    }
    if (f.kind === 'ref') {
      const chosen = openOrders.find((x) => x.orderId === o.id);
      if (!chosen) return;
      update((x) => ({ ...x, reference: orderCallName(chosen, p.side) }));
      // Choosing a PO brings what is REMAINING on it: a line for every order line with something pending (quantity = pending, rate = agreed).
      const added = bringOrderLines(chosen.orderId);
      setBanner({
        text: added > 0 ? `${added} remaining line${added === 1 ? '' : 's'} brought in from ${chosen.number}: check the quantities and accept. × removes a line.` : `Nothing more to bring in from ${chosen.number}: its pending lines are already here.`,
        tone: 'note',
      });
      return;
    }
    if (f.kind === 'sledger') {
      update((x) => ({ ...x, salesLedgerId: o.id, salesLedgerLabel: o.name }));
      setFieldErrors((e) => ({ ...e, sledger: '' }));
      return;
    }
    if (f.line === undefined) return;
    if (f.kind === 'item') {
      const l = fresh().lines[f.line] as SalesLineForm;
      // an order reference is only good for the item it was for
      const stillFits = l.orderId !== '' && books.orders.order(l.orderId as never)?.lines.find((x) => x.id === l.orderLineId)?.itemId === o.id;
      // an invoice line starts in the godown that holds the goods
      const w = p.side === 'sales' && p.invoice ? godownFor(o.id, parseQty(l.qty.trim()) ?? 1n) : undefined;
      const here = l.warehouseId !== '' && (p.side === 'purchase' || base.qtyAt(o.id as never, l.warehouseId as never, fresh().date as never) >= (parseQty(l.qty.trim()) ?? 1n));
      setLine(f.line, {
        itemId: o.id,
        itemLabel: o.name,
        ...(gstOn ? gstDefaults(masters, o.id) : {}),
        ...(l.orderId !== '' && !stillFits ? { orderId: '', orderLineId: '', orderLabel: '' } : {}),
        ...(w && !here ? { warehouseId: w.id, warehouseLabel: w.label } : {}),
      });
      setFieldErrors((e) => ({ ...e, [`line.${f.line}.item`]: '' }));
    } else if (f.kind === 'wh') {
      setLine(f.line, { warehouseId: o.id, warehouseLabel: o.name });
      setFieldErrors((e) => ({ ...e, [`line.${f.line}.wh`]: '' }));
    } else if (f.kind === 'ord') {
      const chosen = orderChoices.find((c) => orderId(c) === o.id);
      if (!chosen) return;
      const l = fresh().lines[f.line] as SalesLineForm;
      const item = masters.stockItem(chosen.itemId as never);
      setLine(f.line, {
        orderId: chosen.orderId,
        orderLineId: chosen.lineId,
        orderLabel: chosen.number,
        itemId: chosen.itemId,
        itemLabel: item?.name ?? l.itemLabel,
        // what is pending and what was agreed are the natural starting point (both can be edited)
        ...(l.qty.trim() === '' ? { qty: trimPlaces(formatQty(chosen.pending, 4)) } : {}),
        ...(l.rate.trim() === '' ? { rate: trimPlaces(formatRate(chosen.rate)) } : {}),
      });
      setFieldErrors((e) => ({ ...e, [`line.${f.line}.ord`]: '' }));
    }
  };

  const movePick = (delta: number): boolean => {
    if (!pickerOn || hits.length === 0) return false;
    setPick({ index: (pickIndex + delta + hits.length) % hits.length, touched: true });
    return true;
  };

  /** Leaves the current field: resolves a half-typed pick, reads a typed date. False (with a message) if it cannot be left. */
  const settle = (): boolean => {
    if (readOnly) return true;
    if (current.kind === 'date') {
      const y = fyOf(masters, fresh().date);
      const parsed = parseDateInput(dateText, { start: y?.start ?? fresh().date, end: y?.end ?? fresh().date, base: fresh().date });
      if (!parsed) {
        setFieldErrors((e) => ({ ...e, date: 'That is not a date — try 10, 10-5 or 10-5-24' }));
        return false;
      }
      update((f) => ({ ...f, date: parsed, ...(p.invoice && !f.dueTouched ? { due: dueDateFor(masters, f.partyId, parsed), dueText: formatDate(dueDateFor(masters, f.partyId, parsed)) } : {}) }));
      setDateText(formatDate(parsed));
      setFieldErrors((e) => ({ ...e, date: '' }));
      return true;
    }
    if (current.kind === 'due' || current.kind === 'ldue') {
      const f = fresh();
      const text = current.kind === 'due' ? f.dueText : ((current.line !== undefined ? f.lines[current.line]?.dueText : '') ?? '');
      const oldIso = current.kind === 'due' ? f.due : ((current.line !== undefined ? f.lines[current.line]?.due : '') ?? '');
      const parsed = parseDateInput(text, { start: f.date, end: addDays(f.date, 366), base: oldIso || f.date });
      const errKey = current.kind === 'due' ? 'due' : `line.${current.line}.ldue`;
      if (!parsed) {
        setFieldErrors((e) => ({ ...e, [errKey]: 'That is not a date — try 10, 10-5 or 10-5-24' }));
        return false;
      }
      if (current.kind === 'due') update((x) => ({ ...x, due: parsed, dueText: formatDate(parsed), dueTouched: true }));
      else if (current.line !== undefined) setLine(current.line, { due: parsed, dueText: formatDate(parsed) });
      setFieldErrors((e) => ({ ...e, [errKey]: '' }));
      return true;
    }
    if (pickerOn) {
      const typed = typedLabel.trim();
      const choice = hits[pickIndex];
      const clear = () => {
        if (storedId === '') return;
        if (pickerKind === 'party') update((x) => ({ ...x, partyId: '', partyLabel: '', partyDetails: undefined }));
        else if (pickerKind === 'sledger') update((x) => ({ ...x, salesLedgerId: '', salesLedgerLabel: '' }));
        else if (current.line !== undefined) {
          if (pickerKind === 'item') setLine(current.line, { itemId: '', itemLabel: '' });
          else if (pickerKind === 'wh') setLine(current.line, { warehouseId: '', warehouseLabel: '' });
          else if (pickerKind === 'ord') setLine(current.line, { orderId: '', orderLineId: '', orderLabel: '' });
        }
      };
      if (pick.touched && choice) {
        choose(choice);
        return true;
      }
      if (typed === '') {
        clear();
        return true;
      }
      if (typed === storedName) return true;
      if (choice) {
        choose(choice);
        return true;
      }
      if (pickerKind === 'ref') return true; // a PO that is not one of our orders' is just the party's reference
      const errKey = current.line === undefined ? current.key : `line.${current.line}.${current.kind}`;
      setFieldErrors((e) => ({
        ...e,
        [errKey]:
          pickerKind === 'ord'
            ? `No open order line of this ${p.noun} matches`
            : pickerKind === 'party'
              ? `No such ${p.noun} — press Alt+C to create it`
              : pickerKind === 'item' && p.invoice
                ? 'No match — Alt+C creates the item, Alt+T writes it as a one-time line'
                : 'No match — press Alt+C to create it',
      }));
      return false;
    }
    return true;
  };

  // ---- moving around ----
  const next = (): boolean => {
    if (!settle()) return true;
    const k = nextKey();
    if (k) go(k);
    return true;
  };

  const addLine = (afterIndex: number) => {
    const f = fresh();
    const previous = f.lines[afterIndex] as SalesLineForm;
    // an order line starts with the due date of the one above; an invoice line in the same godown
    const added = blankSalesLine(crypto.randomUUID(), p.invoice ? { id: previous.warehouseId, label: previous.warehouseLabel } : undefined, p.order ? previous.due || f.date : undefined);
    update((x) => ({ ...x, lines: [...x.lines.slice(0, afterIndex + 1), added, ...x.lines.slice(afterIndex + 1)] }));
    go(`l${afterIndex + 1}.item`);
  };
  const finishLine = (i: number) => {
    if (i + 1 < fresh().lines.length) go(`l${i + 1}.item`);
    else addLine(i);
  };

  const enter = (): boolean => {
    if (readOnly) return next();
    if (current.kind === 'narration') {
      void accept();
      return true;
    }
    if (current.kind === 'item' && current.line !== undefined) {
      const f = fresh();
      const l = f.lines[current.line] as SalesLineForm;
      const i = current.line;
      // Enter on an empty item of the last line means "that is all the lines": drop it and go to the narration.
      if (i > 0 && i === f.lines.length - 1 && l.itemId === '' && l.itemLabel.trim() === '' && l.qty.trim() === '') {
        update((x) => ({ ...x, lines: x.lines.slice(0, -1) }));
        go('narration');
        return true;
      }
    }
    if (!settle()) return true;
    if (current.kind === (gstOn ? 'gst' : 'rate') && current.line !== undefined) {
      finishLine(current.line);
      return true;
    }
    const k = nextKey();
    if (k) go(k);
    return true;
  };

  useCommandHandler(SCOPE, 'field.next', next);
  useCommandHandler(SCOPE, 'field.prev', () => {
    settle();
    const k = prevKey();
    if (k) go(k);
    return true;
  });
  useCommandHandler(SCOPE, 'nav.down', () => {
    if (pickerOn && pickerDismissed) return (setPickerClosed(undefined), true);
    return pickerOn && hits.length > 0 ? movePick(1) : next();
  });
  useCommandHandler(SCOPE, 'nav.up', () => {
    if (pickerOn && hits.length > 0 && !pickerDismissed) return movePick(-1);
    const k = prevKey();
    if (k) go(k);
    return true;
  });
  useCommandHandler(SCOPE, 'nav.activate', enter);

  const changeDate = () => {
    go('date');
    return true;
  };
  const removeLine = () => {
    if (readOnly || current.line === undefined || fresh().lines.length < 2) return false;
    removeAt(current.line);
    return true;
  };
  /**
   * Alt+T on an invoice line's item cell: the typed text becomes a ONE-TIME line (no stock item, no godown, no stock moved — billed and taxed
   * like any line), or back to an item line. For what is sold or bought once and is not worth an item master.
   */
  const openOneTime = (): boolean => {
    if (readOnly || !p.invoice || current.kind !== 'item' || current.line === undefined) return false;
    setOneTimeFor(current.line);
    return true;
  };
  const unitNames = masters.units.filter((u) => u.isActive).map((u) => u.symbol);
  const unitOf = (text: string) => {
    const t = text.trim().toLowerCase().replace(/\.$/, '');
    return masters.units.find((u) => u.isActive && (u.symbol.toLowerCase() === t || u.name.toLowerCase() === t));
  };
  /** The Alt+T form applied: the line becomes (or stays) a one-time line — or, with its description cleared, an item line again. */
  const applyOneTime = (i: number, v: Record<string, string> | undefined) => {
    setOneTimeFor(undefined);
    if (!v) return go(`l${i}.item`);
    const text = (v['description'] ?? '').trim();
    if (text === '') {
      const w = defaultGodown(books);
      setLine(i, { oneTime: false, itemLabel: '', unit: '', hsn: '', warehouseId: w?.id ?? '', warehouseLabel: w?.label ?? '' });
      setBanner({ text: `Line ${i + 1} is a stock item line again: choose the item.`, tone: 'note' });
      return go(`l${i}.item`);
    }
    const wasItem = (fresh().lines[i] as SalesLineForm).itemId !== '';
    setLine(i, {
      oneTime: true,
      itemId: '',
      itemLabel: text,
      hsn: (v['hsn'] ?? '').trim(),
      qty: (v['qty'] ?? '').trim(),
      unit: unitOf(v['unit'] ?? '')?.symbol ?? '',
      warehouseId: '',
      warehouseLabel: '',
      orderId: '',
      orderLineId: '',
      orderLabel: '',
      ...(wasItem ? { gstRate: '' } : {}),
    });
    setFieldErrors((e) => ({ ...e, [`line.${i}.item`]: '', [`line.${i}.qty`]: '' }));
    go(`l${i}.rate`);
  };

  /** Takes line `i` out of the table (the × on its row, or Ctrl+Delete on it). The only line is emptied instead, so there is always one to type in. */
  const removeAt = (i: number) => {
    if (readOnly) return;
    if (fresh().lines.length < 2) {
      update((f) => ({ ...f, lines: [blankSalesLine(crypto.randomUUID(), p.invoice ? defaultGodown(books) : undefined, p.order ? f.date : undefined)] }));
      go('l0.item');
      return;
    }
    update((f) => ({ ...f, lines: f.lines.filter((_, k) => k !== i) }));
    go(`l${Math.max(0, i - 1)}.item`);
  };
  const againstOrder = (): boolean => {
    if (readOnly || !p.invoice) return false;
    if (fresh().partyId === '') {
      setBanner({ text: `Choose the ${p.noun} first: an invoice is made against that ${p.noun}’s orders.`, tone: 'note' });
      go('party');
      return true;
    }
    go(`l${current.line ?? 0}.ord`);
    return true;
  };
  const createInline = (): boolean => {
    if (readOnly || !pickerOn || pickerKind === undefined || pickerKind === 'ord' || pickerKind === 'ref') return false;
    const f = current;
    const masterKind = pickerKind === 'party' ? 'party' : pickerKind === 'sledger' ? 'ledger' : pickerKind === 'item' ? 'stockItem' : 'warehouse';
    void app
      .navigateForResult<CreatedMaster>({
        type: 'master',
        kind: masterKind,
        mode: 'create',
        seed: {
          // from a proposal, a new party or item starts with what the document printed: GSTIN and address; HSN, GST rate and unit
          ...(fromInbox && pickerKind === 'party' ? partySeedOf(fromInbox.proposal) : {}),
          ...(fromInbox && pickerKind === 'item' && line ? itemSeedOf(masters, line, fromInbox.proposal.lines.find((x) => x.text === line.itemLabel)?.unit) : {}),
          ...(typedLabel.trim() === '' ? {} : { name: typedLabel.trim() }),
          ...(pickerKind === 'party' ? { roleType: p.role } : {}),
        },
        inline: true,
      })
      .then((created) => {
        if (created) choose({ id: created.id, name: created.name, sub: '' }, f);
      });
    return true;
  };
  const openPartyDetails = () => {
    if (fresh().partyId === '') {
      setBanner({ text: `Choose the ${p.noun} first.`, tone: 'note' });
      go('party');
      return true;
    }
    setPartyOpen(true);
    return true;
  };

  /** Between an invoice and its order, in place: the party, reference, party details, narration and lines come along. */
  const switchTo = (target: SalesKind): boolean => {
    if (mode !== 'create') return false;
    const targetType = resolveTypeId(masters, target);
    if (!targetType || targetType === form.typeId) return true;
    void books.clearDraft(draftKey);
    const s = switchSales(fresh(), kind, target, targetType, masters, extra(target));
    setFormState(s.form);
    setBanner(s.note ? { text: s.note, tone: 'note' } : undefined);
    setFieldErrors({});
    setFocusKey(fresh().partyId === '' ? 'party' : 'l0.item');
    app.replace({ type: 'voucher', mode: 'create', typeKey: target }); // the address and the breadcrumb follow the type
    return true;
  };
  /** The other side's documents are a different thing (a customer is not a supplier): they open a NEW voucher, replacing this window only if nothing is entered. */
  const switchOrOpen = (target: SalesKind): boolean => {
    if (docProfile(target).side === p.side) return switchTo(target);
    if (mode === 'create' && isBlankSales(fresh())) app.back();
    app.navigate({ type: 'voucher', mode: 'create', typeKey: target });
    return true;
  };
  useCommandHandler(SCOPE, 'voucher.switch.sales', () => switchOrOpen('sales'));
  useCommandHandler(SCOPE, 'voucher.switch.salesOrder', () => switchOrOpen('salesOrder'));
  useCommandHandler(SCOPE, 'voucher.switch.purchase', () => switchOrOpen('purchase'));
  useCommandHandler(SCOPE, 'voucher.switch.purchaseOrder', () => switchOrOpen('purchaseOrder'));
  useOtherVoucherHandlers(SCOPE, ENTRY_KINDS, () => mode === 'create' && isBlankSales(fresh()));

  const dirty = mode !== 'display' && (mode === 'create' ? !isBlankSales(form) : JSON.stringify(form) !== JSON.stringify(salesFormFromVoucher(voucher as Voucher, masters, books.orders)));

  /**
   * Esc closes ONE thing per press, innermost first: the question being asked (Cancel voucher / Close order) → an open popup list → the field
   * being edited (back to the previous field, dropping what was typed but not chosen) → and only from the first field the window itself
   * (which asks "Close and leave?" if anything is entered). Overlay dialogs sit above all of this: they take their own Esc.
   */
  useCommandHandler(SCOPE, 'app.back', () => {
    if (confirm !== undefined) {
      setConfirm(undefined);
      return true;
    }
    if (pickerOn && !pickerDismissed && (hits.length > 0 || typedLabel.trim() !== '')) {
      setPickerClosed(current.key);
      return true;
    }
    if (mode !== 'display') {
      const previous = current.kind === 'date' ? fields[1]?.key : prevKey() === 'date' ? undefined : prevKey();
      if (previous !== undefined) {
        if (pickerOn && pickerKind !== 'ref' && typedLabel.trim() !== storedName) {
          if (pickerKind === 'party') update((x) => ({ ...x, partyLabel: storedName }));
          else if (pickerKind === 'sledger') update((x) => ({ ...x, salesLedgerLabel: storedName }));
          else if (current.line !== undefined) {
            setLine(current.line, pickerKind === 'item' ? { itemLabel: storedName } : pickerKind === 'wh' ? { warehouseLabel: storedName } : { orderLabel: storedName });
          }
        }
        go(previous);
        if (/(^party$|^sledger$|\.item$|\.wh$|\.ord$)/.test(previous)) setPickerClosed(previous);
        return true;
      }
    }
    if (dirty) {
      leave.ask();
      return true;
    }
    return false;
  });
  useCommandHandler(SCOPE, 'app.close', () => {
    if (mode === 'display' || !dirty) return false;
    leave.ask();
    return true;
  });

  // ---- accept / cancel / close order ----
  const accept = async (closeAfter = true): Promise<void> => {
    if (busy || readOnly) return;
    if (!settle()) return;
    setShowErrors(true);
    setBanner(undefined);
    const p = preview;
    if (!p.ok) {
      const first = p.issues.find((i) => i.field !== 'general');
      if (first) go(focusKeyOf(first.field));
      return;
    }
    setBusy(true);
    try {
      const r = mode === 'alter' && voucher ? await books.alter(voucher.id, voucher.version, p.draft) : await books.post(p.draft);
      if (!r.ok) {
        setBanner({ text: r.issues[0]?.message ?? 'The document was refused', tone: 'error' });
        return;
      }
      if (mode === 'alter') {
        app.back();
        return;
      }
      await books.clearDraft(draftKey);
      // Saved: the window closes back to where it was opened from, handing over what it made (a voucher list highlights it). "Save and new" (Alt+N) stays instead.
      if (closeAfter) {
        app.back({ id: r.value.voucher.id, number: r.value.voucher.number, typeName: type?.name ?? 'Voucher' });
        return;
      }
      // ready for the next one: same type and date, a fresh customer and lines
      const f = fresh();
      setFormState(blankSalesForm(crypto.randomUUID(), form.typeId, f.date, crypto.randomUUID(), { warehouse: defaultGodown(books), salesLedger: { id: f.salesLedgerId, label: f.salesLedgerLabel } }));
      setShowErrors(false);
      setFieldErrors({});
      setBanner({ text: `${type?.name ?? 'Sales'} ${r.value.voucher.number} saved.`, tone: 'ok' });
      go('party');
    } finally {
      setBusy(false);
    }
  };
  const cancelVoucher = async (): Promise<void> => {
    if (!voucher || busy) return;
    setBusy(true);
    try {
      const r = await books.cancel(voucher.id, voucher.version);
      setConfirm(undefined);
      if (!r.ok) setBanner({ text: r.issues[0]?.message ?? 'It could not be cancelled', tone: 'error' });
      else app.back();
    } finally {
      setBusy(false);
    }
  };
  /** Closing an order is an alteration (it is versioned and audited like one): the same document with `closed` set. */
  const closeOrder = async (): Promise<void> => {
    if (!voucher || busy) return;
    setBusy(true);
    try {
      const r = await books.alter(voucher.id, voucher.version, { ...(voucher.content as object), closed: true });
      setConfirm(undefined);
      if (!r.ok) setBanner({ text: r.issues[0]?.message ?? 'The order could not be closed', tone: 'error' });
      else app.back();
    } finally {
      setBusy(false);
    }
  };
  const acceptAndNew = (): boolean => {
    if (readOnly || mode !== 'create') return false;
    void accept(false);
    return true;
  };
  const acceptKey = (): boolean => {
    if (confirm === 'cancel') {
      void cancelVoucher();
      return true;
    }
    if (confirm === 'close') {
      void closeOrder();
      return true;
    }
    if (readOnly) return false;
    void accept();
    return true;
  };

  // ---- rendering ----
  const chord = (id: string) => keymapStore.keymap.chordsFor(id)[0];
  const errorOf = (key: string) => {
    const m = issueAt(key);
    return m ? (
      <span class="field-error" role="alert">
        {m}
      </span>
    ) : null;
  };
  const isFocus = (key: string) => !idle && key === current.key;
  const cls = (b: string, key: string) => `${b}${isFocus(key) ? ' active' : ''}${issueAt(key) ? ' invalid' : ''}`;
  const numberText = voucher ? voucher.number : 'assigned on save';
  const shortName = p.invoice ? `${type?.name ?? cap(p.side)} Voucher` : (type?.name ?? `${cap(p.side)} Order`);
  const title = mode === 'create' ? `New ${shortName}` : `${mode === 'alter' ? 'Alter' : 'Display'} ${type?.name ?? ''} ${voucher?.number ?? ''}`;
  const cancelled = voucher?.status === 'cancelled';
  const fullDay = form.date ? new Date(`${form.date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' }) : '';
  const showFill = p.order && orderState !== undefined;

  const pickerList = (key: string) =>
    isFocus(key) && pickerOn && !pickerDismissed && hits.length > 0 ? (
      <div class="picker" data-testid="picker">
        <ListView
          items={hits}
          index={pickIndex}
          itemKey={(o) => o.id}
          label={pickerKind === 'party' ? p.nounPlural : pickerKind === 'sledger' ? `${p.ledgerLabel}s` : pickerKind === 'item' ? 'Stock items' : pickerKind === 'wh' ? 'Godowns' : pickerKind === 'ref' ? 'Open orders' : 'Open order lines'}
          onActivate={(n) => {
            const o = hits[n];
            if (o) choose(o);
          }}
          renderItem={(o) => (
            <>
              <span class="row-title">{o.name}</span>
              <span class="row-desc">{o.sub}</span>
              {pickerKind === 'item' && <span class="row-meta amt">{stockOf(o.id)}</span>}
            </>
          )}
        />
      </div>
    ) : isFocus(key) && pickerOn && !pickerDismissed && typedLabel.trim() !== '' && typedLabel.trim() !== storedName && pickerKind !== 'ord' && pickerKind !== 'ref' ? (
      <div class="picker picker-empty" data-testid="picker">
        No match — <Kbd chord={chord('master.createInline') ?? 'Alt+C'} /> creates “{typedLabel.trim()}”
        {pickerKind === 'item' && p.invoice && (
          <>
            {' '}
            · <Kbd chord={chord('voucher.oneTimeLine') ?? 'Alt+T'} /> writes it as a one-time line
          </>
        )}
        {pickerKind === 'item' && hiddenItemReason(masters, typedLabel) && <div data-testid="hidden-item">{hiddenItemReason(masters, typedLabel)}</div>}
      </div>
    ) : isFocus(key) && pickerOn && !pickerDismissed && pickerKind === 'ord' ? (
      <div class="picker picker-empty" data-testid="picker">
        {form.partyId === '' ? `Choose the ${p.noun} first.` : `No open order line of this ${p.noun} for this item.`}
      </div>
    ) : null;

  /** A text input that opens a picker below it. */
  const pickerInput = (key: string, label: string, value: string, onText: (v: string) => void, errorKey: string) => (
    <>
      <input
        data-vf={key}
        class={cls('vcell', key)}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={isFocus(key) && !readOnly}
        readOnly={readOnly}
        autocomplete="off"
        spellcheck={false}
        value={value}
        onFocus={() => !isFocus(key) && go(key)}
        onInput={(e) => {
          setPick({ index: 0, touched: true });
          setPickerClosed(undefined);
          onText((e.target as HTMLInputElement).value);
          setFieldErrors((x) => ({ ...x, [errorKey]: '' }));
        }}
      />
      {errorOf(errorKey)}
      {pickerList(key)}
    </>
  );

  const lineRow = (l: SalesLineForm, i: number) => {
    const stock = p.invoice && l.itemId !== '' ? stockOf(l.itemId) : undefined;
    const amount = preview.amounts.get(i);
    const linked = l.orderId !== '' ? books.orders.state(l.orderId as never)?.lines.find((s) => s.line.id === l.orderLineId) : undefined;
    const fillLine = orderState?.lines.find((s) => s.line.id === l.key);
    const openLine = orderState?.status === 'open' && fillLine !== undefined && !fillLine.filled;
    return (
      <div key={`l${i}`} class={`${!idle && current.line === i ? 'vrow sales-row active' : 'vrow sales-row'}${openLine ? ' open-line' : ''}`}>
        <div class="vc-ledger">
          {l.oneTime ? (
            <>
              <input
                data-vf={`l${i}.item`}
                class={cls('vcell one-time', `l${i}.item`)}
                type="text"
                aria-label={`Line ${i + 1} one-time line`}
                readOnly={readOnly}
                autocomplete="off"
                spellcheck={false}
                value={l.itemLabel}
                onFocus={() => !isFocus(`l${i}.item`) && go(`l${i}.item`)}
                onInput={(e) => {
                  setLine(i, { itemLabel: (e.target as HTMLInputElement).value });
                  setFieldErrors((x) => ({ ...x, [`line.${i}.item`]: '' }));
                }}
              />
              {errorOf(`line.${i}.item`)}
              {!isFocus(`l${i}.item`) && (
                <div class="vbal" data-testid="one-time-note">
                  one-time line · no stock{l.hsn ? ` · HSN ${l.hsn}` : ''}{l.unit ? ` · ${l.unit}` : ''} · Alt+T to edit
                </div>
              )}
            </>
          ) : (
            pickerInput(`l${i}.item`, `Line ${i + 1} stock item`, l.itemLabel, (v) => setLine(i, { itemLabel: v }), `line.${i}.item`)
          )}
          {stock && !isFocus(`l${i}.item`) && (
            <div class="vbal" data-testid="stock-note">
              Stock: {stock}
              {heldIn(l.itemId) !== '' ? ` · in ${heldIn(l.itemId)}` : ''}
            </div>
          )}
        </div>
        {p.invoice && l.oneTime ? (
          <>
            <div class="vc-godown vcell-none" aria-hidden="true">—</div>
            <div class="vc-order vcell-none" aria-hidden="true">—</div>
          </>
        ) : p.invoice ? (
          <>
            <div class="vc-godown">{pickerInput(`l${i}.wh`, `Line ${i + 1} godown`, l.warehouseLabel, (v) => setLine(i, { warehouseLabel: v }), `line.${i}.wh`)}</div>
            <div class="vc-order">
              {pickerInput(`l${i}.ord`, `Line ${i + 1} against order`, l.orderLabel, (v) => setLine(i, { orderLabel: v }), `line.${i}.ord`)}
              {linked && !isFocus(`l${i}.ord`) && (
                <div class="vbal" data-testid="order-note">
                  {books.orders.order(l.orderId as never)?.reference ? `${books.orders.order(l.orderId as never)?.reference} · ` : ''}
                  {formatQuantity(linked.pending, 0)} of {formatQuantity(linked.ordered, 0)} pending
                </div>
              )}
            </div>
          </>
        ) : (
          <div class="vc-due">
            <input
              data-vf={`l${i}.ldue`}
              class={cls('vcell', `l${i}.ldue`)}
              type="text"
              aria-label={`Line ${i + 1} due date`}
              readOnly={readOnly}
              autocomplete="off"
              value={l.dueText}
              onFocus={() => !isFocus(`l${i}.ldue`) && go(`l${i}.ldue`)}
              onInput={(e) => {
                setLine(i, { dueText: (e.target as HTMLInputElement).value });
                setFieldErrors((x) => ({ ...x, [`line.${i}.ldue`]: '' }));
              }}
            />
            {errorOf(`line.${i}.ldue`)}
          </div>
        )}
        <div class="vc-qty">
          <input
            data-vf={`l${i}.qty`}
            class={cls('vcell num', `l${i}.qty`)}
            type="text"
            inputMode="decimal"
            aria-label={`Line ${i + 1} quantity`}
            readOnly={readOnly}
            autocomplete="off"
            value={l.qty}
            onFocus={() => !isFocus(`l${i}.qty`) && go(`l${i}.qty`)}
            onInput={(e) => {
              setLine(i, { qty: (e.target as HTMLInputElement).value });
              setFieldErrors((x) => ({ ...x, [`line.${i}.qty`]: '' }));
            }}
          />
          {errorOf(`line.${i}.qty`)}
        </div>
        <div class="vc-rate">
          <input
            data-vf={`l${i}.rate`}
            class={cls('vcell num', `l${i}.rate`)}
            type="text"
            inputMode="decimal"
            aria-label={`Line ${i + 1} rate`}
            readOnly={readOnly}
            autocomplete="off"
            value={l.rate}
            onFocus={() => !isFocus(`l${i}.rate`) && go(`l${i}.rate`)}
            onInput={(e) => {
              setLine(i, { rate: (e.target as HTMLInputElement).value });
              setFieldErrors((x) => ({ ...x, [`line.${i}.rate`]: '' }));
            }}
          />
          {errorOf(`line.${i}.rate`)}
        </div>
        {gstOn && (
          <div class="vc-gst">
            <input
              data-vf={`l${i}.gst`}
              class={cls('vcell num', `l${i}.gst`)}
              type="text"
              inputMode="decimal"
              aria-label={`Line ${i + 1} GST rate`}
              readOnly={readOnly}
              autocomplete="off"
              value={l.gstRate ?? ''}
              onFocus={() => !isFocus(`l${i}.gst`) && go(`l${i}.gst`)}
              onInput={(e) => {
                setLine(i, { gstRate: (e.target as HTMLInputElement).value });
                setFieldErrors((x) => ({ ...x, [`line.${i}.gst`]: '' }));
              }}
            />
            {errorOf(`line.${i}.gst`)}
          </div>
        )}
        <div class="vc-value num amt" data-testid="line-amount">
          {amount === undefined ? '' : formatAmount(amount)}
        </div>
        {showFill && (
          <div class="vc-fill num" data-testid="line-fill" title={fillLine?.filled ? `${cap(p.done)} in full` : `${cap(p.done)} / ordered`}>
            {fillLine ? `${formatQuantity(fillLine.delivered, 0)}/${formatQuantity(fillLine.ordered, 0)}` : ''}
          </div>
        )}
        <div class="vc-x">
          {!readOnly && (
            <button type="button" class="line-x" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} aria-label={`Remove line ${i + 1}`} title="Remove this line (Ctrl+Delete)" onClick={() => removeAt(i)}>
              ×
            </button>
          )}
        </div>
      </div>
    );
  };

  /** A new invoice for what this order still has to deliver. */
  const invoicePending = (): boolean => {
    if (!voucher) return false;
    app.navigate({ type: 'voucher', mode: 'create', typeKey: invoiceKindOf(p.side), fromOrder: voucher.id });
    return true;
  };

  const modeHandlers = (
    <>
      {!readOnly && <Only scope={SCOPE} command="voucher.changeDate" run={changeDate} />}
      {(!readOnly || confirm !== undefined) && <Only scope={SCOPE} command="voucher.accept" run={acceptKey} />}
      {!readOnly && mode === 'create' && <Only scope={SCOPE} command="voucher.acceptAndNew" run={acceptAndNew} />}
      {pickerOn && pickerKind !== 'ord' && pickerKind !== 'ref' && <Only scope={SCOPE} command="master.createInline" run={createInline} />}
      {!readOnly && <Only scope={SCOPE} command="voucher.partyDetails" run={openPartyDetails} />}
      {!readOnly && p.invoice && <Only scope={SCOPE} command="voucher.againstOrder" run={againstOrder} />}
      {!readOnly && p.invoice && current.kind === 'item' && oneTimeFor === undefined && <Only scope={SCOPE} command="voucher.oneTimeLine" run={openOneTime} />}
      {oneTimeFor !== undefined && (
        <FieldsDialog
          title={`Line ${oneTimeFor + 1}: one-time line (not a stock item)`}
          enterOnly
          fields={[
            { key: 'description', label: 'Description', value: form.lines[oneTimeFor]?.itemLabel ?? '', hint: 'what is sold or bought — leave empty to make it a stock item line again' },
            { key: 'hsn', label: 'HSN / SAC', value: form.lines[oneTimeFor]?.hsn ?? '', hint: '4 to 8 digits' },
            { key: 'qty', label: 'Qty', value: form.lines[oneTimeFor]?.qty || '1' },
            { key: 'unit', label: 'Unit', value: form.lines[oneTimeFor]?.unit ?? '', hint: unitNames.join(', ') },
          ]}
          validate={(v) => {
            const out: Record<string, string> = {};
            if ((v['description'] ?? '').trim() === '') return out;
            const hsn = (v['hsn'] ?? '').trim();
            if (hsn !== '' && !/^\d{4,8}$/.test(hsn)) out['hsn'] = 'An HSN / SAC code is 4 to 8 digits';
            const q = (v['qty'] ?? '').trim();
            if (!isQtyText(q) || (parseQty(q) ?? 0n) <= 0n) out['qty'] = 'Enter a quantity above zero (like 1 or 2.5)';
            if ((v['unit'] ?? '').trim() !== '' && !unitOf(v['unit'] ?? '')) out['unit'] = `Not one of your units: ${unitNames.join(', ')}`;
            return out;
          }}
          onDone={(v) => applyOneTime(oneTimeFor, v)}
        />
      )}
      {!readOnly && current.line !== undefined && form.lines.length > 1 && <Only scope={SCOPE} command="voucher.removeLine" run={removeLine} />}
      {voucher && (
        <Only
          scope={SCOPE}
          command="voucher.print"
          run={() => {
            const doc = buildPrintDoc();
            if (doc) print.printVoucher(doc);
            return true;
          }}
        />
      )}
      {mode === 'display' && voucher?.status === 'posted' && (
        <Only scope={SCOPE} command="master.alter" run={() => (app.navigate({ type: 'voucher', mode: 'alter', id: voucher.id }), true)} />
      )}
      {mode !== 'create' && voucher?.status === 'posted' && <Only scope={SCOPE} command="voucher.cancel" run={() => (setConfirm('cancel'), true)} />}
      {mode !== 'create' && voucher?.status === 'posted' && p.order && !form.closed && (
        <Only scope={SCOPE} command="order.close" run={() => (setConfirm('close'), true)} />
      )}
      {mode !== 'create' && voucher?.status === 'posted' && p.order && orderState?.status === 'open' && <Only scope={SCOPE} command="order.invoice" run={invoicePending} />}
    </>
  );

  const gridClass = `${p.invoice ? 'sales-invoice' : 'sales-order'}${showFill ? ' with-fill' : ''}${gstOn ? ' with-gst' : ''}`;
  const details = form.partyDetails;
  const summary = [
    details?.mailingName,
    details?.billTo?.lines,
    details?.gstin,
    details?.placeOfSupply ? `place of supply ${details.placeOfSupply}` : undefined,
    details?.shipTo?.lines ? `ship to ${details.shipTo.lines}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section class="screen voucher-screen" aria-labelledby="voucher-title" data-testid="voucher-form" ref={rootRef as never}>
      <h1 id="voucher-title" class="vtitle">
        {title}
        {cancelled && <span class="badge">Cancelled</span>}
        {orderState && !cancelled && (
          <span class={orderState.status === 'open' ? 'badge open' : 'badge'} data-testid="order-status">
            {orderState.status === 'open' ? 'Open' : orderState.reason === 'fulfilled' ? `Closed · ${p.done} in full` : 'Closed'}
          </span>
        )}
      </h1>
      <WindowClose />

      {banner && (
        <p class={banner.tone === 'error' ? 'notice error' : banner.tone === 'note' ? 'notice capture' : 'notice'} role={banner.tone === 'error' ? 'alert' : 'status'} data-testid="voucher-banner">
          {banner.text}
        </p>
      )}
      {general.length > 0 && (
        <p class="notice error" role="alert">
          {general.join(' ')}
        </p>
      )}
      {confirm === 'cancel' && (
        <p class="notice error" role="alert" data-testid="cancel-confirm">
          Cancel voucher {voucher?.number}? It keeps its number but leaves the books. Press <Kbd chord={chord('voucher.accept') ?? 'Ctrl+A'} /> to confirm, <Kbd chord={chord('app.back') ?? 'Esc'} /> to keep it.
        </p>
      )}
      {confirm === 'close' && (
        <p class="notice error" role="alert" data-testid="close-confirm">
          Close order {voucher?.number}? Nothing more can be {p.done} against it; what was {p.done} stays. Press <Kbd chord={chord('voucher.accept') ?? 'Ctrl+A'} /> to confirm, <Kbd chord={chord('app.back') ?? 'Esc'} /> to leave it open.
        </p>
      )}

      <div class="vhead">
        <span class="vtag" data-testid="voucher-type-tag">{type?.name}</span>
        <span class="vno">
          No. <strong data-testid="voucher-number">{numberText}</strong>
        </span>
        <span class="vspacer" />
        <span class="vday" data-testid="voucher-weekday">{fullDay}</span>
        <input
          data-vf="date"
          class={cls('vdate', 'date')}
          type="text"
          aria-label="Voucher date"
          readOnly={readOnly}
          autocomplete="off"
          value={dateText}
          onFocus={() => !isFocus('date') && go('date')}
          onInput={(e) => {
            setDateText((e.target as HTMLInputElement).value);
            setFieldErrors((x) => ({ ...x, date: '' }));
          }}
        />
        {errorOf('date')}
      </div>

      <div class="vsale">
        <label class="vlabel" for="v-party">
          Party
        </label>
        <div class={isFocus('party') ? 'vfield active' : 'vfield'}>
          {pickerInput('party', cap(p.noun), form.partyLabel, (v) => update((f) => ({ ...f, partyLabel: v })), 'party')}
        </div>
        <label class="vlabel" for="v-ref">
          {p.refLabel}
        </label>
        <div class={isFocus('ref') ? 'vfield active' : 'vfield'}>
          {refOptions.length > 0 && !readOnly ? (
            pickerInput('ref', p.refAria, form.reference, (v) => update((f) => ({ ...f, reference: v })), 'ref')
          ) : (
          <input
            id="v-ref"
            data-vf="ref"
            class={cls('vcell', 'ref')}
            type="text"
            aria-label={p.refAria}
            readOnly={readOnly}
            autocomplete="off"
            value={form.reference}
            onFocus={() => !isFocus('ref') && go('ref')}
            onInput={(e) => update((f) => ({ ...f, reference: (e.target as HTMLInputElement).value }))}
          />
          )}
          {refOptions.length === 0 || readOnly ? errorOf('ref') : null}
        </div>
        {p.side === 'sales' && p.invoice && (
          <>
            <label class="vlabel" for="v-eway">
              E-way Bill No.
            </label>
            <div class={isFocus('eway') ? 'vfield active' : 'vfield'}>
              <input
                id="v-eway"
                data-vf="eway"
                class={cls('vcell', 'eway')}
                type="text"
                aria-label="E-way Bill number"
                readOnly={readOnly}
                autocomplete="off"
                value={form.ewayBillNo}
                onFocus={() => !isFocus('eway') && go('eway')}
                onInput={(e) => update((f) => ({ ...f, ewayBillNo: (e.target as HTMLInputElement).value }))}
              />
            </div>
          </>
        )}
        {p.invoice && (
          <>
            <label class="vlabel" for="v-sledger">
              {p.ledgerLabel}
            </label>
            <div class={isFocus('sledger') ? 'vfield active' : 'vfield'}>
              {pickerInput('sledger', p.ledgerLabel, form.salesLedgerLabel, (v) => update((f) => ({ ...f, salesLedgerLabel: v })), 'sledger')}
            </div>
            {p.side === 'purchase' && (
              <>
                <label class="vlabel" for="v-billno">
                  Supplier inv no.
                </label>
                <div class={isFocus('billno') ? 'vfield active' : 'vfield'}>
                  <input
                    id="v-billno"
                    data-vf="billno"
                    class={cls('vcell', 'billno')}
                    type="text"
                    aria-label="Supplier invoice number"
                    readOnly={readOnly}
                    autocomplete="off"
                    value={form.billNo}
                    onFocus={() => !isFocus('billno') && go('billno')}
                    onInput={(e) => {
                      update((f) => ({ ...f, billNo: (e.target as HTMLInputElement).value }));
                      setFieldErrors((x) => ({ ...x, billno: '' }));
                    }}
                  />
                  {errorOf('billno')}
                </div>
              </>
            )}
            <label class="vlabel" for="v-due">
              {p.billDue}
            </label>
            <div class={isFocus('due') ? 'vfield active' : 'vfield'}>
              <input
                id="v-due"
                data-vf="due"
                class={cls('vcell', 'due')}
                type="text"
                aria-label="Bill due date"
                readOnly={readOnly}
                autocomplete="off"
                value={form.dueText}
                onFocus={() => !isFocus('due') && go('due')}
                onInput={(e) => {
                  update((f) => ({ ...f, dueText: (e.target as HTMLInputElement).value }));
                  setFieldErrors((x) => ({ ...x, due: '' }));
                }}
              />
              {errorOf('due')}
            </div>
          </>
        )}
      </div>

      <div class="vgrid" role="group" aria-label="Entries">
        <div class={`vhdr sales-row ${gridClass}`}>
          <span class="vc-ledger">Particulars</span>
          {p.invoice ? (
            <>
              <span class="vc-godown">{p.side === 'purchase' ? 'Receive into' : 'Godown'}</span>
              <span class="vc-order">Against order</span>
            </>
          ) : (
            <span class="vc-due">Due date</span>
          )}
          <span class="vc-qty num">Qty</span>
          <span class="vc-rate num">Rate</span>
          {gstOn && <span class="vc-gst num">GST %</span>}
          <span class="vc-value num">Amount</span>
          {showFill && <span class="vc-fill num">Filled</span>}
          <span class="vc-x" />
        </div>
        <div class={`vbody sales ${gridClass}`}>{form.lines.map((l, i) => lineRow(l, i))}</div>
        <div class={`vtot sales-row ${gridClass}`}>
          <span class="vc-ledger total-label">Total</span>
          {p.invoice ? (
            <>
              <span class="vc-godown" />
              <span class="vc-order" />
            </>
          ) : (
            <span class="vc-due" />
          )}
          <span class="vc-qty" />
          <span class="vc-rate" />
          {gstOn && <span class="vc-gst" />}
          <span class="vc-value num amt" data-testid="total-amount">
            {formatAmount(preview.total)}
          </span>
          {showFill && <span class="vc-fill" />}
          <span class="vc-x" />
        </div>
      </div>

      {gstOn && (
        <p class="gst-summary" data-testid="gst-summary">
          Taxable <strong data-testid="gst-taxable">{formatAmount(preview.total)}</strong>
          {preview.gst ? (
            <>
              {' · '}
              {preview.gst.cgst > 0n || preview.gst.sgst > 0n ? (
                <>
                  CGST <strong data-testid="gst-cgst">{formatAmount(preview.gst.cgst)}</strong> · SGST <strong data-testid="gst-sgst">{formatAmount(preview.gst.sgst)}</strong>
                </>
              ) : (
                <>
                  IGST <strong data-testid="gst-igst">{formatAmount(preview.gst.igst)}</strong>
                </>
              )}
              {' · '}place of supply {preview.gst.placeOfSupply}
            </>
          ) : (
            <> · no GST on this invoice</>
          )}
          {' · '}Invoice total <strong data-testid="invoice-total">{formatAmount(preview.grand)}</strong>
        </p>
      )}

      <div class={isFocus('narration') ? 'vnarr active' : 'vnarr'}>
        <label class="vlabel" for="v-narration">
          Narration:
        </label>
        <input
          id="v-narration"
          data-vf="narration"
          class={cls('vcell', 'narration')}
          type="text"
          readOnly={readOnly}
          autocomplete="off"
          value={form.narration}
          onFocus={() => !isFocus('narration') && go('narration')}
          onInput={(e) => update((f) => ({ ...f, narration: (e.target as HTMLInputElement).value }))}
        />
      </div>

      {summary !== '' && (
        <p class="vparty" data-testid="party-summary">
          Party details: {summary}
        </p>
      )}

      {modeHandlers}
      {leave.dialog}
      {partyOpen && (
        <PartyDetailsDialog
          books={books}
          ledgerIds={form.partyId === '' ? [] : [partyLedgerId(form.partyId, p.role)]}
          value={form.partyDetails}
          onDone={(result) => {
            setPartyOpen(false);
            if (result !== 'cancel') update((f) => ({ ...f, partyDetails: { ...result, partyId: f.partyId } }));
          }}
        />
      )}
    </section>
  );
}

/** The main godown: the first active one, which a new invoice line starts in. */
function defaultGodown(books: Books): { id: string; label: string } | undefined {
  const w = books.masters.warehouses.find((x) => x.isActive);
  return w ? { id: w.id, label: w.name } : undefined;
}

/** A quantity as the item's unit shows it: "12 Nos", "2.500 Kg". */
function qtyText(masters: Books['masters'], itemId: string, q: bigint): string {
  const item = masters.stockItem(itemId as never);
  const unit = item ? masters.unit(item.unitId) : undefined;
  return `${formatQuantity(q as never, unit?.decimals ?? 0)}${unit ? ` ${unit.symbol}` : ''}`;
}
