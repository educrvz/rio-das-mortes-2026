(function () {
  'use strict';

  // This intentionally follows the field-proven Pindaiba downloader:
  // Cache Storage itself is the checkpoint. Every pass checks each tile,
  // skips what is already present, and downloads only what is missing.
  const BATCH_SIZE = 30;

  function isQuotaError(error) {
    return error?.name === 'QuotaExceededError';
  }

  self.installOfflineRecovery = function installOfflineRecovery(config) {
    const { cacheName, cachePrefix, getTileList, expectedPackageId } = config;
    let activeOrdinaryRun = null;

    function manifestForScope() {
      const tileUrls = getTileList();
      return {
        total: tileUrls.length,
        requiredUrls: tileUrls.map(url => new URL(url, self.registration.scope).href)
      };
    }

    async function broadcast(message) {
      const clients = await self.clients.matchAll();
      clients.forEach(client => client.postMessage(message));
    }

    async function removeSupersededCaches() {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key.startsWith(cachePrefix) && key !== cacheName)
          .map(key => caches.delete(key)));
      } catch (_) {
        // Cleanup is optional and must never stop an otherwise complete map.
      }
    }

    async function cacheOne(cache, url) {
      try {
        if (await cache.match(url)) return { stored: true };
      } catch (_) {
        // A transient Cache API read failure is treated as a cache miss.
      }

      try {
        const response = await fetch(url);
        if (!response.ok) return { stored: false };
        try {
          await cache.put(url, response);
          return { stored: true };
        } catch (error) {
          if (isQuotaError(error)) return { stored: false, quotaBlocked: true };
          // Brave can reject an individual response body with AbortError.
          // Match Pindaiba: leave that tile missing and continue the batch.
          return { stored: false };
        }
      } catch (_) {
        // Network failures remain missing and are retried by the next pass.
        return { stored: false };
      }
    }

    async function runPass(packageId, expectedCount) {
      const { total, requiredUrls } = manifestForScope();
      if (total !== expectedCount) {
        await broadcast({
          type: 'cache-incomplete', packageId,
          loaded: 0, stored: 0, failed: total, total
        });
        return;
      }

      let cache;
      try {
        cache = await caches.open(cacheName);
      } catch (_) {
        await broadcast({
          type: 'cache-recovery-exhausted', packageId,
          loaded: 0, stored: 0, failed: total, total
        });
        return;
      }

      let loaded = 0;
      let stored = 0;
      let failed = 0;

      for (let index = 0; index < requiredUrls.length; index += BATCH_SIZE) {
        const batch = requiredUrls.slice(index, index + BATCH_SIZE);
        const outcomes = await Promise.allSettled(batch.map(url => cacheOne(cache, url)));
        let quotaBlocked = false;

        outcomes.forEach(outcome => {
          loaded += 1;
          if (outcome.status === 'fulfilled' && outcome.value.stored) stored += 1;
          else failed += 1;
          if (outcome.status === 'fulfilled' && outcome.value.quotaBlocked) quotaBlocked = true;
        });

        await broadcast({
          type: 'cache-progress', packageId,
          loaded, stored, failed, total
        });

        if (quotaBlocked) {
          await broadcast({
            type: 'storage-blocked', packageId,
            loaded, stored, failed, total
          });
          return;
        }
      }

      if (stored !== total) {
        await broadcast({
          type: 'cache-recovery-exhausted', packageId,
          loaded, stored, failed, total
        });
        return;
      }

      const markerUrl = new URL(
        `offline-package-${encodeURIComponent(packageId)}.ready`, self.registration.scope
      ).href;
      try {
        await cache.put(markerUrl, new Response('ready', {
          headers: { 'Content-Type': 'text/plain' }
        }));
      } catch (error) {
        await broadcast({
          type: isQuotaError(error) ? 'storage-blocked' : 'cache-recovery-exhausted',
          packageId, loaded: total, stored: total, failed: 0, total
        });
        return;
      }

      // Remove only the obsolete internal checkpoint from the former engine.
      // Tile cache identity is unchanged, so an existing partial download survives.
      const oldProgressUrl = new URL(
        `offline-package-${encodeURIComponent(packageId)}.progress`, self.registration.scope
      ).href;
      try { await cache.delete(oldProgressUrl); } catch (_) {}
      await removeSupersededCaches();
      await broadcast({
        type: 'cache-complete', packageId,
        loaded: total, stored: total, failed: 0, total
      });
    }

    self.addEventListener('message', event => {
      if (event.data?.type !== 'precache-tiles') return;
      const packageId = event.data.packageId || 'current';
      const total = Number.isInteger(event.data.expectedCount) ? event.data.expectedCount : 0;

      if (expectedPackageId && packageId !== expectedPackageId) {
        event.waitUntil(broadcast({
          type: 'package-mismatch', packageId, expectedPackageId,
          loaded: 0, stored: 0, failed: 0, total
        }));
        return;
      }

      // Normal lifecycle events share one pass. A manual continuation starts a
      // fresh Pindaiba-style scan even if an older network request is stuck.
      if (!event.data.forceRetry && activeOrdinaryRun) {
        event.waitUntil(activeOrdinaryRun);
        return;
      }

      const run = runPass(packageId, total);
      if (!event.data.forceRetry) {
        let trackedRun;
        trackedRun = run.finally(() => {
          if (activeOrdinaryRun === trackedRun) activeOrdinaryRun = null;
        });
        activeOrdinaryRun = trackedRun;
        event.waitUntil(trackedRun);
      } else {
        event.waitUntil(run);
      }
    });
  };
})();
