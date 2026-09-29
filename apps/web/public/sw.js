// MinimalERP's service worker: it receives shared documents for the AI Inbox. The books are online, so nothing is cached — every other
// request goes to the network exactly as without it, and an update of the site is seen on the next load.
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  const shareUrl = new URL('share-target/', self.registration.scope);
  if (event.request.method === 'POST' && requestUrl.pathname === shareUrl.pathname) {
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
    const files = form.getAll('files').filter((value) => value instanceof File && value.size > 0 && value.size <= MAX_SHARED_FILE);
    const db = await openShareDb();
    try {
      const tx = db.transaction(SHARE_STORE, 'readwrite');
      const store = tx.objectStore(SHARE_STORE);
      for (const file of files) {
        store.put({
          id: crypto.randomUUID(),
          name: file.name || 'shared-document',
          type: file.type || 'application/octet-stream',
          blob: file,
          receivedAt: Date.now(),
        });
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      received = files.length > 0;
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Could not receive shared documents', error);
  }
  return Response.redirect(new URL(received ? '#/inbox' : '#/inbox?shareError=1', self.registration.scope), 303);
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate' && event.request.method === 'GET') event.respondWith(fetch(event.request));
});
