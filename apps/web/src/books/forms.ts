import {
  type Issue,
  type MasterKind,
  type MasterRecord,
  type Masters,
  type Party,
  type PartyRole,
  ITEM_TYPES,
  MASTER_LABELS,
  USER_BASE_KINDS,
  formatMoney,
  masterRecordName,
} from '@minimalerp/domain';
import type { EntityDoc } from '@minimalerp/command';
import { entityDocsOf } from './entities';

/** What a field holds. Everything is typed as text in the form; the master engine parses it. */
export type FieldType = 'text' | 'integer' | 'decimal' | 'money' | 'date' | 'ref' | 'choice';

/** What a reference field points at. `financialYear` is not a master a user creates, so it has no Alt+C. */
export type RefTarget = MasterKind | 'financialYear';

export interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required?: boolean;
  /** For `ref`: what it points at. */
  readonly target?: RefTarget;
  /** For `choice`: the fixed options. */
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
  readonly hint?: string;
  /** Only when creating (opening balances are set once, at creation). */
  readonly createOnly?: boolean;
  readonly placeholder?: string;
  readonly defaultValue?: string;
  /** A heading shown above this field (the form's sections). */
  readonly heading?: string;
  /** Shown only while this is true of the form's values (and, when creating, only when `createOnly` allows). Hidden fields keep their value. */
  readonly visibleIf?: (values: FormValues) => boolean;
  /** For `choice`: the options that make sense for the record being altered (say, a party may gain a role but not lose one). */
  readonly choicesFor?: (record: MasterRecord | undefined) => readonly { readonly value: string; readonly label: string }[];
  /** For `ref`: leave out records the form should not offer (the value already stored is still shown). */
  readonly offer?: ((masters: Masters, id: string) => boolean) | undefined;
}

export interface FormSpec {
  readonly kind: MasterKind;
  /** "Ledger" — headings read "Create Ledger", "Alter Ledger", "Ledger". */
  readonly noun: string;
  readonly fields: readonly FieldSpec[];
  /** The field that names the record (used for the title and for pre-filling from Alt+C). */
  readonly nameField: string;
  /** Form values → the command's data, when the form's shape differs from the record's (a party's type and ship-to). */
  readonly toData?: (values: FormValues, data: Record<string, unknown>) => Record<string, unknown>;
  /** A record → the form values that are not simply its fields. */
  readonly fromRecord?: (record: MasterRecord, values: FormValues) => FormValues;
}

const text = (key: string, label: string, more: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, type: 'text', ...more });
const ref = (key: string, label: string, target: RefTarget, more: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, type: 'ref', target, ...more });

const TYPE_LABELS: Readonly<Record<string, string>> = {
  raw: 'Raw material',
  wip: 'Work in progress',
  finished: 'Finished goods',
  trading: 'Trading goods',
  service: 'Service',
};

const KIND_LABELS: Readonly<Record<string, string>> = {
  contra: 'Contra',
  payment: 'Payment',
  receipt: 'Receipt',
  journal: 'Journal',
  stockJournal: 'Stock Journal',
};

const ROLE_CHOICES = [
  { value: 'customer', label: 'Customer' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'both', label: 'Both — customer and vendor' },
] as const;

/** The roles a Type choice stands for. */
export function roleTypeRoles(value: string): readonly PartyRole[] {
  return value === 'both' ? ['customer', 'vendor'] : value === 'vendor' ? ['vendor'] : value === 'customer' ? ['customer'] : [];
}

/** Party form fields that are not the party's own data (the type and ship-to choice). */
const PARTY_FORM_ONLY = new Set(['roleType', 'shipMode', 'shipLines', 'shipStateCode', 'shipPincode', 'shipCountry']);

export const FORMS: Readonly<Record<MasterKind, FormSpec>> = {
  ledger: {
    kind: 'ledger',
    noun: 'Ledger',
    nameField: 'name',
    fields: [
      text('name', 'Name', { required: true }),
      ref('groupId', 'Under group', 'group', {
        required: true,
        hint: 'Customers and suppliers are created as a Party — their ledgers come with it',
        offer: (m, gid) => !m.groups.isWithinReserved(gid as never, 'sundry-debtors', 'sundry-creditors'),
      }),
      text('code', 'Code'),
      text('alias', 'Alias'),
      ref('partyId', 'Party', 'party', { visibleIf: () => false }),
      { key: 'openingAmount', label: 'Opening balance', type: 'money', createOnly: true, hint: 'Balance brought forward at the start of the financial year' },
      {
        key: 'openingSide',
        label: 'Dr / Cr',
        type: 'choice',
        createOnly: true,
        defaultValue: 'debit',
        choices: [
          { value: 'debit', label: 'Dr (debit)' },
          { value: 'credit', label: 'Cr (credit)' },
        ],
      },
    ],
  },
  group: {
    kind: 'group',
    noun: 'Group',
    nameField: 'name',
    fields: [text('name', 'Name', { required: true }), ref('parentId', 'Under group', 'group', { required: true })],
  },
  party: {
    kind: 'party',
    noun: 'Party',
    nameField: 'name',
    fields: [
      text('name', 'Name', { required: true }),
      {
        key: 'roleType',
        label: 'Type',
        type: 'choice',
        required: true,
        defaultValue: 'customer',
        hint: 'Its ledgers are made for you: a customer under Sundry Debtors, a vendor under Sundry Creditors, both for both',
        choices: ROLE_CHOICES,
        choicesFor: (record) => {
          const had = (record as Party | undefined)?.roles ?? [];
          // A role can be added, never taken away (its ledger may hold entries).
          return ROLE_CHOICES.filter((c) => had.every((r) => roleTypeRoles(c.value).includes(r)));
        },
      },
      text('gstin', 'GSTIN', { hint: '15 characters; the check digit is verified' }),
      {
        key: 'gstRegistration',
        label: 'GST registration',
        type: 'choice',
        choices: [
          { value: 'regular', label: 'Regular' },
          { value: 'composition', label: 'Composition' },
          { value: 'unregistered', label: 'Unregistered / consumer' },
          { value: 'sez', label: 'SEZ' },
          { value: 'overseas', label: 'Overseas' },
        ],
      },
      text('pan', 'PAN', { hint: 'Filled from the GSTIN when you leave it blank' }),
      text('phone', 'Phone'),
      text('email', 'Email'),
      text('address', 'Address', { heading: 'Billing address' }),
      text('stateCode', 'State code', { hint: 'Two digits, e.g. 27 for Maharashtra' }),
      text('pincode', 'Pincode'),
      text('country', 'Country', { placeholder: 'India' }),
      {
        key: 'shipMode',
        label: 'Ship to',
        type: 'choice',
        heading: 'Shipping address',
        defaultValue: 'same',
        choices: [
          { value: 'same', label: 'Same as billing' },
          { value: 'different', label: 'A different address' },
        ],
      },
      text('shipLines', 'Address', { visibleIf: (v) => v.shipMode === 'different' }),
      text('shipStateCode', 'State code', { visibleIf: (v) => v.shipMode === 'different' }),
      text('shipPincode', 'Pincode', { visibleIf: (v) => v.shipMode === 'different' }),
      text('shipCountry', 'Country', { visibleIf: (v) => v.shipMode === 'different', placeholder: 'India' }),
      { key: 'creditDays', label: 'Credit days', type: 'integer', heading: 'Terms' },
      { key: 'creditLimit', label: 'Credit limit', type: 'money' },
      ...(['customer', 'vendor'] as const).flatMap((role): FieldSpec[] => {
        const on = (v: FormValues) => roleTypeRoles(v.roleType ?? '').includes(role);
        const cap = role === 'customer' ? 'Cust' : 'Vend';
        const who = role === 'customer' ? 'As customer' : 'As vendor';
        return [
          {
            key: `open${cap}Amount`,
            label: `${who} — opening`,
            type: 'money',
            createOnly: true,
            visibleIf: on,
            ...(role === 'customer' ? { heading: 'Opening balance (optional)' } : {}),
            hint: role === 'customer' ? 'What this customer owed at the start of the year' : 'What you owed this vendor at the start of the year',
          },
          {
            key: `open${cap}Side`,
            label: 'Dr / Cr',
            type: 'choice',
            createOnly: true,
            visibleIf: on,
            defaultValue: role === 'customer' ? 'debit' : 'credit',
            choices: [
              { value: 'debit', label: 'Dr (debit)' },
              { value: 'credit', label: 'Cr (credit)' },
            ],
          },
          { key: `open${cap}Bill`, label: 'Bill reference', type: 'text', createOnly: true, visibleIf: on, hint: 'The invoice or PO the balance belongs to' },
        ];
      }),
    ],
    toData: (values, data) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) if (!PARTY_FORM_ONLY.has(k)) out[k] = v;
      out.roles = roleTypeRoles(values.roleType ?? 'customer');
      if (values.shipMode === 'different') {
        const ship = { lines: values.shipLines, stateCode: values.shipStateCode, pincode: values.shipPincode, country: values.shipCountry };
        out.shipping = Object.fromEntries(Object.entries(ship).map(([k, v]) => [k, (v ?? '').trim()]).filter(([, v]) => v !== ''));
      }
      return out;
    },
    fromRecord: (record, values) => {
      const p = record as Party;
      const roles = p.roles ?? [];
      const ship = p.shipping;
      return {
        ...values,
        // A party made before roles existed is shown as a customer; saving it makes that customer's ledger.
        roleType: roles.includes('customer') && roles.includes('vendor') ? 'both' : (roles[0] ?? 'customer'),
        shipMode: ship ? 'different' : 'same',
        shipLines: ship?.lines ?? '',
        shipStateCode: ship?.stateCode ?? '',
        shipPincode: ship?.pincode ?? '',
        shipCountry: ship?.country ?? '',
      };
    },
  },
  unit: {
    kind: 'unit',
    noun: 'Unit',
    nameField: 'symbol',
    fields: [
      text('symbol', 'Symbol', { required: true, hint: 'Kg, Nos, Ltr…' }),
      text('name', 'Name', { required: true }),
      { key: 'decimals', label: 'Decimal places', type: 'integer', defaultValue: '0' },
      ref('baseUnitId', 'Base unit', 'unit', { hint: 'Only for a compound unit: 1 Qtl = 100 Kg' }),
      { key: 'factor', label: 'Equals (base units)', type: 'decimal' },
    ],
  },
  stockGroup: {
    kind: 'stockGroup',
    noun: 'Stock Group',
    nameField: 'name',
    fields: [text('name', 'Name', { required: true }), ref('parentId', 'Under group', 'stockGroup')],
  },
  stockItem: {
    kind: 'stockItem',
    noun: 'Stock Item',
    nameField: 'name',
    fields: [
      text('name', 'Name', { required: true }),
      text('code', 'Code'),
      text('alias', 'Alias'),
      ref('groupId', 'Stock group', 'stockGroup'),
      ref('unitId', 'Unit', 'unit', { required: true }),
      text('hsn', 'HSN / SAC', { hint: '4, 6 or 8 digits' }),
      ref('gstRateId', 'GST rate', 'gstRate'),
      {
        key: 'itemType',
        label: 'Type',
        type: 'choice',
        required: true,
        defaultValue: 'trading',
        choices: ITEM_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t })),
      },
      // Stock brought forward at the start of the year (posted as the item's opening-stock voucher). Services hold no stock.
      {
        key: 'openQty',
        label: 'Opening stock',
        type: 'decimal',
        createOnly: true,
        heading: 'Opening stock (optional)',
        visibleIf: (v) => v.itemType !== 'service',
        hint: 'How much you had at the start of the year, in the item’s unit',
      },
      { key: 'openRate', label: 'Rate', type: 'decimal', createOnly: true, visibleIf: (v) => v.itemType !== 'service', hint: 'What one unit cost' },
      ref('openWarehouse', 'Godown', 'warehouse', {
        createOnly: true,
        visibleIf: (v) => v.itemType !== 'service' && (v.openQty ?? '').trim() !== '',
        hint: 'Left blank: the main godown',
      }),
    ],
  },
  warehouse: {
    kind: 'warehouse',
    noun: 'Warehouse',
    nameField: 'name',
    fields: [text('name', 'Name', { required: true }), ref('parentId', 'Inside', 'warehouse')],
  },
  gstRate: {
    kind: 'gstRate',
    noun: 'GST Rate',
    nameField: 'name',
    fields: [
      text('name', 'Name', { required: true }),
      { key: 'ratePercent', label: 'Rate %', type: 'decimal', required: true },
      { key: 'cessPercent', label: 'Cess %', type: 'decimal', defaultValue: '0' },
      { key: 'effectiveFrom', label: 'Effective from', type: 'date', required: true, placeholder: 'YYYY-MM-DD' },
    ],
  },
  voucherType: {
    kind: 'voucherType',
    noun: 'Voucher Type',
    nameField: 'name',
    fields: [
      text('name', 'Name', { required: true }),
      {
        key: 'baseKind',
        label: 'Behaves like',
        type: 'choice',
        required: true,
        choices: USER_BASE_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] ?? k })),
      },
    ],
  },
  numberingSeries: {
    kind: 'numberingSeries',
    noun: 'Numbering Series',
    nameField: 'prefix',
    fields: [
      ref('voucherTypeId', 'Voucher type', 'voucherType', { required: true }),
      ref('financialYearId', 'Financial year', 'financialYear', { required: true }),
      text('prefix', 'Prefix', { placeholder: 'PAY/24-25/' }),
      text('suffix', 'Suffix'),
      { key: 'width', label: 'Number width', type: 'integer', defaultValue: '4' },
      { key: 'startAt', label: 'Start at', type: 'integer', defaultValue: '1' },
    ],
  },
  company: {
    kind: 'company',
    noun: 'Company',
    nameField: 'name',
    fields: [
      text('name', 'Name', { required: true }),
      text('gstin', 'GSTIN'),
      text('stateCode', 'State code'),
      text('address', 'Address'),
      {
        key: 'chargeGst',
        label: 'Charge GST',
        type: 'choice',
        hint: 'Yes: Sales and Purchase invoices carry GST (needs the GSTIN above). No: they are the items alone.',
        choices: [
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
        ],
      },
    ],
    fromRecord: (record, out) => ({ ...out, chargeGst: (record as { chargeGst?: boolean }).chargeGst === true ? 'yes' : 'no' }),
  },
};

export type FormValues = Record<string, string>;

export const isMasterKindName = (s: string): s is MasterKind => Object.hasOwn(FORMS, s);

/** The values a blank form starts with. */
export function blankValues(spec: FormSpec): FormValues {
  return Object.fromEntries(spec.fields.map((f) => [f.key, f.defaultValue ?? '']));
}

/** An existing record's values, as the strings a person would have typed. */
export function recordToValues(spec: FormSpec, record: MasterRecord): FormValues {
  const raw = record as unknown as Record<string, unknown>;
  const out: FormValues = {};
  for (const f of spec.fields) {
    const v = raw[f.key];
    if (f.createOnly) out[f.key] = f.defaultValue ?? '';
    else if (v === undefined || v === null) out[f.key] = '';
    else if (typeof v === 'bigint') out[f.key] = formatMoney(v as never);
    else out[f.key] = String(v);
  }
  return spec.fromRecord ? spec.fromRecord(record, out) : out;
}

/** The command data for a form: blank fields are left out (the engine treats them as "not given"). */
export function valuesToData(spec: FormSpec, values: FormValues): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (f.createOnly) continue;
    const v = (values[f.key] ?? '').trim();
    if (v !== '') data[f.key] = v;
  }
  return spec.toData ? spec.toData(values, data) : data;
}

export interface Option {
  readonly value: string;
  readonly label: string;
  readonly sub?: string | undefined;
}

/** The choices a reference or choice field offers right now. Inactive records are not offered for new links. */
export function optionsFor(field: FieldSpec, masters: Masters, exclude?: string, record?: MasterRecord): readonly Option[] {
  if (field.type === 'choice') return field.choicesFor ? field.choicesFor(record) : (field.choices ?? []);
  if (field.type !== 'ref' || !field.target) return [];
  if (field.target === 'financialYear') return masters.financialYears.map((y) => ({ value: y.id, label: y.label, sub: `${y.start} → ${y.end}` }));
  return pickerDocs(masters, field.target)
    .filter((d) => (d.args as { id: string }).id !== exclude)
    .filter((d) => field.offer?.(masters, (d.args as { id: string }).id) !== false)
    .map((d) => ({ value: (d.args as { id: string }).id, label: d.title, sub: d.subtitle }));
}

/** Active documents of one kind, for a picker. */
function pickerDocs(masters: Masters, target: MasterKind): readonly EntityDoc[] {
  return entityDocsOf(masters).filter((d) => (d.args as { kind: MasterKind }).kind === target && !d.inactive);
}

/** The label a stored id shows in its field. */
export function labelOfRef(field: FieldSpec, masters: Masters, value: string, record?: MasterRecord): string {
  if (value === '') return '';
  // What is already stored is shown even if the form would not offer it for a new choice.
  return optionsFor({ ...field, offer: undefined }, masters, undefined, record).find((o) => o.value === value)?.label ?? '';
}

/** Which form field an issue belongs to (issues carry the field name as their path). */
export function issueField(spec: FormSpec, i: Issue): string | undefined {
  const raw = i.path?.split('.')[0];
  const head = spec.kind === 'party' && raw === 'roles' ? 'roleType' : raw; // the command says "roles"; the form says "Type"
  return head && spec.fields.some((f) => f.key === head) ? head : undefined;
}

export const titleOf = (kind: MasterKind, mode: 'create' | 'alter' | 'display', record?: MasterRecord): string => {
  const noun = FORMS[kind].noun;
  if (mode === 'create') return `Create ${noun}`;
  const name = record ? masterRecordName(record) : '';
  return `${mode === 'alter' ? 'Alter' : 'Display'} ${noun}${name ? `: ${name}` : ''}`;
};

export { MASTER_LABELS };
