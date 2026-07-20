const CACHE = 'jarvis-v7';
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
  // Todo lo que no sean iconos/manifest: siempre red, nunca cache
  if (!STATIC.some(s => url.pathname === s)) return;
  // Iconos/manifest: cache-first
  e.respondWith(
    caches.match(e.request).then(c => c || fetch(e.request))
  );
});
