const CACHE_NAME = 'rio-das-mortes-v1';

const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './route-data.js',
  './tile-manifest.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (url.pathname.includes('/tiles/') || event.request.url.includes('unpkg.com/leaflet')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => new Response('', { status: 404 }));
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

self.addEventListener('message', event => {
  if (event.data.type === 'precache-tiles') {
    precacheTiles(event.data.tiles);
  }
});

async function precacheTiles(tileUrls) {
  const cache = await caches.open(CACHE_NAME);
  const clients = await self.clients.matchAll();
  let loaded = 0;
  let cached = 0;
  const total = tileUrls.length;
  const BATCH = 30;

  for (let i = 0; i < total; i += BATCH) {
    const batch = tileUrls.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async url => {
        const existing = await cache.match(url);
        if (existing) {
          cached++;
        } else {
          try {
            const resp = await fetch(url);
            if (resp.ok) await cache.put(url, resp);
          } catch (e) {}
        }
        loaded++;
      })
    );
    clients.forEach(c => c.postMessage({ type: 'cache-progress', loaded, cached, total }));
  }
  clients.forEach(c => c.postMessage({ type: 'cache-complete', loaded, cached, total }));
}
