import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const variants = [
  { name: 'INPE', worker: '../sw.js', scope: 'https://example.test/rio-das-mortes/', cache: 'rio-das-mortes-v13' },
  { name: 'Google', worker: '../google/sw.js', scope: 'https://example.test/rio-das-mortes/google/', cache: 'rio-das-mortes-google-v3' }
];

function harnessFor(variant, { tileList = ['tiles/17/1/0.jpg'], fetchImpl, quota = false, entries = [] } = {}) {
  const handlers = {};
  const messages = [];
  const store = new Map(entries.map(([key, value]) => [new URL(key, variant.scope).href, new Response(value)]));
  let now = 1_000;
  const cache = {
    async addAll() {},
    async match(key) { return store.get(new URL(typeof key === 'string' ? key : key.url, variant.scope).href)?.clone(); },
    async put(key, response) {
      const url = new URL(typeof key === 'string' ? key : key.url, variant.scope).href;
      if (quota && url.includes('/tiles/')) {
        const error = new Error('quota');
        error.name = 'QuotaExceededError';
        throw error;
      }
      store.set(url, response.clone());
    },
    async delete(key) { return store.delete(new URL(typeof key === 'string' ? key : key.url, variant.scope).href); },
    async keys() { return [...store.keys()].map(url => new Request(url)); }
  };
  const context = {
    AbortController, URL, Request, Response, Promise, setTimeout, clearTimeout,
    importScripts() {},
    getTileList: () => tileList,
    fetch: fetchImpl || (async () => new Response('jpeg', { status: 200 })),
    caches: {
      async open() { return cache; },
      async keys() { return [variant.cache]; },
      async delete() { return true; },
      async match() { return undefined; }
    },
    self: {
      registration: { scope: variant.scope },
      clients: { async matchAll() { return [{ postMessage(message) { messages.push(message); } }]; }, async claim() {} },
      skipWaiting() {},
      addEventListener(type, handler) { handlers[type] = handler; },
      __offlineRecoveryTest: { now: () => now, random: () => 0.5 }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../offline-recovery-engine.js', import.meta.url), 'utf8'), context);
  vm.runInContext(fs.readFileSync(new URL(variant.worker, import.meta.url), 'utf8'), context);
  return {
    messages, store,
    advance(ms) { now += ms; },
    start(packageId, extra = {}) {
      let completion;
      handlers.message({
        data: { type: 'precache-tiles', packageId, expectedCount: tileList.length, ...extra },
        waitUntil(promise) { completion = promise; }
      });
      return completion;
    },
    async state(packageId) {
      const response = store.get(new URL(`offline-package-${packageId}.progress`, variant.scope).href);
      return response ? response.clone().json() : null;
    }
  };
}

for (const variant of variants) {
  {
    const tileList = Array.from({ length: 45 }, (_, index) => `tiles/17/1/${index}.jpg`);
    const h = harnessFor(variant, { tileList });
    await h.start('continuous-counter');
    const progress = h.messages.filter(message => message.type === 'cache-progress');
    assert.equal(progress.length > 1, true);
    assert.equal(progress.every(message => Number.isInteger(message.stored)), true,
      `${variant.name}: every progress event includes the persisted stored count`);
    assert.equal(progress.every((message, index) => index === 0 || message.stored >= progress[index - 1].stored), true,
      `${variant.name}: the stored counter is monotonic while tiles are cached`);
    assert.equal(progress.at(-1).stored, tileList.length);
  }

  {
    const packageId = 'legacy-stored-count';
    const tileList = Array.from({ length: 201 }, (_, index) => `tiles/17/1/${index}.jpg`);
    const progress = `offline-package-${packageId}.progress`;
    const saved = { version: 1, packageId, total: tileList.length, cursor: 0, phase: 'primary', failed: [] };
    const h = harnessFor(variant, {
      tileList,
      entries: [[progress, JSON.stringify(saved)], [tileList[0], 'jpeg'], [tileList[1], 'jpeg']],
      fetchImpl: async () => new Response('busy', { status: 503 })
    });
    await h.start(packageId);
    const state = await h.state(packageId);
    assert.equal(state.stored, 2, `${variant.name}: legacy state initializes stored from required cache membership`);
    assert.equal(h.messages.filter(message => message.type === 'cache-progress')
      .every(message => message.stored === 2), true,
    `${variant.name}: attempts and failures do not increase stored`);
  }

  {
    const packageId = 'evicted-stored-count';
    const progress = `offline-package-${packageId}.progress`;
    const saved = {
      version: 1, packageId, total: 1, cursor: 1, stored: 1, phase: 'verifying', failed: [],
      onlineRecoveryUsed: false,
      circuit: { open: false, highFailureWindows: 0, probeIndex: 0, nextProbeAt: 0 }
    };
    const h = harnessFor(variant, { entries: [[progress, JSON.stringify(saved)]] });
    await h.start(packageId);
    assert.equal((await h.state(packageId)).stored, 0,
      `${variant.name}: exact verification corrects a persisted count after eviction`);
  }

  {
    let fetches = 0;
    const h = harnessFor(variant, { fetchImpl: async () => { fetches++; return new Response('busy', { status: 503 }); } });
    await h.start('budget');
    let state = await h.state('budget');
    assert.equal(state.failed[0].attempts, 1, `${variant.name}: initial request counts toward four-attempt budget`);
    assert.equal(state.failed[0].nextAttemptAt, 2_000);
    await h.start('budget');
    assert.equal(fetches, 1, `${variant.name}: retry cannot run before persisted due time`);
    h.advance(1_000);
    await h.start('budget');
    state = await h.state('budget');
    assert.equal(state.failed[0].attempts, 2);
    assert.equal(state.failed[0].nextAttemptAt, 4_000);
    h.advance(2_000);
    await h.start('budget');
    h.advance(4_000);
    await h.start('budget');
    state = await h.state('budget');
    assert.equal(fetches, 4);
    assert.equal(state.phase, 'exhausted');
    assert.equal(h.messages.at(-1).type, 'cache-recovery-exhausted');
  }

  {
    const h = harnessFor(variant, {
      fetchImpl: async () => new Response('slow down', {
        status: 429, headers: { 'Retry-After': '10' }
      })
    });
    await h.start('retry-after');
    const state = await h.state('retry-after');
    assert.equal(state.failed[0].nextAttemptAt, 11_000, `${variant.name}: Retry-After extends exponential delay`);
    assert.equal(h.messages.some(message => message.concurrency === 3), true,
      `${variant.name}: a 429 immediately halves adaptive concurrency`);
  }

  {
    let fetches = 0;
    const h = harnessFor(variant, { fetchImpl: async () => { fetches++; return new Response('gone', { status: 404 }); } });
    await h.start('integrity');
    h.advance(1_000);
    await h.start('integrity');
    await h.start('integrity');
    const state = await h.state('integrity');
    assert.equal(fetches, 2, `${variant.name}: 404/410 gets only two total attempts`);
    assert.equal(state.failed[0].terminal, true);
    assert.equal(h.messages.at(-1).type, 'package-integrity-blocked');
    assert.deepEqual(Array.from(h.messages.at(-1).urls), ['tiles/17/1/0.jpg']);
  }

  {
    const h = harnessFor(variant, { quota: true });
    await h.start('quota');
    assert.equal((await h.state('quota')).phase, 'storage-blocked');
    assert.equal(h.messages.at(-1).type, 'storage-blocked');
  }

  {
    const tileList = Array.from({ length: 250 }, (_, index) => `tiles/17/1/${index}.jpg`);
    const packageId = 'fairness';
    const progress = `offline-package-${packageId}.progress`;
    const saved = {
      version: 1, packageId, total: tileList.length, cursor: 0, phase: 'primary', onlineRecoveryUsed: false,
      circuit: { open: false, highFailureWindows: 0, probeIndex: 0, nextProbeAt: 0 },
      failed: [{ url: tileList.at(-1), attempts: 1, nextAttemptAt: 0, kind: 'retryable', terminal: false }]
    };
    const fetched = [];
    const h = harnessFor(variant, {
      tileList, entries: [[progress, JSON.stringify(saved)]],
      fetchImpl: async url => { fetched.push(String(url)); return new Response('jpeg', { status: 200 }); }
    });
    await h.start(packageId);
    const state = await h.state(packageId);
    assert.equal(fetched.includes(tileList.at(-1)), true, `${variant.name}: a due retry receives bounded service`);
    assert.equal(state.cursor, 199, `${variant.name}: retry service must not starve primary progress`);
    assert.equal(fetched.length, 200);
  }

  {
    const tileList = Array.from({ length: 70 }, (_, index) => `tiles/17/1/${index}.jpg`);
    let active = 0;
    let maximum = 0;
    const h = harnessFor(variant, {
      tileList,
      fetchImpl: async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 0));
        active--;
        return new Response('jpeg', { status: 200 });
      }
    });
    await h.start('adaptive-up');
    assert.equal(maximum, 7, `${variant.name}: concurrency starts at six then rises after three clean windows`);
    assert.equal(h.messages.some(message => message.concurrency === 7), true);
  }

  {
    const tileList = Array.from({ length: 45 }, (_, index) => `tiles/17/1/${index}.jpg`);
    let calls = 0;
    const h = harnessFor(variant, {
      tileList,
      fetchImpl: async () => {
        calls++;
        if (calls <= 40) throw new TypeError('offline');
        return new Response('jpeg', { status: 200 });
      }
    });
    await h.start('circuit');
    const state = await h.state('circuit');
    assert.equal(state.cursor, 40, `${variant.name}: circuit leaves unattempted primary tiles untouched`);
    assert.equal(state.circuit.open, true);
    assert.equal(state.circuit.nextProbeAt, 6_000);
    assert.equal(h.messages.at(-1).type, 'cache-recovery-wait');
  }

  {
    const tileList = Array.from({ length: 45 }, (_, index) => `tiles/17/1/${index}.jpg`);
    let calls = 0;
    const h = harnessFor(variant, {
      tileList,
      fetchImpl: async () => { calls++; throw new TypeError('offline'); }
    });
    await h.start('bounded-probes');
    await h.start('bounded-probes');
    assert.equal(calls, 40, `${variant.name}: a circuit cannot probe before its due time`);
    h.advance(5_000);
    await h.start('bounded-probes');
    assert.equal((await h.state('bounded-probes')).circuit.nextProbeAt, 21_000);
    h.advance(15_000);
    await h.start('bounded-probes');
    assert.equal((await h.state('bounded-probes')).circuit.nextProbeAt, 66_000);
    h.advance(45_000);
    await h.start('bounded-probes');
    assert.equal(calls, 43);
    assert.equal((await h.state('bounded-probes')).phase, 'exhausted');
    assert.equal(h.messages.at(-1).type, 'cache-recovery-exhausted');
  }

  {
    const packageId = 'online-once';
    const progress = `offline-package-${packageId}.progress`;
    const saved = {
      version: 1, packageId, total: 1, cursor: 1, phase: 'exhausted', onlineRecoveryUsed: false,
      circuit: { open: false, highFailureWindows: 0, probeIndex: 0, nextProbeAt: 0 },
      failed: [{ url: 'tiles/17/1/0.jpg', attempts: 4, nextAttemptAt: 0, kind: 'retryable', terminal: false }]
    };
    let fetches = 0;
    const h = harnessFor(variant, {
      entries: [[progress, JSON.stringify(saved)]],
      fetchImpl: async () => { fetches++; return new Response('busy', { status: 503 }); }
    });
    await h.start(packageId, { onlineTransition: true });
    let state = await h.state(packageId);
    assert.equal(state.onlineRecoveryUsed, true);
    assert.equal(state.failed[0].attempts, 1);
    await h.start(packageId, { onlineTransition: true });
    state = await h.state(packageId);
    assert.equal(fetches, 1, `${variant.name}: repeated online messages cannot mint attempt budgets`);
    assert.equal(state.failed[0].attempts, 1);
  }

  {
    const packageId = 'online-closes-waiting-circuit';
    const tileList = ['tiles/17/1/0.jpg', 'tiles/17/1/1.jpg'];
    const progress = `offline-package-${packageId}.progress`;
    const saved = {
      version: 1, packageId, total: 2, cursor: 2, phase: 'waiting', onlineRecoveryUsed: false,
      circuit: { open: true, highFailureWindows: 2, probeIndex: 1, nextProbeAt: 100_000 },
      failed: [
        { url: tileList[0], attempts: 3, nextAttemptAt: 100_000, kind: 'retryable', terminal: false },
        { url: tileList[1], attempts: 2, nextAttemptAt: 0, kind: 'integrity', terminal: true, status: 404 }
      ]
    };
    let fetches = 0;
    const h = harnessFor(variant, {
      tileList, entries: [[progress, JSON.stringify(saved)]],
      fetchImpl: async () => { fetches++; return new Response('busy', { status: 503 }); }
    });
    await h.start(packageId, { onlineTransition: true });
    const state = await h.state(packageId);
    assert.equal(fetches, 1, `${variant.name}: a genuine online transition resumes before the old probe deadline`);
    assert.equal(state.onlineRecoveryUsed, true);
    assert.equal(state.circuit.open, false);
    assert.equal(state.failed.find(entry => entry.url === tileList[0]).attempts, 1);
    const integrity = state.failed.find(entry => entry.url === tileList[1]);
    assert.equal(integrity.attempts, 2, `${variant.name}: online recovery must not reset integrity failures`);
    assert.equal(integrity.terminal, true);
    await h.start(packageId, { onlineTransition: true });
    assert.equal(fetches, 1, `${variant.name}: repeated online messages cannot bypass the one-cycle grant`);
  }

  {
    let resolveFetch;
    let fetches = 0;
    const h = harnessFor(variant, {
      fetchImpl: async () => {
        fetches++;
        return new Promise(resolve => { resolveFetch = resolve; });
      }
    });
    const first = h.start('coalesce');
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = h.start('coalesce');
    assert.equal(fetches, 1, `${variant.name}: ordinary starts from multiple clients coalesce`);
    resolveFetch(new Response('jpeg', { status: 200 }));
    await Promise.all([first, second]);
  }

  {
    let fetches = 0;
    const h = harnessFor(variant, {
      fetchImpl: async (_url, options) => {
        fetches++;
        if (fetches > 1) return new Response('jpeg', { status: 200 });
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
    });
    const first = h.start('forced');
    await new Promise(resolve => setTimeout(resolve, 0));
    const forced = h.start('forced', { forceRetry: true });
    await Promise.all([first, forced]);
    assert.equal(fetches, 2, `${variant.name}: only forceRetry replaces active work`);
    assert.equal(h.messages.at(-1).type, 'cache-complete');
  }
}

console.log('Offline recovery policy tests passed');
