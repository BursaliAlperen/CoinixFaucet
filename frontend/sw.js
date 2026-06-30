const CACHE = 'coinixfaucet-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { self.clients.claim(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('firestore') || e.request.url.includes('identitytoolkit')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
