(function () {
  'use strict';

  const STATE_VERSION = 1;
  const PHASES = new Set([
    'primary', 'recovery', 'waiting', 'verifying', 'exhausted', 'storage-blocked'
  ]);
  const CHUNK_SIZE = 200;
  const RETRY_SHARE = 50;
  const WINDOW_SIZE = 20;
  const INITIAL_CONCURRENCY = 6;
  const MIN_CONCURRENCY = 2;
  const MAX_CONCURRENCY = 12;
  const MAX_ATTEMPTS = 4;
  const INTEGRITY_ATTEMPTS = 2;
  const PROBE_DELAYS = [5_000, 15_000, 45_000];

  const now = () => self.__offlineRecoveryTest?.now?.() ?? Date.now();
  const random = () => self.__offlineRecoveryTest?.random?.() ?? Math.random();

  function freshState(packageId, total) {
    return {
      version: STATE_VERSION,
      packageId,
      total,
      cursor: 0,
      stored: null,
      phase: 'primary',
      failed: [],
      onlineRecoveryUsed: false,
      circuit: { open: false, highFailureWindows: 0, probeIndex: 0, nextProbeAt: 0 }
    };
  }

  function normalizeCircuit(value) {
    if (!value || typeof value !== 'object') {
      return { open: false, highFailureWindows: 0, probeIndex: 0, nextProbeAt: 0 };
    }
    return {
      open: Boolean(value.open),
      highFailureWindows: Number.isInteger(value.highFailureWindows)
        ? Math.max(0, Math.min(2, value.highFailureWindows)) : 0,
      probeIndex: Number.isInteger(value.probeIndex)
        ? Math.max(0, Math.min(PROBE_DELAYS.length, value.probeIndex)) : 0,
      nextProbeAt: Number.isFinite(value.nextProbeAt) && value.nextProbeAt >= 0
        ? value.nextProbeAt : 0
    };
  }

  function normalizeFailures(entries, requiredUrls) {
    const deduplicated = new Map();
    if (!Array.isArray(entries)) return [];
    entries.forEach(entry => {
      if (!entry || typeof entry.url !== 'string' || !requiredUrls.has(entry.url)) return;
      if (!Number.isInteger(entry.attempts) || entry.attempts < 0) return;
      if (!Number.isFinite(entry.nextAttemptAt) || entry.nextAttemptAt < 0) return;
      const previous = deduplicated.get(entry.url);
      const candidate = {
        url: entry.url,
        attempts: entry.attempts,
        nextAttemptAt: entry.nextAttemptAt,
        kind: entry.kind === 'integrity' ? 'integrity' : 'retryable',
        terminal: Boolean(entry.terminal),
        status: Number.isInteger(entry.status) ? entry.status : null
      };
      if (!previous || candidate.attempts > previous.attempts) {
        deduplicated.set(entry.url, candidate);
      } else if (candidate.attempts === previous.attempts) {
        previous.nextAttemptAt = Math.max(previous.nextAttemptAt, candidate.nextAttemptAt);
        previous.terminal ||= candidate.terminal;
        if (candidate.kind === 'integrity') previous.kind = 'integrity';
        if (candidate.status !== null) previous.status = candidate.status;
      }
    });
    return [...deduplicated.values()];
  }

  async function writeState(cache, progressUrl, state) {
    await cache.put(progressUrl, new Response(JSON.stringify(state), {
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  async function initializeStored(cache, state, requiredUrls) {
    if (Number.isInteger(state.stored) && state.stored >= 0 && state.stored <= state.total) return;
    const requiredSet = new Set(requiredUrls);
    const keys = await cache.keys();
    state.stored = keys.reduce(
      (count, request) => count + (requiredSet.has(request.url) ? 1 : 0), 0
    );
  }

  async function readState(cache, progressUrl, packageId, total, tileUrls, requiredUrls) {
    const response = await cache.match(progressUrl);
    if (!response) {
      const fresh = freshState(packageId, total);
      await initializeStored(cache, fresh, requiredUrls);
      return fresh;
    }
    try {
      const saved = await response.json();
      const validCursor = Number.isInteger(saved.cursor) && saved.cursor >= 0 && saved.cursor <= total;
      if (saved.version === undefined && saved.total === total && validCursor) {
        const migrated = freshState(packageId, total);
        migrated.cursor = saved.cursor;
        await initializeStored(cache, migrated, requiredUrls);
        await writeState(cache, progressUrl, migrated);
        return migrated;
      }
      if (
        saved.version !== STATE_VERSION || saved.packageId !== packageId || saved.total !== total
        || !validCursor || !PHASES.has(saved.phase) || !Array.isArray(saved.failed)
      ) throw new Error('invalid recovery state');
      saved.failed = normalizeFailures(saved.failed, new Set(tileUrls));
      saved.onlineRecoveryUsed = Boolean(saved.onlineRecoveryUsed);
      saved.circuit = normalizeCircuit(saved.circuit);
      await initializeStored(cache, saved, requiredUrls);
      await writeState(cache, progressUrl, saved);
      return saved;
    } catch (error) {
      await cache.delete(progressUrl);
      const fresh = freshState(packageId, total);
      await initializeStored(cache, fresh, requiredUrls);
      return fresh;
    }
  }

  function failureFor(state, url) {
    return state.failed.find(entry => entry.url === url);
  }

  function clearFailure(state, url) {
    state.failed = state.failed.filter(entry => entry.url !== url);
  }

  function retryDelay(attempts, retryAfter) {
    const base = Math.min(30_000, 1_000 * (2 ** Math.max(0, attempts - 1)));
    const jittered = Math.round(base * (0.8 + (0.4 * random())));
    return Math.max(jittered, retryAfter || 0);
  }

  function parseRetryAfter(response) {
    const value = response.headers.get('Retry-After');
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now()) : 0;
  }

  function recordFailure(state, url, outcome) {
    let entry = failureFor(state, url);
    if (!entry) {
      entry = { url, attempts: 0, nextAttemptAt: 0, kind: 'retryable', terminal: false, status: null };
      state.failed.push(entry);
    }
    entry.attempts += 1;
    entry.status = outcome.status || null;
    if (outcome.kind === 'integrity') {
      entry.kind = 'integrity';
      entry.terminal = entry.attempts >= INTEGRITY_ATTEMPTS;
      entry.nextAttemptAt = entry.terminal ? 0 : now() + retryDelay(entry.attempts, 0);
    } else if (outcome.kind === 'nonretryable') {
      entry.kind = 'integrity';
      entry.terminal = true;
      entry.nextAttemptAt = 0;
    } else {
      entry.kind = 'retryable';
      entry.terminal = false;
      entry.nextAttemptAt = entry.attempts >= MAX_ATTEMPTS
        ? 0 : now() + retryDelay(entry.attempts, outcome.retryAfter);
    }
    return entry;
  }

  function resetRetryableBudgets(state) {
    state.failed.forEach(entry => {
      if (!entry.terminal && entry.kind === 'retryable') {
        entry.attempts = 0;
        entry.nextAttemptAt = now();
        entry.status = null;
      }
    });
    state.circuit = normalizeCircuit(null);
    state.phase = state.cursor < state.total ? 'primary' : 'recovery';
  }

  function isQuotaError(error) {
    return error?.name === 'QuotaExceededError';
  }

  function classifyResponse(response) {
    if (response.ok) return { kind: 'success' };
    if (response.status === 404 || response.status === 410) {
      return { kind: 'integrity', status: response.status };
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return {
        kind: response.status === 429 ? 'rate-limit' : 'retryable',
        status: response.status,
        retryAfter: parseRetryAfter(response)
      };
    }
    return { kind: 'nonretryable', status: response.status };
  }

  self.installOfflineRecovery = function installOfflineRecovery(config) {
    const { cacheName, cachePrefix, tilePathFragment, getTileList } = config;
    let active = null;
    const controllers = new Set();
    const runtimeByPackage = new Map();
    let manifestSnapshot = null;

    function manifestForScope() {
      if (manifestSnapshot) return manifestSnapshot;
      const tileUrls = getTileList();
      const requiredUrls = tileUrls.map(url => new URL(url, self.registration.scope).href);
      manifestSnapshot = {
        tileUrls,
        total: tileUrls.length,
        requiredUrls,
        requiredSet: new Set(requiredUrls)
      };
      return manifestSnapshot;
    }

    async function broadcast(message) {
      const clients = await self.clients.matchAll();
      clients.forEach(client => client.postMessage(message));
    }

    async function fetchWithTimeout(url, timeoutMs = 15_000) {
      const controller = new AbortController();
      const metadata = { controller, forced: false, timedOut: false };
      controllers.add(metadata);
      const timeout = setTimeout(() => {
        metadata.timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        return await fetch(url, { signal: controller.signal });
      } catch (error) {
        if (metadata.forced) throw { recoveryKind: 'aborted', cause: error };
        if (metadata.timedOut) throw { recoveryKind: 'timeout', cause: error };
        throw { recoveryKind: 'network', cause: error };
      } finally {
        clearTimeout(timeout);
        controllers.delete(metadata);
      }
    }

    function abortActive() {
      controllers.forEach(metadata => {
        metadata.forced = true;
        metadata.controller.abort();
      });
    }

    async function removeSupersededCaches() {
      const keys = await caches.keys();
      await Promise.all(keys.filter(key => key.startsWith(cachePrefix) && key !== cacheName)
        .map(key => caches.delete(key)));
    }

    function runtimeFor(packageId) {
      if (!runtimeByPackage.has(packageId)) {
        runtimeByPackage.set(packageId, {
          concurrency: INITIAL_CONCURRENCY,
          cleanWindows: 0,
          completed: 0,
          retryableFailures: 0,
          networkTimeoutFailures: 0,
          pressure: false,
          pressureAdjusted: false
        });
      }
      return runtimeByPackage.get(packageId);
    }

    function resetWindow(runtime) {
      runtime.completed = 0;
      runtime.retryableFailures = 0;
      runtime.networkTimeoutFailures = 0;
      runtime.pressure = false;
      runtime.pressureAdjusted = false;
    }

    function registerOutcome(runtime, state, outcome) {
      if (outcome.cached || outcome.aborted || outcome.storageBlocked) return false;
      runtime.completed += 1;
      if (['retryable', 'rate-limit', 'timeout', 'network'].includes(outcome.kind)) {
        runtime.retryableFailures += 1;
      }
      if (outcome.kind === 'network' || outcome.kind === 'timeout') {
        runtime.networkTimeoutFailures += 1;
      }
      if (outcome.kind === 'timeout' || outcome.kind === 'rate-limit') {
        runtime.pressure = true;
        if (!runtime.pressureAdjusted) {
          runtime.concurrency = Math.max(MIN_CONCURRENCY, Math.floor(runtime.concurrency / 2));
          runtime.cleanWindows = 0;
          runtime.pressureAdjusted = true;
        }
      }
      if (runtime.completed < WINDOW_SIZE) return false;

      const retryableRatio = runtime.retryableFailures / WINDOW_SIZE;
      if (runtime.pressure || retryableRatio >= 0.1) {
        if (!runtime.pressureAdjusted) {
          runtime.concurrency = Math.max(MIN_CONCURRENCY, Math.floor(runtime.concurrency / 2));
        }
        runtime.cleanWindows = 0;
      } else if (runtime.retryableFailures === 0) {
        runtime.cleanWindows += 1;
        if (runtime.cleanWindows >= 3) {
          runtime.concurrency = Math.min(MAX_CONCURRENCY, runtime.concurrency + 1);
          runtime.cleanWindows = 0;
        }
      } else {
        runtime.cleanWindows = 0;
      }

      if ((runtime.networkTimeoutFailures / WINDOW_SIZE) >= 0.75) {
        state.circuit.highFailureWindows += 1;
      } else {
        state.circuit.highFailureWindows = 0;
      }
      if (state.circuit.highFailureWindows >= 2) {
        state.circuit.open = true;
        state.circuit.probeIndex = 0;
        state.circuit.nextProbeAt = now() + PROBE_DELAYS[0];
      }
      resetWindow(runtime);
      return state.circuit.open;
    }

    async function requestTile(cache, state, item) {
      const existing = await cache.match(item.url);
      if (existing) {
        clearFailure(state, item.url);
        return { kind: 'success', cached: true, advance: true };
      }
      try {
        const response = await fetchWithTimeout(item.url);
        const classification = classifyResponse(response);
        if (classification.kind === 'success') {
          try {
            await cache.put(item.url, response);
          } catch (error) {
            if (isQuotaError(error)) return { storageBlocked: true, kind: 'storage', advance: false };
            throw error;
          }
          state.stored = Math.min(state.total, state.stored + 1);
          clearFailure(state, item.url);
          return { kind: 'success', advance: true };
        }
        recordFailure(state, item.url, classification);
        return { ...classification, advance: true };
      } catch (error) {
        if (error?.recoveryKind === 'aborted') return { kind: 'aborted', aborted: true, advance: false };
        const kind = error?.recoveryKind === 'timeout' ? 'timeout' : 'network';
        recordFailure(state, item.url, { kind });
        return { kind, advance: true };
      }
    }

    async function runWork(cache, progressUrl, state, work, runtime) {
      let position = 0;
      let primaryAdvanced = 0;
      let storageBlocked = false;
      while (position < work.length && !state.circuit.open && !storageBlocked) {
        const remainingInWindow = WINDOW_SIZE - runtime.completed;
        const size = Math.min(runtime.concurrency, remainingInWindow, work.length - position);
        const batch = work.slice(position, position + size);
        const outcomes = await Promise.all(batch.map(item => requestTile(cache, state, item)));
        for (let index = 0; index < outcomes.length; index++) {
          const outcome = outcomes[index];
          if (outcome.storageBlocked) storageBlocked = true;
          if (batch[index].primary && outcome.advance && primaryAdvanced === batch[index].primaryOffset) {
            primaryAdvanced += 1;
          }
          registerOutcome(runtime, state, outcome);
        }
        position += batch.length;
        state.cursor += primaryAdvanced;
        work.forEach(item => { if (item.primary) item.primaryOffset -= primaryAdvanced; });
        primaryAdvanced = 0;
        state.phase = storageBlocked ? 'storage-blocked'
          : state.cursor < state.total ? 'primary' : 'verifying';
        await writeState(cache, progressUrl, state);
        await broadcast({
          type: 'cache-progress', loaded: state.cursor, stored: state.stored, failed: state.failed.length,
          total: state.total, concurrency: runtime.concurrency
        });
      }
      return { storageBlocked };
    }

    async function handleOpenCircuit(cache, progressUrl, state, tileUrls, runtime) {
      if (!state.circuit.open) return true;
      if (now() < state.circuit.nextProbeAt) return false;
      let healthy = false;
      try {
        const response = await fetchWithTimeout(tileUrls[0]);
        // Any ordinary HTTP response proves that the network path is back.
        // Let normal tile classification surface 404/410 integrity failures.
        healthy = response.status < 500 && ![408, 429].includes(response.status);
      } catch (_) {
        healthy = false;
      }
      if (healthy) {
        state.circuit = normalizeCircuit(null);
        resetWindow(runtime);
        await writeState(cache, progressUrl, state);
        return true;
      }
      state.circuit.probeIndex += 1;
      if (state.circuit.probeIndex >= PROBE_DELAYS.length) {
        state.phase = 'exhausted';
        state.circuit.nextProbeAt = 0;
      } else {
        state.phase = 'waiting';
        state.circuit.nextProbeAt = now() + PROBE_DELAYS[state.circuit.probeIndex];
      }
      await writeState(cache, progressUrl, state);
      return false;
    }

    async function reportBlockedOrWaiting(cache, progressUrl, state, runtime) {
      const stored = state.stored;
      const terminal = state.failed.filter(entry => entry.terminal);
      if (terminal.length) {
        state.phase = 'exhausted';
        await writeState(cache, progressUrl, state);
        await broadcast({
          type: 'package-integrity-blocked', affected: terminal.length,
          urls: terminal.map(entry => entry.url), loaded: state.cursor, stored,
          failed: state.failed.length, total: state.total
        });
        return;
      }
      if (state.circuit.open) {
        const exhausted = state.phase === 'exhausted';
        await broadcast({
          type: exhausted ? 'cache-recovery-exhausted' : 'cache-recovery-wait',
          nextRetryAt: exhausted ? 0 : state.circuit.nextProbeAt,
          loaded: state.cursor, stored, failed: state.failed.length, total: state.total,
          concurrency: runtime.concurrency
        });
        return;
      }
      const retryable = state.failed.filter(entry => !entry.terminal && entry.attempts < MAX_ATTEMPTS);
      if (!retryable.length) {
        state.phase = 'exhausted';
        await writeState(cache, progressUrl, state);
        await broadcast({
          type: 'cache-recovery-exhausted', loaded: state.cursor, stored,
          failed: state.failed.length, total: state.total
        });
        return;
      }
      const nextRetryAt = Math.min(...retryable.map(entry => entry.nextAttemptAt));
      if (nextRetryAt > now()) {
        state.phase = 'waiting';
        await writeState(cache, progressUrl, state);
        await broadcast({
          type: 'cache-recovery-wait', nextRetryAt, loaded: state.cursor, stored,
          failed: state.failed.length, total: state.total
        });
      } else {
        state.phase = 'recovery';
        await writeState(cache, progressUrl, state);
        await broadcast({
          type: 'cache-chunk-complete', loaded: state.cursor, stored,
          failed: state.failed.length, total: state.total
        });
      }
    }

    async function precacheTiles(packageId, expectedCount, options) {
      const cache = await caches.open(cacheName);
      const { tileUrls, total, requiredUrls, requiredSet } = manifestForScope();
      if (total !== expectedCount) {
        await broadcast({ type: 'cache-incomplete', loaded: 0, stored: 0, failed: total, total });
        return;
      }
      const activePackageId = packageId || 'current';
      const markerUrl = new URL(`offline-package-${encodeURIComponent(activePackageId)}.ready`, self.registration.scope).href;
      const progressUrl = new URL(`offline-package-${encodeURIComponent(activePackageId)}.progress`, self.registration.scope).href;

      const ready = await cache.match(markerUrl);
      if (ready) {
        const keys = await cache.keys();
        const storedTileUrls = new Set(keys.map(request => request.url)
          .filter(url => new URL(url).pathname.includes(tilePathFragment)));
        if (storedTileUrls.size === total && requiredUrls.every(url => storedTileUrls.has(url))) {
          await broadcast({ type: 'cache-complete', loaded: total, stored: total, reused: total, total });
          await removeSupersededCaches();
          return;
        }
        await cache.delete(markerUrl);
        await Promise.all(keys.filter(request =>
          new URL(request.url).pathname.includes(tilePathFragment) && !requiredSet.has(request.url)
        ).map(request => cache.delete(request)));
      } else {
        const keys = await cache.keys();
        const obsoleteMarkers = keys.filter(request =>
          new URL(request.url).pathname.includes('/offline-package-')
          && request.url !== markerUrl && request.url !== progressUrl
        );
        if (obsoleteMarkers.some(request => request.url.endsWith('.ready'))) {
          await Promise.all(keys.filter(request => {
            const path = new URL(request.url).pathname;
            return path.includes(tilePathFragment) || path.includes('/offline-package-');
          }).map(request => cache.delete(request)));
        } else {
          await Promise.all(obsoleteMarkers.map(request => cache.delete(request)));
        }
      }

      const state = await readState(
        cache, progressUrl, activePackageId, total, tileUrls, requiredUrls
      );
      if (options.forceRetry) {
        resetRetryableBudgets(state);
        runtimeByPackage.delete(activePackageId);
      } else if (
        options.onlineTransition
        && !state.onlineRecoveryUsed
        && (state.phase === 'exhausted' || state.circuit.open)
      ) {
        resetRetryableBudgets(state);
        state.onlineRecoveryUsed = true;
      }
      const currentRuntime = runtimeFor(activePackageId);
      await writeState(cache, progressUrl, state);

      if (!(await handleOpenCircuit(cache, progressUrl, state, tileUrls, currentRuntime))) {
        await reportBlockedOrWaiting(cache, progressUrl, state, currentRuntime);
        return;
      }

      const due = state.failed
        .filter(entry => !entry.terminal && entry.attempts < (entry.kind === 'integrity' ? INTEGRITY_ATTEMPTS : MAX_ATTEMPTS)
          && entry.nextAttemptAt <= now())
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.url.localeCompare(b.url));
      const primaryRemaining = total - state.cursor;
      const retryLimit = primaryRemaining > 0 ? Math.min(RETRY_SHARE, due.length) : Math.min(CHUNK_SIZE, due.length);
      const selectedRetries = due.slice(0, retryLimit).map(entry => ({ url: entry.url, primary: false }));
      const primaryLimit = CHUNK_SIZE - selectedRetries.length;
      const primary = tileUrls.slice(state.cursor, state.cursor + primaryLimit)
        .map((url, index) => ({ url, primary: true, primaryOffset: index }));
      const work = [...selectedRetries, ...primary];

      if (work.length) {
        const result = await runWork(cache, progressUrl, state, work, currentRuntime);
        if (result.storageBlocked) {
          state.phase = 'storage-blocked';
          await writeState(cache, progressUrl, state);
          await broadcast({
            type: 'storage-blocked', loaded: state.cursor,
            stored: state.stored, failed: state.failed.length, total
          });
          return;
        }
      }

      if (state.circuit.open) {
        await reportBlockedOrWaiting(cache, progressUrl, state, currentRuntime);
        return;
      }
      if (state.cursor < total) {
        await broadcast({
          type: 'cache-chunk-complete', loaded: state.cursor,
          stored: state.stored, failed: state.failed.length,
          total, concurrency: currentRuntime.concurrency
        });
        return;
      }

      state.phase = 'verifying';
      await writeState(cache, progressUrl, state);
      const keys = await cache.keys();
      const tileRequests = keys.filter(request => new URL(request.url).pathname.includes(tilePathFragment));
      const storedUrls = new Set(tileRequests.map(request => request.url));
      await Promise.all(tileRequests.filter(request => !requiredSet.has(request.url))
        .map(request => cache.delete(request)));
      const missingUrls = requiredUrls.filter(url => !storedUrls.has(url));
      state.stored = total - missingUrls.length;
      const relativeByUrl = new Map(requiredUrls.map((url, index) => [url, tileUrls[index]]));
      const missingRelative = new Set(missingUrls.map(url => relativeByUrl.get(url)));
      state.failed = state.failed.filter(entry => missingRelative.has(entry.url));
      const untrackedMissing = [...missingRelative].filter(url => !failureFor(state, url));

      // A tile can disappear after the cursor passed it (browser eviction or a
      // damaged cache). Queue it with zero attempts so repair does not consume
      // a retry budget and report the real rewind point to the client.
      if (untrackedMissing.length) {
        untrackedMissing.forEach(url => state.failed.push({
          url, attempts: 0, nextAttemptAt: 0, kind: 'retryable', terminal: false, status: null
        }));
      }

      if (!missingUrls.length) {
        try {
          await cache.put(markerUrl, new Response('ready', { headers: { 'Content-Type': 'text/plain' } }));
        } catch (error) {
          if (isQuotaError(error)) {
            state.phase = 'storage-blocked';
            await writeState(cache, progressUrl, state);
            await broadcast({ type: 'storage-blocked', loaded: total, stored: total, failed: 0, total });
            return;
          }
          throw error;
        }
        await cache.delete(progressUrl);
        await removeSupersededCaches();
        await broadcast({ type: 'cache-complete', loaded: total, stored: total, failed: 0, total });
        return;
      }

      if (untrackedMissing.length) {
        const untrackedMissingSet = new Set(untrackedMissing);
        const firstMissing = tileUrls.findIndex(url => untrackedMissingSet.has(url));
        state.phase = 'recovery';
        await writeState(cache, progressUrl, state);
        await broadcast({
          type: 'cache-chunk-complete', loaded: firstMissing,
          stored: total - missingUrls.length, failed: state.failed.length, total
        });
        return;
      }

      await reportBlockedOrWaiting(cache, progressUrl, state, currentRuntime);
    }

    self.addEventListener('message', event => {
      if (event.data?.type !== 'precache-tiles') return;
      const packageId = event.data.packageId || 'current';
      const forceRetry = event.data.forceRetry === true;
      if (active && !forceRetry && active.packageId === packageId) {
        event.waitUntil(active.promise);
        return;
      }
      if (forceRetry && active) abortActive();
      const run = async () => {
        try {
          await precacheTiles(packageId, event.data.expectedCount, {
            forceRetry,
            onlineTransition: event.data.onlineTransition === true
          });
        } catch (error) {
          if (!isQuotaError(error)) throw error;
          await broadcast({
            type: 'storage-blocked', loaded: 0, stored: 0,
            failed: event.data.expectedCount, total: event.data.expectedCount
          });
        }
      };
      const queued = (active?.promise || Promise.resolve()).then(run, run);
      const tracked = queued.finally(() => {
        if (active?.promise === tracked) active = null;
      });
      active = { packageId, promise: tracked };
      event.waitUntil(tracked);
    });
  };
})();
