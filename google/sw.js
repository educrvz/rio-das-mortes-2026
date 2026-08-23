importScripts('./tile-manifest.js');

const CACHE_NAME = 'rio-das-mortes-google-v3';
const CACHE_PREFIX = 'rio-das-mortes-google-';
const RECOVERY_STATE_VERSION = 1;
const RECOVERY_PHASES = new Set([
  'primary', 'recovery', 'waiting', 'verifying', 'exhausted', 'storage-blocked'
]);

const APP_SHELL = [
  './',
  './index.html',
  './instrucoes.html',
  './google-config.js',
  '../app.js',
  '../style.css?v=13',
  '../route-data.js',
  './tile-manifest.js',
  './manifest.json',
  './rio-mortes-google-icon-192.png',
  './rio-mortes-google-icon-512.png',
  '../vendor/leaflet/leaflet.css',
  '../vendor/leaflet/leaflet.js',
  '../vendor/leaflet/images/layers.png',
  '../vendor/leaflet/images/layers-2x.png',
  '../vendor/leaflet/images/marker-icon.png',
  '../vendor/leaflet/images/marker-icon-2x.png',
  '../vendor/leaflet/images/marker-shadow.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.includes('/google/tiles/')) {
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

let activePrecache = null;
const activeFetchControllers = new Set();

async function broadcast(message) {
  const currentClients = await self.clients.matchAll();
  currentClients.forEach(client => client.postMessage(message));
}

self.addEventListener('message', event => {
  if (event.data.type !== 'precache-tiles') return;
  activeFetchControllers.forEach(controller => controller.abort());
  const run = () => precacheTiles(event.data.packageId, event.data.expectedCount);
  const queued = (activePrecache || Promise.resolve()).then(run, run);
  const tracked = queued.finally(() => {
    if (activePrecache === tracked) {
      activePrecache = null;
    }
  });
  activePrecache = tracked;
  event.waitUntil(tracked);
});

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  activeFetchControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    activeFetchControllers.delete(controller);
  }
}

async function removeSupersededCaches() {
  const keys = await caches.keys();
  await Promise.all(
    keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key))
  );
}

function newRecoveryState(packageId, total) {
  return {
    version: RECOVERY_STATE_VERSION,
    packageId,
    total,
    cursor: 0,
    phase: 'primary',
    failed: []
  };
}

function normalizedFailures(entries, requiredUrls) {
  const deduplicated = new Map();
  if (!Array.isArray(entries)) return [];
  entries.forEach(entry => {
    if (!entry || typeof entry.url !== 'string' || !requiredUrls.has(entry.url)) return;
    if (!Number.isInteger(entry.attempts) || entry.attempts < 0) return;
    if (!Number.isFinite(entry.nextAttemptAt) || entry.nextAttemptAt < 0) return;
    const previous = deduplicated.get(entry.url);
    deduplicated.set(entry.url, {
      url: entry.url,
      attempts: Math.max(previous?.attempts || 0, entry.attempts),
      nextAttemptAt: Math.max(previous?.nextAttemptAt || 0, entry.nextAttemptAt)
    });
  });
  return [...deduplicated.values()];
}

async function writeRecoveryState(cache, progressUrl, state) {
  await cache.put(progressUrl, new Response(JSON.stringify(state), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function readRecoveryState(cache, progressUrl, packageId, total, tileUrls) {
  const fresh = () => newRecoveryState(packageId, total);
  const response = await cache.match(progressUrl);
  if (!response) return fresh();
  try {
    const saved = await response.json();
    const validCursor = Number.isInteger(saved.cursor) && saved.cursor >= 0 && saved.cursor <= total;
    if (saved.version === undefined && saved.total === total && validCursor) {
      const migrated = fresh();
      migrated.cursor = saved.cursor;
      await writeRecoveryState(cache, progressUrl, migrated);
      return migrated;
    }
    if (
      saved.version !== RECOVERY_STATE_VERSION
      || saved.packageId !== packageId
      || saved.total !== total
      || !validCursor
      || !RECOVERY_PHASES.has(saved.phase)
      || !Array.isArray(saved.failed)
    ) {
      throw new Error('invalid recovery state');
    }
    const requiredUrls = new Set(tileUrls);
    saved.failed = normalizedFailures(saved.failed, requiredUrls);
    await writeRecoveryState(cache, progressUrl, saved);
    return saved;
  } catch (error) {
    await cache.delete(progressUrl);
    return fresh();
  }
}

function recordFailure(state, url) {
  const existing = state.failed.find(entry => entry.url === url);
  if (existing) {
    existing.attempts += 1;
    existing.nextAttemptAt = Date.now();
  } else {
    state.failed.push({ url, attempts: 1, nextAttemptAt: Date.now() });
  }
}

function clearFailure(state, url) {
  state.failed = state.failed.filter(entry => entry.url !== url);
}

async function precacheTiles(packageId, expectedCount) {
  const cache = await caches.open(CACHE_NAME);
  const tileUrls = getTileList();
  const total = tileUrls.length;
  if (total !== expectedCount) {
    await broadcast({ type: 'cache-incomplete', loaded: 0, stored: 0, failed: total, total });
    return;
  }
  const activePackageId = packageId || 'current';
  const markerUrl = new URL(
    `offline-package-${encodeURIComponent(activePackageId)}.ready`,
    self.registration.scope
  ).href;
  const progressUrl = new URL(
    `offline-package-${encodeURIComponent(activePackageId)}.progress`,
    self.registration.scope
  ).href;
  const requiredTileUrls = tileUrls.map(url => new URL(url, self.registration.scope).href);
  const requiredTileSet = new Set(requiredTileUrls);
  const relativeTileByUrl = new Map(requiredTileUrls.map((url, index) => [url, tileUrls[index]]));
  const ready = await cache.match(markerUrl);
  if (ready) {
    const keys = await cache.keys();
    const storedTileUrls = new Set(
      keys.map(request => request.url).filter(url => new URL(url).pathname.includes('/google/tiles/'))
    );
    const exactPackage = storedTileUrls.size === total
      && requiredTileUrls.every(url => storedTileUrls.has(url));
    if (exactPackage) {
      await broadcast({ type: 'cache-complete', loaded: total, stored: total, reused: total, total });
      await removeSupersededCaches();
      return;
    }
    await cache.delete(markerUrl);
    await Promise.all(
      keys.filter(request =>
        new URL(request.url).pathname.includes('/google/tiles/') && !requiredTileSet.has(request.url)
      )
        .map(request => cache.delete(request))
    );
  } else {
    const keys = await cache.keys();
    const obsoleteMarkers = keys.filter(request =>
      new URL(request.url).pathname.includes('/offline-package-')
      && request.url !== markerUrl
      && request.url !== progressUrl
    );
    const obsoleteReadyPackage = obsoleteMarkers.some(request => request.url.endsWith('.ready'));
    if (obsoleteReadyPackage) {
      await Promise.all(keys.filter(request => {
        const pathname = new URL(request.url).pathname;
        return pathname.includes('/google/tiles/') || pathname.includes('/offline-package-');
      }).map(request => cache.delete(request)));
    } else if (obsoleteMarkers.length) {
      await Promise.all(obsoleteMarkers.map(request => cache.delete(request)));
    }
  }

  const state = await readRecoveryState(
    cache, progressUrl, activePackageId, total, tileUrls
  );
  let workCursor = state.cursor;
  if (state.cursor === total && state.failed.length) {
    const failedUrls = new Set(state.failed.map(entry => entry.url));
    const firstFailed = tileUrls.findIndex(url => failedUrls.has(url));
    if (firstFailed >= 0) workCursor = firstFailed;
  }
  let loaded = workCursor;
  let stored = Math.max(0, workCursor - state.failed.length);
  let reused = 0;
  const BATCH = 20;
  const CHUNK_SIZE = 200;
  if (workCursor > 0) {
    await broadcast({
      type: 'cache-progress', loaded, stored, reused: stored,
      failed: state.failed.length, total
    });
  }
  const chunkEnd = Math.min(workCursor + CHUNK_SIZE, total);
  for (let i = workCursor; i < chunkEnd; i += BATCH) {
    const batch = tileUrls.slice(i, Math.min(i + BATCH, chunkEnd));
    await Promise.allSettled(batch.map(async url => {
      const existing = await cache.match(url);
      if (existing) {
        stored++;
        reused++;
        clearFailure(state, url);
      } else {
        try {
          const response = await fetchWithTimeout(url);
          if (response.ok) {
            await cache.put(url, response);
            stored++;
            clearFailure(state, url);
          } else recordFailure(state, url);
        } catch (error) {
          recordFailure(state, url);
        }
      }
      loaded++;
    }));
    state.cursor = Math.max(state.cursor, i + batch.length);
    state.phase = state.cursor < total ? 'primary' : 'verifying';
    await writeRecoveryState(cache, progressUrl, state);
    await broadcast({
      type: 'cache-progress', loaded: state.cursor, stored, reused,
      failed: state.failed.length, total
    });
  }

  if (state.cursor < total) {
    await broadcast({
      type: 'cache-chunk-complete', loaded: state.cursor, stored, reused,
      failed: state.failed.length, total
    });
    return;
  }

  state.phase = 'verifying';
  await writeRecoveryState(cache, progressUrl, state);
  const keys = await cache.keys();
  const tileRequests = keys.filter(request =>
    new URL(request.url).pathname.includes('/google/tiles/')
  );
  const storedTileUrls = new Set(tileRequests.map(request => request.url));
  await Promise.all(
    tileRequests.filter(request => !requiredTileSet.has(request.url))
      .map(request => cache.delete(request))
  );
  const missingUrls = requiredTileUrls.filter(url => !storedTileUrls.has(url));
  const missingRelativeUrls = new Set(
    missingUrls.map(url => relativeTileByUrl.get(url))
  );
  state.failed = state.failed.filter(entry => missingRelativeUrls.has(entry.url));
  missingRelativeUrls.forEach(url => {
    if (!state.failed.some(entry => entry.url === url)) {
      state.failed.push({ url, attempts: 0, nextAttemptAt: 0 });
    }
  });

  if (missingUrls.length === 0) {
    await cache.put(markerUrl, new Response('ready', { headers: { 'Content-Type': 'text/plain' } }));
    await cache.delete(progressUrl);
    await removeSupersededCaches();
    await broadcast({
      type: 'cache-complete', loaded: total, stored: total,
      reused, failed: 0, total
    });
  } else {
    state.phase = 'recovery';
    await writeRecoveryState(cache, progressUrl, state);
    const attemptedFailure = state.failed.some(entry => entry.attempts > 0);
    const firstMissing = requiredTileUrls.findIndex(url => !storedTileUrls.has(url));
    await broadcast(attemptedFailure ? {
      type: 'cache-incomplete', loaded: total,
      stored: total - missingUrls.length, reused,
      failed: state.failed.length, total
    } : {
      type: 'cache-chunk-complete', loaded: firstMissing,
      stored: total - missingUrls.length, reused,
      failed: 0, total
    });
  }
}
