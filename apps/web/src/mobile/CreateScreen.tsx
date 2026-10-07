import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { type CreateWhat, type CustomerFields, ITEM_TYPE_CHOICES, type ItemFields, STATE_CHOICES, blankCustomer, blankItem, createProblems, customerCommand, itemCommand, withGstin } from './create';

/**
 * A new stock item or customer, made on the phone in the few fields a sale needs — full screen, Save under the thumb. Opened from a search
 * that found nothing ("+ Create …", and then chosen straight into the document) or from the Stock / Parties lists.
 */
export function CreateScreen({
  books,
  what,
  name,
  seed,
  onSaved,
  onClose,
}: {
  books: Books;
  what: CreateWhat;
  name?: string | undefined;
  /** What a scanned document printed about it (GSTIN, address; HSN, GST rate, unit): the form starts with it. */
  seed?: Readonly<Record<string, string>> | undefined;
  onSaved: (id: string) => void;
  onClose: () => void;
}) {
  const [id] = useState(() => crypto.randomUUID()); // one id for the form: Save tapped twice cannot make two
  const [item, setItem] = useState<ItemFields>(() => {
    const blank = blankItem(books, seed?.['name'] ?? name);
    return { ...blank, hsn: seed?.['hsn'] ?? '', gstRateId: seed?.['gstRateId'] ?? '', unitId: seed?.['unitId'] ?? blank.unitId };
  });
  const [customer, setCustomer] = useState<CustomerFields>(() => withGstin({ ...blankCustomer(books, seed?.['name'] ?? name), address: seed?.['address'] ?? '' }, seed?.['gstin'] ?? ''));
  const party = what === 'supplier' ? 'supplier' : 'customer';
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState('');

  const command = what === 'item' ? itemCommand(id, item) : customerCommand(id, customer, what === 'supplier' ? 'vendor' : 'customer');
  const problems = createProblems(books, command);
  const said = (field: string): string | undefined => (tried ? problems[field] : undefined);
  const units = books.masters.units.filter((u) => u.isActive);
  const rates = books.masters.gstRates;

  const save = () => {
    if (busy) return;
    if (Object.keys(problems).length > 0) {
      setTried(true);
      setRefused(Object.values(problems)[0] ?? 'Something is missing');
      return;
    }
    setBusy(true);
    void books.execute(command).then(
      (r) => {
        setBusy(false);
        if (!r.ok) return setRefused(r.issues[0]?.message ?? 'It could not be saved');
        onSaved(id);
      },
      (error: unknown) => {
        setBusy(false);
        setRefused(`It could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  };

  const field = (label: string, problem: string | undefined, control: ComponentChildren) => (
    <>
      <label class="m-field">
        <span class="m-field-label">{label}</span>
        {control}
      </label>
      {problem ? <p class="m-note bad">{problem}</p> : null}
    </>
  );
  const input = (label: string, value: string, set: (v: string) => void, extra: { inputMode?: 'text' | 'tel' | 'numeric'; autoFocus?: boolean; upper?: boolean } = {}) => (
    <input
      type="text"
      class="m-input"
      aria-label={label}
      value={value}
      inputMode={extra.inputMode ?? 'text'}
      autocomplete="off"
      autocapitalize={extra.upper ? 'characters' : 'words'}
      spellcheck={false}
      ref={(el) => {
        if (el && extra.autoFocus && !el.dataset['focused']) {
          el.dataset['focused'] = '1';
          el.focus();
        }
      }}
      onInput={(e) => {
        setRefused('');
        set((e.target as HTMLInputElement).value);
      }}
    />
  );
  const select = (label: string, value: string, set: (v: string) => void, options: readonly { value: string; label: string }[], none?: string) => (
    <select class="m-input" aria-label={label} value={value} onChange={(e) => set((e.target as HTMLSelectElement).value)}>
      {none !== undefined ? <option value="">{none}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );

  return (
    <div class="m-layer" role="dialog" aria-label={what === 'item' ? 'New stock item' : `New ${party}`} data-testid="create">
      <header class="m-bar">
        <button type="button" class="m-back" aria-label="Close" onClick={onClose}>
          ‹
        </button>
        <h1 class="m-title">{what === 'item' ? 'New stock item' : `New ${party}`}</h1>
      </header>
      <div class="m-main has-foot">
        {refused ? (
          <p class="m-note bad m-strip" role="alert" data-testid="create-refused">
            {refused}
          </p>
        ) : null}
        <section class="m-group">
          <h2 class="m-group-title">{what === 'item' ? 'Item' : party}</h2>
          {what === 'item' ? (
            <>
              {field('Name', said('name'), input('Item name', item.name, (v) => setItem({ ...item, name: v }), { autoFocus: true }))}
              {field('Unit', said('unitId'), select('Unit', item.unitId, (v) => setItem({ ...item, unitId: v }), units.map((u) => ({ value: u.id, label: `${u.symbol} — ${u.name}` }))))}
              {field('Type', said('itemType'), select('Type', item.itemType, (v) => setItem({ ...item, itemType: v }), ITEM_TYPE_CHOICES))}
              {field('HSN / SAC', said('hsn'), input('HSN or SAC code', item.hsn, (v) => setItem({ ...item, hsn: v }), { inputMode: 'numeric' }))}
              {field('GST rate', said('gstRateId'), select('GST rate', item.gstRateId, (v) => setItem({ ...item, gstRateId: v }), rates.map((r) => ({ value: r.id, label: r.name })), 'None'))}
            </>
          ) : (
            <>
              {field('Name', said('name'), input(what === 'supplier' ? 'Supplier name' : 'Customer name', customer.name, (v) => setCustomer({ ...customer, name: v }), { autoFocus: true }))}
              {field('Phone', said('phone'), input('Phone', customer.phone, (v) => setCustomer({ ...customer, phone: v }), { inputMode: 'tel' }))}
              {field('GSTIN', said('gstin'), input('GSTIN', customer.gstin, (v) => setCustomer(withGstin(customer, v)), { upper: true }))}
              {field('State', said('stateCode'), select('State', customer.stateCode, (v) => setCustomer({ ...customer, stateCode: v }), STATE_CHOICES, 'Not set'))}
              {field('Address', said('address'), input('Address', customer.address, (v) => setCustomer({ ...customer, address: v })))}
            </>
          )}
        </section>
        <p class="m-note">{what === 'item' ? 'Opening stock, group and drawings are added in the desktop version.' : 'Credit days, shipping address and more are added in the desktop version.'}</p>
      </div>
      <footer class="m-foot">
        <button type="button" class="m-button m-primary" data-testid="create-save" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : what === 'item' ? 'Save item' : `Save ${party}`}
        </button>
      </footer>
    </div>
  );
}
