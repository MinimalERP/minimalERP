import { COPY_LABELS } from '../ui/printCoordinator';
import { COPY_COUNT_OPTIONS } from '../ui/printing';
import { fileName } from '../vouchers/format';

/**
 * Printing from the phone: which copies (the desktop's own list — Original / Duplicate / Triplicate / Extra Copy), and what this device can
 * do with the pages: print them, hand a PDF to another app (WhatsApp, mail), or keep the PDF. Nothing here draws a page: Print is the
 * desktop's `PrintCoordinator`, the PDF is the desktop's `pdfOf`.
 */

export const COPY_CHOICES = COPY_COUNT_OPTIONS;
export const DEFAULT_COPIES = '1';
const COPIES_KEY = 'minimalerp.mobile.copies';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The copies last printed on this phone (a shop that always prints three is asked once), else one Original. */
export function rememberedCopies(storage: StorageLike | undefined): string {
  try {
    const saved = storage?.getItem(COPIES_KEY);
    return saved && COPY_LABELS[saved] ? saved : DEFAULT_COPIES;
  } catch {
    return DEFAULT_COPIES; // storage is switched off: every print starts at one Original
  }
}

export function rememberCopies(storage: StorageLike | undefined, value: string): void {
  if (!COPY_LABELS[value]) return;
  try {
    storage?.setItem(COPIES_KEY, value);
  } catch {
    // not remembered; nothing else depends on it
  }
}

/** The labels a choice prints, in order (`['ORIGINAL', 'DUPLICATE']`). */
export const copyLabelsOf = (value: string): readonly string[] => COPY_LABELS[value] ?? COPY_LABELS[DEFAULT_COPIES]!;

/** What the sheet's actions say they will make: "3 pages: Original, Duplicate, Triplicate". */
export function copiesSummary(value: string): string {
  return COPY_CHOICES.find((c) => c.value === value)?.hint ?? '';
}

export const pdfNameOf = (voucherNumber: string): string => `${fileName(voucherNumber)}.pdf`;

/**
 * How a PDF leaves this device for another app: the Android app's own share sheet; a browser that can share files; an Android app too old
 * to share (it says "update"); or not at all (the PDF can still be saved).
 */
export type ShareWay = 'app' | 'browser' | 'update' | undefined;

export function shareWayOf(device: { readonly inApp: boolean; readonly appShares: boolean; readonly browserShares: boolean }): ShareWay {
  if (device.inApp) return device.appShares ? 'app' : 'update';
  return device.browserShares ? 'browser' : undefined;
}

export function bytesOfBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
