/**
 * The MinimalERP Android app (apps/android) shows this site in a WebView and adds `window.MinimalERPAndroid` for what a WebView cannot do
 * alone. In a browser it is absent and every helper here does what the browser does.
 */
interface AndroidBridge {
  takeSharedFiles(): string;
  print(title: string): void;
  saveFile(name: string, mime: string, base64: string): void;
  openExternal(url: string): void;
  /** Hands a file to another app through the phone's share sheet. Absent in the app's earlier builds. */
  shareFile?(name: string, mime: string, base64: string): void;
}

function bridge(): AndroidBridge | undefined {
  return (window as unknown as { MinimalERPAndroid?: AndroidBridge }).MinimalERPAndroid;
}

export const isAndroidApp = (): boolean => bridge() !== undefined;

/** The latest signed build, published by .github/workflows/android.yml. */
export const ANDROID_APK_URL = 'https://github.com/MinimalERP/minimalERP/releases/latest/download/MinimalERP.apk';

/** On an Android phone in a browser (not already in the app): the sign-in page offers the app. */
export const offerAndroidApp = (): boolean => !isAndroidApp() && /Android/i.test(navigator.userAgent);

/** Files shared to the Android app since the page last asked (taken once). */
export function takeAndroidShares(): { name: string; type: string; base64: string }[] {
  const native = bridge();
  if (!native) return [];
  return JSON.parse(native.takeSharedFiles()) as { name: string; type: string; base64: string }[];
}

export function printPage(): void {
  const native = bridge();
  if (native) native.print(document.title);
  else window.print();
}

/** Inside the app: saved to Downloads and opened. Returns false in a browser, where the caller downloads as before. */
export function saveInApp(name: string, mime: string, bytes: Uint8Array): boolean {
  const native = bridge();
  if (!native) return false;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  native.saveFile(name, mime, btoa(binary));
  return true;
}

/** Whether this build of the app can hand a file to another app (an earlier build cannot: it is asked to update). */
export const canShareInApp = (): boolean => typeof bridge()?.shareFile === 'function';

/** Inside the app: the phone's share sheet (WhatsApp, mail, …) with the file. Returns false in a browser, or in a build that cannot. */
export function shareInApp(name: string, mime: string, base64: string): boolean {
  const native = bridge();
  if (!native || typeof native.shareFile !== 'function') return false;
  native.shareFile(name, mime, base64);
  return true;
}

/** Inside the app: opened in the phone's browser. Returns false in a browser. */
export function openInApp(url: string): boolean {
  const native = bridge();
  if (!native) return false;
  native.openExternal(url);
  return true;
}
