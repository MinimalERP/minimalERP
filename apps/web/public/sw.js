// MinimalERP's service worker: it receives shared documents for the AI Inbox. The books are online, so nothing is cached — every other
// request goes to the network exactly as without it, and an update of the site is seen on the next load.
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  const shareUrl = new URL('share-target/', self.registration.scope);
  if (event.request.method === 'POST' && requestUrl.pathname.replace(/\/+$/, '') === shareUrl.pathname.replace(/\/+$/, '')) {
    event.respondWith(receiveSharedFiles(event.request));
  }
});

const SHARE_DB = 'minimalerp-shared-documents';
const SHARE_STORE = 'files';
const MAX_SHARED_FILE = 10 * 1024 * 1024;

function openShareDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(SHARE_STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function receiveSharedFiles(request) {
  let received = false;
  try {
    const form = await request.formData();
    // FormData file values can cross browser realms in installed PWAs, so do not rely on instanceof File.
    const files = [...form.values()].filter((value) => value && typeof value === 'object' && typeof value.size === 'number' && typeof value.slice === 'function' && value.size > 0 && value.size <= MAX_SHARED_FILE);
    // Resolve metadata before opening the transaction: awaiting inside an IndexedDB transaction can let it auto-commit.
    const records = await Promise.all(files.map(async (file) => ({
      id: crypto.randomUUID(),
      name: typeof file.name === 'string' && file.name ? file.name : 'shared-document.pdf',
      type: file.type && file.type !== 'application/octet-stream' ? file.type : await mimeFromFile(file),
      blob: file,
      receivedAt: Date.now(),
    })));
    const db = await openShareDb();
    try {
      const tx = db.transaction(SHARE_STORE, 'readwrite');
      const store = tx.objectStore(SHARE_STORE);
      for (const record of records) store.put(record);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      received = records.length > 0;
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Could not receive shared documents', error);
  }
  return Response.redirect(new URL(received ? '#/inbox?shared=1' : '#/inbox?shareError=1', self.registration.scope), 303);
}

async function mimeFromFile(file) {
  const named = mimeFromName(file.name);
  if (named !== 'application/octet-stream') return named;
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') return 'image/heic';
  return file.type || 'application/octet-stream';
}

function mimeFromName(name) {
  const ext = name.toLowerCase().split('.').pop();
  return ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' })[ext] || 'application/octet-stream';
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate' && event.request.method === 'GET') event.respondWith(fetch(event.request));
});
