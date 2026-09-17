// TincNote Service Worker — Offline PWA & Asset Caching
const CACHE_NAME = 'tnote-cache-v1';
const STATIC_ASSETS = [
  '/notes/',
  '/notes/static/css/tinc_theme.css',
  '/notes/static/css/tnote.css',
  '/notes/static/js/tnote.js',
  '/notes/static/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Caching failed:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // API çağrılarını Service Worker önbelleğine almayıp arka plandaki IndexedDB/localStorage katmanına bırakıyoruz
  if (url.pathname.includes('/api/')) {
    return;
  }

  // Statik dosyalar ve sayfalar için Network First, Cache Fallback
  event.respondWith(
    fetch(req)
      .then(networkResponse => {
        if (networkResponse && networkResponse.status === 200 && req.method === 'GET') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(req, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(req).then(cachedResponse => {
          if (cachedResponse) {
            return cachedResponse;
          }
          if (req.mode === 'navigate') {
            return caches.match('/notes/');
          }
          return new Response('Çevrimdışı Mod', { status: 503, statusText: 'Offline' });
        });
      })
  );
});
