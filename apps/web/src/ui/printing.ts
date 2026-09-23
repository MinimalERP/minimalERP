import { GST_STATE_NAMES, type Masters } from '@minimalerp/domain';
import type { ChoiceOption } from '../screens/ReportDialogs';
import type { PrintCompany } from './PrintView';

export const COPY_COUNT_OPTIONS: readonly ChoiceOption[] = [
  { value: '1', label: '1 copy', hint: 'Original' },
  { value: '2', label: '2 copies', hint: 'Original, Duplicate' },
  { value: '3', label: '3 copies', hint: 'Original, Duplicate, Triplicate' },
  { value: '4', label: '4 copies', hint: 'Original, Duplicate, Triplicate, Extra Copy' },
];

/** `books.masters.company`, in the shape `PrintView` wants — the Invoice / PDF Settings fields, as they are (blank ones are simply absent). */
export function printCompanyOf(masters: Masters): PrintCompany {
  const c = masters.company;
  return {
    name: c.name,
    address: c.address,
    gstin: c.gstin,
    phone: c.phone,
    email: c.email,
    bankName: c.bankName,
    bankAccountNo: c.bankAccountNo,
    bankIfsc: c.bankIfsc,
    bankBranch: c.bankBranch,
    invoiceNote: c.invoiceNote,
    invoiceTerms: c.invoiceTerms,
  };
}

/** A GST state code as the invoice prints it — "Maharashtra (27)", the bare code if unnamed, nothing if absent. */
export function placeOfSupplyText(stateCode: string | undefined): string | undefined {
  if (!stateCode) return undefined;
  const name = GST_STATE_NAMES[stateCode];
  return name ? `${name} (${stateCode})` : stateCode;
}
