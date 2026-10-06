import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { formatAmount, formatDate, formatQuantity } from '../vouchers/format';
import { docProfile } from '../vouchers/kinds';
import { type SalesForm, type SalesLineForm, customerOptions, itemOptions, previewSales, salesLedgerOptions } from '../vouchers/salesModel';
import { CreateScreen } from './CreateScreen';
import type { CreateWhat } from './create';
import { entryTitle, headIssues, isBlankEntry, lineFor, lineIssues, startForm, stepQty, withDate, withParty } from './entry';
import type { EntryKind, MobileNav } from './nav';
import { Empty, Frame, Group, Row, Search, matches, rupees } from './ui';

/**
 * Entering a Sales Invoice, Sales Order, Quotation or Delivery Challan by touch — ONE page, the document itself: the customer, its lines,
 * the total and Save under the thumb. A tap on the customer or "Add item" opens a full-screen list that filters as you type; a tap on an
 * item adds its line (one of it, at its last rate, from the godown that holds it) and opens it for the quantity. The form, its draft, the
 * figures and every refusal are the desktop's (`previewSales`): this page only fills the form in.
 */

interface Props {
  readonly books: Books;
  readonly nav: MobileNav;
  readonly kind: EntryKind;
  readonly voucherId?: string | undefined;
  readonly partyId?: string | undefined;
  readonly fromOrder?: string | undefined;
  readonly fromOrderLines?: readonly string[] | undefined;
}

const LIST = 80;

export function Entry({ books, nav, kind, voucherId, partyId, fromOrder, fromOrderLines }: Props) {
  const masters = books.masters;
  const p = docProfile(kind);
  const altering = voucherId !== undefined;
  /** A plain new document keeps a draft on this device (a call comes in, the app is closed: it is still there); one started from something is that thing's. */
  const drafts = !altering && !partyId && !fromOrder;
  const draftKey = `mobile:${kind}`;

  const initial = useRef<SalesForm | undefined>(undefined);
  if (initial.current === undefined) initial.current = startForm(books, { kind, voucherId, partyId, fromOrder, fromOrderLines });
  const [form, setForm] = useState<SalesForm | undefined>(initial.current);
  const [picker, setPicker] = useState<'party' | 'item' | undefined>(undefined);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  /** A customer or item being made because the list did not have it: it opens in the list's place, and what it makes is chosen. */
  const [creating, setCreating] = useState<{ readonly what: CreateWhat; readonly name: string } | undefined>(undefined);
  const [more, setMore] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState('');
  const [restored, setRestored] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // a draft left here earlier comes back, once
  useEffect(() => {
    if (!drafts) return;
    let live = true;
    void books.loadDraft(draftKey).then((d) => {
      const draft = d as SalesForm | undefined;
      if (!live || !draft || draft.typeId !== initial.current?.typeId || !Array.isArray(draft.lines) || isBlankEntry(draft)) return;
      setForm(draft);
      setRestored(true);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!drafts || !form) return;
    void (isBlankEntry(form) ? books.clearDraft(draftKey) : books.saveDraft(draftKey, form));
  }, [form]);

  // what is not kept as a draft asks before Back throws it away
  const changed = !drafts && form !== undefined && JSON.stringify(form) !== JSON.stringify(initial.current);
  useEffect(() => {
    nav.setGuard(changed && !busy ? () => (setLeaving(true), false) : undefined);
    return () => nav.setGuard(undefined);
  }, [changed, busy]);

  const preview = useMemo(() => (form ? previewSales(form, kind, masters, books.stock, books.orders, undefined, books.vouchers) : undefined), [form, kind, masters, books.stock, books.orders, books.vouchers]);

  if (!form || !preview) {
    return (
      <Frame nav={nav} title={entryTitle(kind)}>
        <Empty>{altering ? 'This document cannot be changed here. Open it in the desktop version.' : `This company has no ${entryTitle(kind)} voucher type.`}</Empty>
      </Frame>
    );
  }

  const gstOn = masters.company.chargeGst === true && (p.invoice || p.quote || p.challan);
  // the engine's own refusals (not enough stock, more than is pending) are said at once; "enter the rate" waits until Save is tapped
  const issues = tried ? preview.issues : preview.issues.filter((i) => i.code !== undefined);
  const head = headIssues(issues);
  const update = (fn: (f: SalesForm) => SalesForm) => {
    setRefused('');
    setForm((f) => (f ? fn(f) : f));
  };
  const setLine = (key: string, patch: Partial<SalesLineForm>) => update((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));

  // ---- layers: a list or a sheet over the page; Back closes it ----
  const openPicker = (which: 'party' | 'item') => {
    setPicker(which);
    nav.openLayer(() => setPicker(undefined));
  };
  const openLine = (key: string) => {
    setEditing(key);
    nav.openLayer(() => setEditing(undefined));
  };
  const chooseParty = (id: string) => {
    update((f) => withParty(f, kind, books, id));
    nav.closeLayer();
  };
  /** An item tapped: its line is added and opened for the quantity — in the place of the list, so one Back returns to the document. */
  const chooseItem = (id: string) => {
    const line = lineFor(books, kind, form, id);
    update((f) => ({ ...f, lines: [...f.lines, line] }));
    setPicker(undefined);
    setEditing(line.key);
    nav.swapLayer(() => setEditing(undefined));
  };
  /** "+ Create" in a list: the new record's form takes the list's place (one Back still returns to the document). */
  const startCreating = (what: CreateWhat, name: string) => {
    setPicker(undefined);
    setCreating({ what, name });
    nav.swapLayer(() => setCreating(undefined));
  };
  /** Saved: a customer is chosen and the form closes; an item becomes a line, opened for its quantity. */
  const created = (what: CreateWhat, id: string) => {
    if (what === 'customer') {
      update((f) => withParty(f, kind, books, id));
      return nav.closeLayer();
    }
    const line = lineFor(books, kind, form, id);
    update((f) => ({ ...f, lines: [...f.lines, line] }));
    setCreating(undefined);
    setEditing(line.key);
    nav.swapLayer(() => setEditing(undefined));
  };
  /** The × at a line's end takes it off the document at once; "Remove" in its sheet does the same and closes the sheet. */
  const dropLine = (key: string) => update((f) => ({ ...f, lines: f.lines.filter((l) => l.key !== key) }));
  const removeLine = (key: string) => {
    dropLine(key);
    nav.closeLayer();
  };

  const save = () => {
    if (busy) return;
    if (!preview.ok) {
      setTried(true);
      setRefused(preview.issues[0]?.message ?? 'Something is missing');
      return;
    }
    setBusy(true);
    const voucher = altering ? books.voucher(voucherId) : undefined;
    void (voucher ? books.alter(voucher.id, voucher.version, preview.draft) : books.post(preview.draft)).then(
      (r) => {
        setBusy(false);
        if (!r.ok) return setRefused(r.issues[0]?.message ?? 'It could not be saved');
        if (drafts) void books.clearDraft(draftKey);
        nav.replace({ page: 'doc', voucherId: r.value.voucher.id });
      },
      (error: unknown) => {
        setBusy(false);
        setRefused(`It could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  };

  const editingLine = editing ? form.lines.find((l) => l.key === editing) : undefined;
  const unitOf = (itemId: string) => {
    const item = masters.stockItem(itemId as never);
    return item ? masters.unit(item.unitId) : undefined;
  };
  const ledgers = salesLedgerOptions(masters, 'sales');
  const title = altering ? `${entryTitle(kind)} ${books.voucher(voucherId)?.number ?? ''}` : `New ${entryTitle(kind)}`;

  return (
    <>
      <Frame
        nav={nav}
        title={title}
        foot={
          <>
            <span class="m-total">
              <span class="m-total-label">{gstOn && preview.gst ? 'Total with GST' : 'Total'}</span>
              <strong data-testid="entry-total">{rupees(preview.grand)}</strong>
            </span>
            <button type="button" class="m-button m-primary" data-testid="entry-save" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : altering ? 'Save changes' : 'Save'}
            </button>
          </>
        }
      >
        {restored && (
          <p class="m-note m-strip" data-testid="entry-restored">
            Carried on from where you left it.{' '}
            <button
              type="button"
              class="m-link"
              onClick={() => {
                const fresh = startForm(books, { kind });
                if (fresh) setForm(fresh);
                setRestored(false);
                setTried(false);
              }}
            >
              Start again
            </button>
          </p>
        )}
        {refused ? (
          <p class="m-note bad m-strip" role="alert" data-testid="entry-refused">
            {refused}
          </p>
        ) : null}

        <Group title="Customer">
          <Row
            title={form.partyLabel || 'Choose the customer'}
            sub={form.partyId ? [form.partyDetails?.gstin, form.partyDetails?.billTo?.lines].filter(Boolean).join(' · ') || undefined : undefined}
            note={form.partyId ? 'Change' : undefined}
            tone="muted"
            problem={head.find((i) => i.field === 'party')?.message}
            onOpen={() => openPicker('party')}
            testId="entry-party"
          />
        </Group>

        <Group title="Items">
          {form.lines.map((l, i) => {
            const amount = preview.amounts.get(i);
            const unit = unitOf(l.itemId);
            return (
              <div key={l.key} class="m-line">
              <Row
                title={l.itemLabel}
                sub={[`${l.qty || '?'} ${unit?.symbol ?? l.unit ?? ''} × ${l.rate || '?'}`.replace('  ', ' '), gstOn && l.gstRate ? `GST ${l.gstRate}%` : undefined, l.orderLabel || undefined, p.order && l.due ? `due ${formatDate(l.due)}` : undefined].filter(Boolean).join(' · ')}
                value={amount === undefined ? undefined : formatAmount(amount)}
                problem={lineIssues(issues, i)[0]?.message}
                onOpen={() => openLine(l.key)}
                testId="entry-line"
              />
                <button type="button" class="m-line-x" aria-label={`Remove ${l.itemLabel}`} data-testid="entry-line-x" onClick={() => dropLine(l.key)}>
                  ×
                </button>
              </div>
            );
          })}
          <button type="button" class="m-row m-add" data-testid="entry-add" onClick={() => openPicker('item')}>
            + Add item
          </button>
          {head.find((i) => i.field === 'general') ? <p class="m-note bad">{head.find((i) => i.field === 'general')?.message}</p> : null}
        </Group>

        {gstOn && preview.gst ? (
          <Group title="Tax">
            <Row title="Taxable value" value={formatAmount(preview.total)} />
            {preview.gst.igst > 0n ? <Row title="IGST" value={formatAmount(preview.gst.igst)} /> : null}
            {preview.gst.cgst > 0n ? <Row title="CGST" value={formatAmount(preview.gst.cgst)} /> : null}
            {preview.gst.sgst > 0n ? <Row title="SGST" value={formatAmount(preview.gst.sgst)} /> : null}
          </Group>
        ) : null}

        <Group title="Details">
          <label class="m-field">
            <span class="m-field-label">Date</span>
            <input type="date" class="m-input" aria-label="Date" value={form.date} onChange={(e) => (e.target as HTMLInputElement).value && update((f) => withDate(f, kind, books, (e.target as HTMLInputElement).value))} />
          </label>
          {head.find((i) => i.field === 'date') ? <p class="m-note bad">{head.find((i) => i.field === 'date')?.message}</p> : null}
          <label class="m-field">
            <span class="m-field-label">{p.refLabel}</span>
            <input type="text" class="m-input" aria-label={p.refAria} value={form.reference} autocomplete="off" onInput={(e) => update((f) => ({ ...f, reference: (e.target as HTMLInputElement).value }))} />
          </label>
          {p.challan ? (
            <div class="m-field">
              <span class="m-field-label">Purpose</span>
              <span class="m-seg" role="group" aria-label="Purpose of the challan">
                {(['sale', 'foc'] as const).map((v) => (
                  <button key={v} type="button" class={(form.purpose ?? 'sale') === v ? 'm-seg-on' : ''} aria-pressed={(form.purpose ?? 'sale') === v} onClick={() => update((f) => ({ ...f, purpose: v }))}>
                    {v === 'sale' ? 'Invoice later' : 'Free of cost'}
                  </button>
                ))}
              </span>
            </div>
          ) : null}
          {more ? (
            <>
              {p.invoice ? (
                <label class="m-field">
                  <span class="m-field-label">Bill due</span>
                  <input type="date" class="m-input" aria-label="Bill due date" value={form.due} min={form.date} onChange={(e) => (e.target as HTMLInputElement).value && update((f) => ({ ...f, due: (e.target as HTMLInputElement).value, dueText: formatDate((e.target as HTMLInputElement).value), dueTouched: true }))} />
                </label>
              ) : null}
              {p.invoice && (ledgers.length > 1 || form.salesLedgerId === '') ? (
                <label class="m-field">
                  <span class="m-field-label">Sales ledger</span>
                  <select class="m-input" aria-label="Sales ledger" value={form.salesLedgerId} onChange={(e) => update((f) => ({ ...f, salesLedgerId: (e.target as HTMLSelectElement).value, salesLedgerLabel: ledgers.find((o) => o.id === (e.target as HTMLSelectElement).value)?.name ?? '' }))}>
                    <option value="">Choose…</option>
                    {ledgers.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label class="m-field m-field-tall">
                <span class="m-field-label">Narration</span>
                <textarea class="m-input" aria-label="Narration" rows={2} value={form.narration} onInput={(e) => update((f) => ({ ...f, narration: (e.target as HTMLTextAreaElement).value }))} />
              </label>
            </>
          ) : (
            <button type="button" class="m-row m-add" data-testid="entry-more" onClick={() => setMore(true)}>
              More: {p.invoice ? 'due date, ' : ''}narration
            </button>
          )}
          {head
            .filter((i) => i.field !== 'party' && i.field !== 'general' && i.field !== 'date')
            .map((i) => (
              <p key={i.field} class="m-note bad">
                {i.message}
              </p>
            ))}
        </Group>
      </Frame>

      {picker === 'party' ? <Picker title="Customer" label="Search customers" options={customerOptions(masters, 'sales')} onChoose={chooseParty} onClose={() => nav.closeLayer()} empty="No such customer." createLabel="customer" onCreate={(typed) => startCreating('customer', typed)} /> : null}
      {picker === 'item' ? (
        <Picker
          title="Add item"
          label="Search items"
          options={itemOptions(masters, p.invoice || p.order || p.challan).map((o) => ({ ...o, value: stockOf(books, o.id, form.date) }))}
          onChoose={chooseItem}
          onClose={() => nav.closeLayer()}
          empty="No such item."
          createLabel="item"
          onCreate={(typed) => startCreating('item', typed)}
        />
      ) : null}
      {creating ? <CreateScreen books={books} what={creating.what} name={creating.name} onSaved={(id) => created(creating.what, id)} onClose={() => nav.closeLayer()} /> : null}
      {editingLine ? (
        <LineSheet
          line={editingLine}
          unit={unitOf(editingLine.itemId)?.symbol ?? editingLine.unit ?? ''}
          gstOn={gstOn}
          order={p.order}
          godowns={p.moves && !editingLine.challanId && masters.stockItem(editingLine.itemId as never)?.itemType !== 'service' ? masters.warehouses.filter((w) => w.isActive).map((w) => ({ id: w.id, name: w.name, held: formatQuantity(books.stock.qtyAt(editingLine.itemId as never, w.id, form.date as never), unitOf(editingLine.itemId)?.decimals ?? 0) })) : []}
          problems={lineIssues(issues, form.lines.indexOf(editingLine)).map((i) => i.message)}
          amount={preview.amounts.get(form.lines.indexOf(editingLine))}
          onChange={(patch) => setLine(editingLine.key, patch)}
          onRemove={() => removeLine(editingLine.key)}
          onDone={() => nav.closeLayer()}
        />
      ) : null}
      {leaving ? (
        <div class="m-sheet-back">
          <div class="m-sheet" role="alertdialog" aria-label="Discard changes?">
            <p class="m-sheet-title">Discard what you entered?</p>
            <div class="m-actions">
              <button type="button" class="m-button" onClick={() => setLeaving(false)}>
                Keep editing
              </button>
              <button
                type="button"
                class="m-button m-danger"
                data-testid="entry-discard"
                onClick={() => {
                  nav.setGuard(undefined);
                  nav.back();
                }}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** What the book holds of an item on the document's date: "120 Nos" (nothing for a service). */
function stockOf(books: Books, itemId: string, date: string): string | undefined {
  const item = books.masters.stockItem(itemId as never);
  if (!item || item.itemType === 'service') return undefined;
  const unit = books.masters.unit(item.unitId);
  return `${formatQuantity(books.stock.positionAt(item.id, date as never).qty, unit?.decimals ?? 0)} ${unit?.symbol ?? ''}`.trim();
}

/** A full-screen list that filters as you type: the way a customer or an item is chosen with a thumb. */
function Picker({
  title,
  label,
  options,
  onChoose,
  onClose,
  empty,
  createLabel,
  onCreate,
}: {
  title: string;
  label: string;
  options: readonly { id: string; name: string; sub: string; value?: string | undefined }[];
  onChoose: (id: string) => void;
  onClose: () => void;
  empty: string;
  /** What "+ Create" makes ("customer", "item"), with what was typed as its name. */
  createLabel: string;
  onCreate: (typed: string) => void;
}) {
  const [text, setText] = useState('');
  const hits = options.filter((o) => matches(text, o.name, o.sub));
  return (
    <div class="m-layer" role="dialog" aria-label={title} data-testid="picker">
      <header class="m-bar">
        <button type="button" class="m-back" aria-label="Close" onClick={onClose}>
          ‹
        </button>
        <h1 class="m-title">{title}</h1>
      </header>
      <div class="m-main">
        <Search value={text} onInput={setText} label={label} autoFocus />
        {hits.length === 0 ? <Empty>{options.length === 0 || text.trim() !== '' ? empty : 'Nothing to choose from.'}</Empty> : hits.slice(0, LIST).map((o) => <Row key={o.id} title={o.name} sub={o.sub || undefined} value={o.value} tone="muted" onOpen={() => onChoose(o.id)} testId="pick-row" />)}
        {hits.length > LIST ? <Empty>Type to narrow down ({hits.length - LIST} more).</Empty> : null}
        <button type="button" class="m-row m-add" data-testid="pick-create" onClick={() => onCreate(text.trim())}>
          {text.trim() !== '' ? `+ Create “${text.trim()}”` : `+ New ${createLabel}`}
        </button>
      </div>
    </div>
  );
}

/** One line, opened from the bottom of the screen: how many, at what rate — and, where they apply, GST, the godown and the due date. */
function LineSheet({
  line,
  unit,
  gstOn,
  order,
  godowns,
  problems,
  amount,
  onChange,
  onRemove,
  onDone,
}: {
  line: SalesLineForm;
  unit: string;
  gstOn: boolean;
  order: boolean;
  godowns: readonly { id: string; name: string; held: string }[];
  problems: readonly string[];
  amount: bigint | undefined;
  onChange: (patch: Partial<SalesLineForm>) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const number = (label: string, value: string, set: (v: string) => void, testId: string) => (
    <input type="text" inputMode="decimal" class="m-input m-num" aria-label={label} data-testid={testId} value={value} autocomplete="off" onFocus={(e) => (e.target as HTMLInputElement).select()} onInput={(e) => set((e.target as HTMLInputElement).value)} />
  );
  return (
    <div class="m-sheet-back" onClick={(e) => e.target === e.currentTarget && onDone()}>
      <div class="m-sheet" role="dialog" aria-label={line.itemLabel} data-testid="line-sheet">
        <p class="m-sheet-title">{line.itemLabel}</p>
        <div class="m-field">
          <span class="m-field-label">Quantity{unit ? ` (${unit})` : ''}</span>
          <span class="m-stepper">
            <button type="button" aria-label="One fewer" data-testid="qty-less" onClick={() => onChange({ qty: stepQty(line.qty, -1) })}>
              −
            </button>
            {number('Quantity', line.qty, (v) => onChange({ qty: v }), 'line-qty')}
            <button type="button" aria-label="One more" data-testid="qty-more" onClick={() => onChange({ qty: stepQty(line.qty, 1) })}>
              +
            </button>
          </span>
        </div>
        <label class="m-field">
          <span class="m-field-label">Rate</span>
          {number('Rate', line.rate, (v) => onChange({ rate: v }), 'line-rate')}
        </label>
        {gstOn ? (
          <label class="m-field">
            <span class="m-field-label">GST %</span>
            {number('GST rate', line.gstRate ?? '', (v) => onChange({ gstRate: v }), 'line-gst')}
          </label>
        ) : null}
        {godowns.length > 1 ? (
          <label class="m-field">
            <span class="m-field-label">Godown</span>
            <select class="m-input" aria-label="Godown" value={line.warehouseId} onChange={(e) => onChange({ warehouseId: (e.target as HTMLSelectElement).value, warehouseLabel: godowns.find((g) => g.id === (e.target as HTMLSelectElement).value)?.name ?? '' })}>
              {line.warehouseId === '' ? <option value="">Choose…</option> : null}
              {godowns.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.held})
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {order ? (
          <label class="m-field">
            <span class="m-field-label">Due</span>
            <input type="date" class="m-input" aria-label="Line due date" value={line.due} onChange={(e) => (e.target as HTMLInputElement).value && onChange({ due: (e.target as HTMLInputElement).value, dueText: formatDate((e.target as HTMLInputElement).value) })} />
          </label>
        ) : null}
        {problems.map((m) => (
          <p key={m} class="m-note bad" data-testid="line-problem">
            {m}
          </p>
        ))}
        <div class="m-actions">
          <button type="button" class="m-button m-danger" data-testid="line-remove" onClick={onRemove}>
            Remove
          </button>
          <button type="button" class="m-button m-primary" data-testid="line-done" onClick={onDone}>
            Done{amount !== undefined ? ` · ${formatAmount(amount)}` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
