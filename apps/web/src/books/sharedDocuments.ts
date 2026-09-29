const DB_NAME = 'minimalerp-shared-documents';
const STORE_NAME = 'files';

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
    return records
      .sort((a, b) => a.receivedAt - b.receivedAt)
      .map((record) => ({ id: record.id, file: new File([record.blob], record.name, { type: record.type }) }));
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
