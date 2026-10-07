import { formatRate, rateOf } from '@minimalerp/domain';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { defaultDate, resolveTypeId } from '../vouchers/entryHelpers';
import { formatAmount, formatQuantity } from '../vouchers/format';
import { itemOptions } from '../vouchers/salesModel';
import { type StockForm, type StockLineForm, blankStockForm, blankStockLine, defaultWarehouse, previewStock, trimPlaces } from '../vouchers/stockModel';
import { Picker, stockOf } from './EntryScreen';
import { stepQty } from './entry';
import type { MobileNav } from './nav';
import { Empty, Frame, Group, Row } from './ui';

/**
 * A Stock Journal by touch: stock leaving a godown (Out) and stock arriving in one (In), with no accounting effect — a transfer, a
 * conversion, an adjustment. The form is the desktop's (`StockForm`); `previewStock` judges it with the engine and `books.post` sends it.
 * "+ Out" / "+ In" open the item list; the item tapped becomes a line, opened for its quantity (and, coming in, its rate).
 */
export function StockJournalScreen({ books, nav }: { books: Books; nav: MobileNav }) {
  const masters = books.masters;
  const typeId = resolveTypeId(masters, 'stockJournal');
  const initial = useRef<StockForm | undefined>(undefined);
  if (initial.current === undefined && typeId) initial.current = { ...blankStockForm(crypto.randomUUID(), typeId, defaultDate(masters), defaultWarehouse(masters)), lines: [] };
  const [form, setForm] = useState<StockForm | undefined>(initial.current);
  const [adding, setAdding] = useState<'in' | 'out' | undefined>(undefined);
  const [editing, setEditing] = useState<number | undefined>(undefined);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState('');
  const [leaving, setLeaving] = useState(false);

  const changed = form !== undefined && form.lines.length > 0;
  useEffect(() => {
    nav.setGuard(changed && !busy ? () => (setLeaving(true), false) : undefined);
    return () => nav.setGuard(undefined);
  }, [changed, busy]);

  const preview = useMemo(() => (form ? previewStock(form, masters, books.stock) : undefined), [form, masters, books.stock]);
  if (!form || !preview) {
    return (
      <Frame nav={nav} title="Stock Journal">
        <Empty>This company has no Stock Journal voucher type.</Empty>
      </Frame>
    );
  }

  const issues = tried ? preview.issues : preview.issues.filter((i) => i.code !== undefined);
  const lineProblem = (i: number): string | undefined => issues.find((x) => x.field.startsWith(`line.${i}.`))?.message;
  const update = (fn: (f: StockForm) => StockForm) => {
    setRefused('');
    setForm((f) => (f ? fn(f) : f));
  };
  const setLine = (i: number, patch: Partial<StockLineForm>) => update((f) => ({ ...f, lines: f.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) }));
  const unitOf = (itemId: string) => {
    const item = masters.stockItem(itemId as never);
    return item ? masters.unit(item.unitId) : undefined;
  };
  const godowns = masters.warehouses.filter((w) => w.isActive);

  const openAdd = (direction: 'in' | 'out') => {
    setAdding(direction);
    nav.openLayer(() => setAdding(undefined));
  };
  /** An item tapped: one of it, out of (or into) the main godown — coming in, at what the book holds it at — opened for the quantity. */
  const chooseItem = (id: string) => {
    const direction = adding ?? 'out';
    const item = masters.stockItem(id as never);
    const held = item ? books.stock.positionAt(item.id, form.date as never) : undefined;
    const average = held && held.qty > 0n ? rateOf(held.value, held.qty) : undefined;
    const cost = average === undefined ? '' : trimPlaces(formatRate(average));
    const line: StockLineForm = { ...blankStockLine(direction, defaultWarehouse(masters)), itemId: id, itemLabel: item?.name ?? '', qty: '1', rate: direction === 'in' ? cost : '' };
    const at = form.lines.length;
    update((f) => ({ ...f, lines: [...f.lines, line] }));
    setAdding(undefined);
    setEditing(at);
    nav.swapLayer(() => setEditing(undefined));
  };
  const openLine = (i: number) => {
    setEditing(i);
    nav.openLayer(() => setEditing(undefined));
  };
  const dropLine = (i: number) => update((f) => ({ ...f, lines: f.lines.filter((_, k) => k !== i) }));

  const save = () => {
    if (busy) return;
    if (!preview.ok) {
      setTried(true);
      setRefused(preview.issues[0]?.message ?? 'Something is missing');
      return;
    }
    setBusy(true);
    void books.post(preview.draft).then(
      (r) => {
        setBusy(false);
        if (!r.ok) return setRefused(r.issues[0]?.message ?? 'It could not be saved');
        nav.replace({ page: 'doc', voucherId: r.value.voucher.id });
      },
      (error: unknown) => {
        setBusy(false);
        setRefused(`It could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  };

  const line = editing !== undefined ? form.lines[editing] : undefined;
  return (
    <>
      <Frame
        nav={nav}
        title="New Stock Journal"
        foot={
          <>
            <span class="m-total" data-testid="sj-values">
              <span class="m-total-label">Out {preview.ok ? formatAmount(preview.valueOut) : '—'}</span>
              <span class="m-total-label">In {preview.ok ? formatAmount(preview.valueIn) : '—'}</span>
            </span>
            <button type="button" class="m-button m-primary" data-testid="sj-save" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        {refused ? (
          <p class="m-note bad m-strip" role="alert" data-testid="sj-refused">
            {refused}
          </p>
        ) : null}
        <Group title="Stock moved">
          {form.lines.map((l, i) => {
            const unit = unitOf(l.itemId);
            const value = preview.values.get(i);
            return (
              <div key={i} class="m-line">
                <Row
                  title={`${l.direction === 'in' ? 'In' : 'Out'} · ${l.itemLabel}`}
                  sub={[`${l.qty || '?'} ${unit?.symbol ?? ''}`.trim(), l.direction === 'in' ? `at ${l.rate || '?'}` : undefined, `${l.direction === 'in' ? 'into' : 'from'} ${l.warehouseLabel || '?'}`].filter(Boolean).join(' · ')}
                  value={value ? formatAmount(value.value) : undefined}
                  problem={lineProblem(i)}
                  onOpen={() => openLine(i)}
                  testId="sj-line"
                />
                <button type="button" class="m-line-x" aria-label={`Remove ${l.itemLabel}`} onClick={() => dropLine(i)}>
                  ×
                </button>
              </div>
            );
          })}
          <div class="m-actions">
            <button type="button" class="m-button" data-testid="sj-add-out" onClick={() => openAdd('out')}>
              + Out (leaves)
            </button>
            <button type="button" class="m-button" data-testid="sj-add-in" onClick={() => openAdd('in')}>
              + In (arrives)
            </button>
          </div>
          {issues.find((x) => x.field === 'general') ? <p class="m-note bad">{issues.find((x) => x.field === 'general')?.message}</p> : null}
        </Group>
        <Group title="Details">
          <label class="m-field">
            <span class="m-field-label">Date</span>
            <input type="date" class="m-input" aria-label="Date" value={form.date} onChange={(e) => (e.target as HTMLInputElement).value && update((f) => ({ ...f, date: (e.target as HTMLInputElement).value }))} />
          </label>
          {issues.find((x) => x.field === 'date') ? <p class="m-note bad">{issues.find((x) => x.field === 'date')?.message}</p> : null}
          <label class="m-field m-field-tall">
            <span class="m-field-label">Narration</span>
            <textarea class="m-input" aria-label="Narration" rows={2} value={form.narration} onInput={(e) => update((f) => ({ ...f, narration: (e.target as HTMLTextAreaElement).value }))} />
          </label>
        </Group>
        <p class="m-note">A transfer is an Out from one godown and an In of the same item to another. No accounts are touched.</p>
      </Frame>

      {adding ? (
        <Picker
          title={adding === 'in' ? 'What arrives?' : 'What leaves?'}
          label="Search items"
          options={itemOptions(masters).map((o) => ({ ...o, value: stockOf(books, o.id, form.date) }))}
          onChoose={chooseItem}
          onClose={() => nav.closeLayer()}
          empty="No such item."
        />
      ) : null}
      {line && editing !== undefined ? (
        <div class="m-sheet-back" onClick={(e) => e.target === e.currentTarget && nav.closeLayer()}>
          <div class="m-sheet" role="dialog" aria-label={line.itemLabel} data-testid="sj-sheet">
            <p class="m-sheet-title">
              {line.direction === 'in' ? 'In' : 'Out'} · {line.itemLabel}
            </p>
            <div class="m-field">
              <span class="m-field-label">Direction</span>
              <span class="m-seg" role="group" aria-label="Direction">
                {(['out', 'in'] as const).map((d) => (
                  <button key={d} type="button" class={line.direction === d ? 'm-seg-on' : ''} aria-pressed={line.direction === d} onClick={() => setLine(editing, { direction: d, ...(d === 'out' ? { rate: '' } : {}) })}>
                    {d === 'out' ? 'Out' : 'In'}
                  </button>
                ))}
              </span>
            </div>
            <div class="m-field">
              <span class="m-field-label">Quantity{unitOf(line.itemId) ? ` (${unitOf(line.itemId)?.symbol})` : ''}</span>
              <span class="m-stepper">
                <button type="button" aria-label="One fewer" onClick={() => setLine(editing, { qty: stepQty(line.qty, -1) })}>
                  −
                </button>
                <input type="text" inputMode="decimal" class="m-input m-num" aria-label="Quantity" data-testid="sj-qty" value={line.qty} autocomplete="off" onFocus={(e) => (e.target as HTMLInputElement).select()} onInput={(e) => setLine(editing, { qty: (e.target as HTMLInputElement).value })} />
                <button type="button" aria-label="One more" data-testid="sj-qty-more" onClick={() => setLine(editing, { qty: stepQty(line.qty, 1) })}>
                  +
                </button>
              </span>
            </div>
            {line.direction === 'in' ? (
              <label class="m-field">
                <span class="m-field-label">Rate</span>
                <input type="text" inputMode="decimal" class="m-input m-num" aria-label="Rate" data-testid="sj-rate" value={line.rate} autocomplete="off" onFocus={(e) => (e.target as HTMLInputElement).select()} onInput={(e) => setLine(editing, { rate: (e.target as HTMLInputElement).value })} />
              </label>
            ) : null}
            <label class="m-field">
              <span class="m-field-label">{line.direction === 'in' ? 'Into' : 'From'}</span>
              <select class="m-input" aria-label="Godown" data-testid="sj-godown" value={line.warehouseId} onChange={(e) => setLine(editing, { warehouseId: (e.target as HTMLSelectElement).value, warehouseLabel: godowns.find((g) => g.id === (e.target as HTMLSelectElement).value)?.name ?? '' })}>
                {line.warehouseId === '' ? <option value="">Choose…</option> : null}
                {godowns.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({formatQuantity(books.stock.qtyAt(line.itemId as never, g.id, form.date as never), unitOf(line.itemId)?.decimals ?? 0)})
                  </option>
                ))}
              </select>
            </label>
            {lineProblem(editing) ? (
              <p class="m-note bad" data-testid="sj-problem">
                {lineProblem(editing)}
              </p>
            ) : null}
            <div class="m-actions">
              <button
                type="button"
                class="m-button m-danger"
                onClick={() => {
                  dropLine(editing);
                  nav.closeLayer();
                }}
              >
                Remove
              </button>
              <button type="button" class="m-button m-primary" data-testid="sj-done" onClick={() => nav.closeLayer()}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {leaving ? (
        <div class="m-sheet-back">
          <div class="m-sheet" role="alertdialog" aria-label="Discard?">
            <p class="m-sheet-title">Discard what you entered?</p>
            <div class="m-actions">
              <button type="button" class="m-button" onClick={() => setLeaving(false)}>
                Keep editing
              </button>
              <button
                type="button"
                class="m-button m-danger"
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
