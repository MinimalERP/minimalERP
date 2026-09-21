import { type EntityDoc, searchEntities } from '@minimalerp/command';
import {
  GST_REGISTRATIONS,
  type Party,
  type PartyAddress,
  type PartyDetails,
  canonicalId,
  partyDetailsProblems,
  partyToData,
} from '@minimalerp/domain';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Books } from '../books/books';
import { useCommandHandler, useScope, useServices, useSubscriptions } from '../shell/hooks';
import { Hint } from '../shell/Hint';
import { ListView } from '../ui/ListView';

const SCOPE = 'overlay:party-details';

interface Opt {
  readonly value: string;
  readonly label: string;
  readonly sub?: string | undefined;
}
type FieldDef =
  | { readonly key: string; readonly label: string; readonly type: 'text'; readonly hint?: string }
  | { readonly key: string; readonly label: string; readonly type: 'choice' | 'picker'; readonly options: readonly Opt[] };

const REGISTRATION_LABELS: Readonly<Record<string, string>> = {
  regular: 'Regular',
  composition: 'Composition',
  unregistered: 'Unregistered / consumer',
  sez: 'SEZ',
  overseas: 'Overseas',
};
const MANUAL = 'manual';
const SAME = 'same';

const SHIPPING = 'shipping';

const addressOptions = (party: Party | undefined, forShip = false): Opt[] => [
  ...(party?.address ? [{ value: 'primary', label: 'Primary address', sub: party.address }] : []),
  ...(forShip && party?.shipping?.lines ? [{ value: SHIPPING, label: 'Shipping address', sub: party.shipping.lines }] : []),
  ...(party?.addresses ?? []).map((a) => ({ value: `saved:${a.id}`, label: a.label, sub: a.lines })),
  { value: MANUAL, label: 'Enter manually…' },
];

interface Values {
  party: string;
  partyLabel: string;
  mailing: string;
  billPick: string;
  billLines: string;
  billState: string;
  billCountry: string;
  billPin: string;
  registration: string;
  gstin: string;
  shipMode: string;
  consignee: string;
  shipLines: string;
  shipState: string;
  shipPin: string;
  place: string;
  saveAs: string;
}
/** Fields are addressed by key at run time (a field definition names its own key). */
const byKey = (v: Values, key: string): string => (v as unknown as Record<string, string>)[key] ?? '';

/** The values the window opens with: the voucher's own snapshot if it has one, else the party master. */
function initialValues(party: Party | undefined, saved: PartyDetails | undefined): Values {
  if (saved) {
    const ship = saved.shipTo;
    return {
      party: saved.partyId ?? '',
      partyLabel: party?.name ?? '',
      mailing: saved.mailingName ?? '',
      billPick: MANUAL,
      billLines: saved.billTo?.lines ?? '',
      billState: saved.billTo?.stateCode ?? '',
      billCountry: saved.billTo?.country ?? 'India',
      billPin: saved.billTo?.pincode ?? '',
      registration: saved.gstRegistration ?? '',
      gstin: saved.gstin ?? '',
      shipMode: ship ? MANUAL : SAME,
      consignee: ship?.name ?? '',
      shipLines: ship?.lines ?? '',
      shipState: ship?.stateCode ?? '',
      shipPin: ship?.pincode ?? '',
      place: saved.placeOfSupply ?? '',
      saveAs: '',
    };
  }
  return {
    party: party?.id ?? '',
    partyLabel: party?.name ?? '',
    mailing: party?.name ?? '',
    billPick: party?.address ? 'primary' : MANUAL,
    billLines: party?.address ?? '',
    billState: party?.stateCode ?? '',
    billCountry: party?.country ?? 'India',
    billPin: party?.pincode ?? '',
    registration: party?.gstRegistration ?? (party?.gstin ? 'regular' : ''),
    gstin: party?.gstin ?? '',
    // The party's own shipping address, when it has one different from billing.
    shipMode: party?.shipping?.lines ? SHIPPING : SAME,
    consignee: party?.shipping?.lines ? party.name : '',
    shipLines: party?.shipping?.lines ?? '',
    shipState: party?.shipping?.stateCode ?? '',
    shipPin: party?.shipping?.pincode ?? '',
    place: party?.shipping?.lines ? (party.shipping.stateCode ?? party.stateCode ?? '') : (party?.stateCode ?? ''),
    saveAs: '',
  };
}

interface Props {
  readonly books: Books;
  /** The ledgers on the voucher: the first one that belongs to a party tells us which party this is. */
  readonly ledgerIds: readonly string[];
  readonly value: PartyDetails | undefined;
  readonly onDone: (result: PartyDetails | 'cancel') => void;
}

/**
 * The Party Details window: who the voucher is billed and shipped to, kept OUT of the entry form. Everything is prefilled from the party
 * master and can be changed for this voucher only; the voucher keeps a snapshot. A manual address can be saved to the party's address book.
 */
export function PartyDetailsDialog({ books, ledgerIds, value, onDone }: Props) {
  const { keymapStore } = useServices();
  useSubscriptions(keymapStore);
  useScope(SCOPE, 'overlay', true);
  const masters = books.masters;

  const partyFromLines = useMemo(() => {
    for (const id of ledgerIds) {
      const partyId = masters.ledger(id as never)?.partyId;
      if (partyId) return masters.party(partyId);
    }
    return undefined;
  }, [ledgerIds.join('|')]);
  const savedParty = value?.partyId ? masters.party(value.partyId as never) : undefined;

  const [v, setV] = useState<Values>(() => initialValues(savedParty ?? partyFromLines, value));
  const [focus, setFocus] = useState('party');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pick, setPick] = useState({ index: 0, touched: false });
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const party = v.party ? masters.party(v.party as never) : undefined;

  const set = (patch: Partial<Values>) => setV((x) => ({ ...x, ...patch }));

  const applyParty = (p: Party | undefined) => {
    const base = initialValues(p, undefined);
    set({ ...base, saveAs: v.saveAs, shipMode: v.shipMode === MANUAL ? MANUAL : base.shipMode });
  };

  const partyOptions: Opt[] = masters.parties.filter((p) => p.isActive).map((p) => ({ value: p.id, label: p.name, sub: [p.gstin, p.phone].filter(Boolean).join(' · ') }));
  const shipOptions: Opt[] = [{ value: SAME, label: 'Same as billing address' }, ...addressOptions(party, true)];
  const fields: FieldDef[] = [
    { key: 'party', label: 'Buyer (Bill to)', type: 'picker', options: partyOptions },
    { key: 'mailing', label: 'Mailing name', type: 'text' },
    { key: 'billPick', label: 'Billing address', type: 'choice', options: addressOptions(party) },
    { key: 'billLines', label: 'Address', type: 'text' },
    { key: 'billState', label: 'State code', type: 'text', hint: 'two digits, e.g. 27' },
    { key: 'billCountry', label: 'Country', type: 'text' },
    { key: 'registration', label: 'GST registration', type: 'choice', options: [{ value: '', label: '—' }, ...GST_REGISTRATIONS.map((r) => ({ value: r, label: REGISTRATION_LABELS[r] ?? r }))] },
    { key: 'gstin', label: 'GSTIN / UIN', type: 'text' },
    { key: 'shipMode', label: 'Ship to', type: 'choice', options: shipOptions },
    ...(v.shipMode !== SAME
      ? ([
          { key: 'consignee', label: 'Consignee', type: 'text' },
          { key: 'shipLines', label: 'Ship-to address', type: 'text' },
          { key: 'shipState', label: 'Ship-to state code', type: 'text' },
        ] as FieldDef[])
      : []),
    { key: 'place', label: 'Place of supply', type: 'text', hint: 'defaults to the ship-to state' },
    ...(v.party !== '' && (v.billPick === MANUAL || v.shipMode === MANUAL)
      ? ([{ key: 'saveAs', label: 'Save address to party as', type: 'text', hint: 'a name like “Chakan unit”; leave empty to use it for this voucher only' }] as FieldDef[])
      : []),
  ];
  const at = Math.max(0, fields.findIndex((f) => f.key === focus));
  const current = fields[at] as FieldDef;

  useEffect(() => {
    const el = rootRef.current?.querySelector<HTMLInputElement>(`[data-pd="${current.key}"]`);
    el?.focus();
    if (el && el.type === 'text') el.select();
  }, [focus]);

  // ---- pickers / choices ----
  const optionsNow: readonly Opt[] = current.type === 'text' ? [] : current.options;
  const typed = current.key === 'party' ? v.partyLabel : '';
  const hits: Opt[] = useMemo(() => {
    if (current.type !== 'picker') return [];
    if (typed.trim() === '' || typed === party?.name) return []; // a list opens when something is typed, and offers only what matches
    const docs: EntityDoc[] = optionsNow.map((o) => ({ key: o.value, kind: '', scope: 'p', title: o.label, subtitle: o.sub, commandId: '', args: o.value }));
    return searchEntities(docs, typed, { limit: 8 }).map((h) => optionsNow.find((o) => o.value === h.key) as Opt);
  }, [current.key, typed, optionsNow.length]);
  const pickIndex = Math.min(pick.index, Math.max(0, hits.length - 1));

  const selectOption = (key: string, value: string) => {
    if (key === 'party') {
      applyParty(masters.party(value as never));
      return;
    }
    if (key === 'billPick') {
      if (value === MANUAL) return set({ billPick: MANUAL });
      const a = billingAddress(party, value);
      return set({ billPick: value, billLines: a?.lines ?? '', billState: a?.stateCode ?? v.billState, billCountry: a?.country ?? 'India', billPin: a?.pincode ?? '', place: v.shipMode === SAME ? (a?.stateCode ?? v.place) : v.place });
    }
    if (key === 'shipMode') {
      if (value === SAME || value === MANUAL) return set({ shipMode: value, ...(value === SAME ? { place: v.billState || v.place } : {}) });
      const a = billingAddress(party, value);
      return set({ shipMode: value, consignee: v.consignee || (party?.name ?? ''), shipLines: a?.lines ?? '', shipState: a?.stateCode ?? '', shipPin: a?.pincode ?? '', place: a?.stateCode ?? v.place });
    }
    set({ [key]: value } as Partial<Values>);
  };

  const settle = (): boolean => {
    if (current.type === 'picker' && current.key === 'party') {
      const choice = hits[pickIndex];
      if (typed.trim() === '') {
        if (v.party !== '') set({ party: '', partyLabel: '' });
        return true;
      }
      if (typed === party?.name) return true;
      if (choice && (pick.touched || typed.trim() !== '')) {
        selectOption('party', choice.value);
        return true;
      }
      setErrors((e) => ({ ...e, party: 'No such party — create it first with Alt+C in the Party master' }));
      return false;
    }
    return true;
  };
  const go = (key: string) => {
    setPick({ index: 0, touched: false });
    setFocus(key);
  };
  const next = (): boolean => {
    if (!settle()) return true;
    const k = fields[at + 1]?.key;
    if (k) go(k);
    else void accept();
    return true;
  };

  const cycle = (delta: number): boolean => {
    if (current.type === 'choice') {
      const i = current.options.findIndex((o) => o.value === byKey(v, current.key));
      const o = current.options[(i + delta + current.options.length) % current.options.length];
      if (o) selectOption(current.key, o.value);
      return true;
    }
    if (current.type === 'picker' && hits.length > 0) {
      setPick({ index: (pickIndex + delta + hits.length) % hits.length, touched: true });
      return true;
    }
    return false;
  };

  useCommandHandler(SCOPE, 'field.next', next);
  useCommandHandler(SCOPE, 'nav.activate', next);
  useCommandHandler(SCOPE, 'field.prev', () => {
    const k = fields[at - 1]?.key;
    if (k) go(k);
    return true;
  });
  useCommandHandler(SCOPE, 'nav.down', () => cycle(1) || next());
  useCommandHandler(SCOPE, 'nav.up', () => {
    if (cycle(-1)) return true;
    const k = fields[at - 1]?.key;
    if (k) go(k);
    return true;
  });
  useCommandHandler(SCOPE, 'voucher.accept', () => {
    void accept();
    return true;
  });
  useCommandHandler(SCOPE, 'app.back', () => {
    onDone('cancel');
    return true;
  });

  // ---- accept ----
  const accept = async (): Promise<void> => {
    if (busy || !settle()) return;
    const clean = (s: string) => (s.trim() === '' ? undefined : s.trim());
    const details: PartyDetails = {
      ...(v.party ? { partyId: v.party } : {}),
      ...(clean(v.mailing) ? { mailingName: clean(v.mailing) } : {}),
      billTo: { lines: clean(v.billLines), stateCode: clean(v.billState), country: clean(v.billCountry), pincode: clean(v.billPin) },
      ...(v.shipMode !== SAME ? { shipTo: { name: clean(v.consignee), lines: clean(v.shipLines), stateCode: clean(v.shipState), country: clean(v.billCountry), pincode: clean(v.shipPin) } } : {}),
      ...(v.registration ? { gstRegistration: v.registration as PartyDetails['gstRegistration'] } : {}),
      ...(clean(v.gstin) ? { gstin: canonicalId(v.gstin) } : {}),
      ...(clean(v.place || (v.shipMode === SAME ? v.billState : v.shipState)) ? { placeOfSupply: clean(v.place || (v.shipMode === SAME ? v.billState : v.shipState)) } : {}),
    };
    const problems = partyDetailsProblems(details, masters);
    if (problems.length > 0) {
      const map: Record<string, string> = {};
      const keyOf = (p: string | undefined): string =>
        p === 'partyDetails.gstin' ? 'gstin' : p === 'partyDetails.billTo.stateCode' ? 'billState' : p === 'partyDetails.shipTo.stateCode' ? 'shipState' : p === 'partyDetails.placeOfSupply' ? 'place' : 'party';
      for (const p of problems) map[keyOf(p.path)] ??= p.message;
      setErrors(map);
      const bad = fields.find((f) => map[f.key] !== undefined);
      if (bad) go(bad.key);
      return;
    }

    // "Save address to party": a manual address becomes a saved choice for next time.
    const label = v.saveAs.trim();
    if (party && label !== '' && (v.billPick === MANUAL || v.shipMode === MANUAL)) {
      setBusy(true);
      const useShip = v.shipMode === MANUAL;
      const entry: PartyAddress = {
        id: crypto.randomUUID(),
        label,
        lines: (useShip ? v.shipLines : v.billLines).trim(),
        stateCode: clean(useShip ? v.shipState : v.billState),
        country: clean(v.billCountry),
        pincode: clean(useShip ? v.shipPin : v.billPin),
      };
      const saved = await books.execute({ op: 'alter', kind: 'party', id: party.id, data: { ...partyToData(party), addresses: [...(party.addresses ?? []), entry] } });
      setBusy(false);
      if (!saved.ok) {
        setErrors({ saveAs: saved.issues[0]?.message ?? 'The address could not be saved' });
        go('saveAs');
        return;
      }
    }
    onDone(details);
  };

  const show = (f: FieldDef): string => {
    if (f.type === 'choice') return f.options.find((o) => o.value === byKey(v, f.key))?.label ?? '';
    if (f.key === 'party') return v.partyLabel;
    return byKey(v, f.key);
  };

  return (
    <div class="overlay-backdrop" data-testid="party-backdrop">
      <div class="palette dialog" role="dialog" aria-modal="true" aria-label="Party Details" data-testid="party-details" ref={rootRef}>
        <h2 class="dialog-title">Party Details</h2>
        <div class="dialog-body">
          {fields.map((f) => {
            const active = f.key === current.key;
            const err = errors[f.key];
            return (
              <div key={f.key} class={active ? 'field-row active' : 'field-row'}>
                <label class="field-label" for={`pd-${f.key}`}>
                  {f.label}
                </label>
                <div class="field-control">
                  <input
                    id={`pd-${f.key}`}
                    data-pd={f.key}
                    class={err ? 'field-input invalid' : 'field-input'}
                    type="text"
                    role={f.type === 'text' ? undefined : 'combobox'}
                    readOnly={f.type === 'choice'}
                    autocomplete="off"
                    spellcheck={false}
                    value={show(f)}
                    onFocus={() => !active && go(f.key)}
                    onInput={(e) => {
                      const text = (e.target as HTMLInputElement).value;
                      setErrors((x) => ({ ...x, [f.key]: '' }));
                      if (f.key === 'party') {
                        setPick({ index: 0, touched: true });
                        set({ partyLabel: text });
                      } else if (f.type === 'text') set({ [f.key]: text } as Partial<Values>);
                    }}
                  />
                  {err && (
                    <span class="field-error" role="alert">
                      {err}
                    </span>
                  )}
                  {!err && active && 'hint' in f && f.hint && <span class="field-hint">{f.hint}</span>}
                  {active && f.type === 'picker' && hits.length === 0 && typed.trim() !== '' && typed !== party?.name && (
                    <div class="picker picker-empty" data-testid="picker">No match</div>
                  )}
                  {active && f.type === 'picker' && hits.length > 0 && (
                    <div class="picker" data-testid="picker">
                      <ListView
                        items={hits}
                        index={pickIndex}
                        itemKey={(o) => o.value}
                        label="Parties"
                        onActivate={(n) => hits[n] && selectOption(f.key, (hits[n] as Opt).value)}
                        renderItem={(o) => (
                          <>
                            <span class="row-title">{o.label}</span>
                            {o.sub && <span class="row-desc">{o.sub}</span>}
                          </>
                        )}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div class="palette-foot">
          <Hint command="nav.activate" fallback="Enter">
            next
          </Hint>
          <Hint command="nav.down" also="nav.up">
            choose
          </Hint>
          <Hint command="voucher.accept">accept</Hint>
          <Hint command="app.back">cancel</Hint>
        </div>
      </div>
    </div>
  );
}

/** The saved address behind a picker value ("primary" is the address on the party profile). */
function billingAddress(party: Party | undefined, value: string): { lines: string; stateCode?: string | undefined; country?: string | undefined; pincode?: string | undefined } | undefined {
  if (!party) return undefined;
  if (value === 'primary') return { lines: party.address ?? '', stateCode: party.stateCode, country: party.country, pincode: party.pincode };
  if (value === SHIPPING) return party.shipping?.lines ? { lines: party.shipping.lines, stateCode: party.shipping.stateCode, country: party.shipping.country, pincode: party.shipping.pincode } : undefined;
  const id = value.replace(/^saved:/, '');
  return party.addresses?.find((a) => a.id === id);
}
