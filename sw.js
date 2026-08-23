importScripts('./tile-manifest.js');

const CACHE_NAME = 'rio-das-mortes-v10';
const CACHE_PREFIX = 'rio-das-mortes-';

const APP_SHELL = [
  './',
  './index.html',
  './instrucoes.html',
  './app.js',
  './style.css?v=10',
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
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (url.pathname.includes('/tiles/')) {
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

let activePrecache = null;
let activePackageId = null;

async function broadcast(message) {
  const currentClients = await self.clients.matchAll();
  currentClients.forEach(client => client.postMessage(message));
}

self.addEventListener('message', event => {
  if (event.data.type === 'precache-tiles') {
    if (activePrecache && activePackageId === event.data.packageId) {
      event.waitUntil(activePrecache);
      return;
    }
    const run = () => precacheTiles(event.data.packageId, event.data.expectedCount);
    const queued = (activePrecache || Promise.resolve()).then(run, run);
    const tracked = queued.finally(() => {
      if (activePrecache === tracked) {
        activePrecache = null;
        activePackageId = null;
      }
    });
    activePrecache = tracked;
    activePackageId = event.data.packageId;
    event.waitUntil(tracked);
  }
});

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function precacheTiles(packageId, expectedCount) {
  const cache = await caches.open(CACHE_NAME);
  const tileUrls = getTileList();
  const total = tileUrls.length;
  if (total !== expectedCount) {
    await broadcast({
      type: 'cache-incomplete', loaded: 0, stored: 0, failed: total, total
    });
    return;
  }
  const markerUrl = new URL(
    `offline-package-${encodeURIComponent(packageId || 'current')}.ready`,
    self.registration.scope
  ).href;
  const ready = await cache.match(markerUrl);
  if (ready) {
    const keys = await cache.keys();
    const storedTileUrls = new Set(
      keys
        .map(request => request.url)
        .filter(url => new URL(url).pathname.includes('/tiles/'))
    );
    const requiredTileUrls = tileUrls.map(url => new URL(url, self.registration.scope).href);
    const exactPackage = storedTileUrls.size === total
      && requiredTileUrls.every(url => storedTileUrls.has(url));
    if (exactPackage) {
      await broadcast({
        type: 'cache-complete', loaded: total, stored: total, reused: total, total
      });
      return;
    }
    await cache.delete(markerUrl);
    const required = new Set(requiredTileUrls);
    await Promise.all(
      keys
        .filter(request => new URL(request.url).pathname.includes('/tiles/') && !required.has(request.url))
        .map(request => cache.delete(request))
    );
  } else {
    const keys = await cache.keys();
    const obsoletePackage = keys.some(request =>
      new URL(request.url).pathname.includes('/offline-package-')
    );
    if (obsoletePackage) {
      await Promise.all(keys.filter(request => {
        const pathname = new URL(request.url).pathname;
        return pathname.includes('/tiles/') || pathname.includes('/offline-package-');
      }).map(request => cache.delete(request)));
    }
  }

  let loaded = 0;
  let stored = 0;
  let reused = 0;
  let failed = 0;
  const BATCH = 20;

  for (let i = 0; i < total; i += BATCH) {
    const batch = tileUrls.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async url => {
        const existing = await cache.match(url);
        if (existing) {
          stored++;
          reused++;
        } else {
          try {
            const resp = await fetchWithTimeout(url);
            if (resp.ok) {
              await cache.put(url, resp);
              stored++;
            } else {
              failed++;
            }
          } catch (e) {
            failed++;
          }
        }
        loaded++;
      })
    );
    await broadcast({ type: 'cache-progress', loaded, stored, reused, failed, total });
  }

  if (failed === 0 && stored === total) {
    await cache.put(markerUrl, new Response('ready', { headers: { 'Content-Type': 'text/plain' } }));
    await broadcast({ type: 'cache-complete', loaded, stored, reused, failed, total });
  } else {
    await broadcast({ type: 'cache-incomplete', loaded, stored, reused, failed, total });
  }
}
