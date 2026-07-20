const CACHE = 'jarvis-v8';
const STATIC = ['/icon-192.png', '/icon-512.png', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Borrar TODOS los caches viejos
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.map(k => caches.delete(k)))
  ).then(() => caches.open(CACHE).then(c => c.addAll(STATIC))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (!STATIC.some(s => url.pathname === s)) return;
  // Manifest: network-first (si cambia el branding/nombre, que se vea al toque)
  if (url.pathname === '/manifest.json') {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Iconos: cache-first
  e.respondWith(
    caches.match(e.request).then(c => c || fetch(e.request))
  );
});
