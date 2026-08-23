importScripts('./tile-manifest.js', './offline-recovery-engine.js');

// Refresh the write-pressure recovery code without changing the imagery cache identity.

const CACHE_NAME = 'rio-das-mortes-v13';
const CACHE_PREFIX = 'rio-das-mortes-v';

const APP_SHELL = [
  './',
  './index.html',
  './instrucoes.html',
  './app.js',
  './style.css?v=13',
  './route-data.js',
  './tile-manifest.js',
  './manifest.json',
  './rio-mortes-icon-192.png',
  './rio-mortes-icon-512.png',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (url.pathname.includes('/tiles/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => cache.match(event.request)).then(async cached => {
        if (cached) return cached;
        const previousPackageTile = await caches.match(event.request);
        if (previousPackageTile) return previousPackageTile;
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
    caches.open(CACHE_NAME).then(cache =>
      cache.match(event.request).then(cached => cached || fetch(event.request))
    )
  );
});

self.installOfflineRecovery({
  cacheName: CACHE_NAME,
  cachePrefix: CACHE_PREFIX,
  expectedPackageId: typeof TILE_PACKAGE_META !== 'undefined' ? TILE_PACKAGE_META.id : null,
  tilePathFragment: '/tiles/',
  getTileList
});
