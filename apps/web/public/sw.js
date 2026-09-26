// MinimalERP's service worker: it makes the site installable as an app (Chrome › Install app) and nothing more. The books are online, so
// nothing is cached — every request goes to the network exactly as without it, and an update of the site is seen on the next load.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request));
});
