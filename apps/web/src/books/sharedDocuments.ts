const DB_NAME = 'minimalerp-shared-documents';
const STORE_NAME = 'files';
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

interface StoredSharedDocument {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly blob: Blob;
  readonly receivedAt: number;
}

export interface SharedDocument {
  readonly id: string;
  readonly file: File;
}

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop();
  return MIME_BY_EXTENSION[ext ?? ''] ?? 'application/octet-stream';
}

async function readableMime(blob: Blob, name: string, type: string): Promise<string> {
  if (type && type !== 'application/octet-stream') return type;
  const named = mimeFromName(name);
  if (named !== 'application/octet-stream') return named;
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') return 'image/heic';
  return type || 'application/octet-stream';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Shared files stay on this device until their owner submits them to the AI reader. */
export async function sharedDocuments(): Promise<SharedDocument[]> {
  const db = await openDb();
  try {
    const records = await new Promise<StoredSharedDocument[]>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as StoredSharedDocument[]);
      request.onerror = () => reject(request.error);
    });
    return Promise.all(records
      .sort((a, b) => a.receivedAt - b.receivedAt)
      .map(async (record) => ({ id: record.id, file: new File([record.blob], record.name, { type: await readableMime(record.blob, record.name, record.type) }) })));
  } finally {
    db.close();
  }
}

export async function removeSharedDocument(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** What the service worker last received from a share (written by public/sw.js), taken once. */
export interface ShareReceipt {
  readonly at: number;
  readonly fields: number;
  readonly files: number;
  readonly error: string;
}

export async function takeShareReceipt(): Promise<ShareReceipt | undefined> {
  if (typeof caches === 'undefined') return undefined;
  const cache = await caches.open('minimalerp-share-receipt');
  const response = await cache.match('/__share-receipt');
  if (!response) return undefined;
  await cache.delete('/__share-receipt');
  return (await response.json()) as ShareReceipt;
}
