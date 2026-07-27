/* Bump CACHE whenever URLS changes so the old entries get dropped on activate.
   The fetch handler is network-first, so these copies are an offline fallback,
   never the reason a stale file gets served. */
var CACHE = 'eden-grill-v2';
var URLS = ['/', '/index.html', '/print-menu.html', '/styles.css', '/printer.js', '/capacitor-bridge.js', '/menu.json', '/logo.png', '/manifest.json'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(URLS); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(function () { return caches.match(e.request); })
  );
});
