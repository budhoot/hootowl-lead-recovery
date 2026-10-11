const CACHE = 'hootowl-portal-shell-v1';
const ASSETS = ['/portal/offline.html', '/portal/style.css', '/portal/theme.css', '/portal/icon-192.png', '/portal/icon-512.png'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('hootowl-portal-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
 const url = new URL(event.request.url);
 // Never cache account requests, API responses, invitations, or conversations.
 if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/portal/api/')) return;
 if (event.request.mode === 'navigate') {
  event.respondWith(fetch(event.request).catch(() => caches.match('/portal/offline.html')));
 } else if (ASSETS.includes(url.pathname) && !url.search) {
  event.respondWith(fetch(event.request).catch(() => caches.match(url.pathname)));
 }
});
