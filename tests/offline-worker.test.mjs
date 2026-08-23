import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const scope = 'https://example.test/rio-das-mortes/';
const tile = 'tiles/17/1/2.jpg';

function createHarness({ entries = [], fetchImpl, cacheNames = ['rio-das-mortes-v13'], tileList = [tile] } = {}) {
  const handlers = {};
  const messages = [];
  const deletedCaches = [];
  let globalMatches = 0;
  const store = new Map(entries.map(entry => {
    const [key, body = 'cached'] = Array.isArray(entry) ? entry : [entry];
    return [new URL(key, scope).href, new Response(body)];
  }));
  const cache = {
    async addAll() {},
    async match(key) { return store.get(new URL(typeof key === 'string' ? key : key.url, scope).href)?.clone(); },
    async put(key, value) { store.set(new URL(typeof key === 'string' ? key : key.url, scope).href, value.clone()); },
    async delete(key) { return store.delete(new URL(typeof key === 'string' ? key : key.url, scope).href); },
    async keys() { return [...store.keys()].map(url => new Request(url)); }
  };
  const context = {
    AbortController, URL, Request, Response, Promise, setTimeout, clearTimeout,
    importScripts() {},
    getTileList: () => tileList,
    fetch: fetchImpl || (async () => new Response('jpeg', { status: 200 })),
    caches: {
      async open() { return cache; },
      async keys() { return cacheNames; },
      async delete(name) { deletedCaches.push(name); return true; },
      async match(key) { globalMatches++; return new Response('old-cache'); }
    },
    self: {
      registration: { scope },
      clients: {
        async matchAll() { return [{ postMessage(message) { messages.push(message); } }]; },
        async claim() {}
      },
      skipWaiting() {},
      addEventListener(type, handler) { handlers[type] = handler; }
    }
  };
  vm.runInNewContext(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), context);
  return { handlers, messages, store, deletedCaches, get globalMatches() { return globalMatches; } };
}

{
  const harness = createHarness({ entries: ['app.js'] });
  let responsePromise;
  harness.handlers.fetch({
    request: new Request(new URL('app.js', scope)),
    respondWith(promise) { responsePromise = promise; }
  });
  const response = await responsePromise;
  assert.equal(await response.text(), 'cached');
  assert.equal(harness.globalMatches, 0, 'shell assets must come from the current cache only');
}

{
  const tileList = Array.from({ length: 201 }, (_, index) => `tiles/17/1/${index}.jpg`);
  const harness = createHarness({ tileList });
  let completion;
  harness.handlers.message({
    data: { type: 'precache-tiles', packageId: 'chunked', expectedCount: tileList.length },
    waitUntil(promise) { completion = promise; }
  });
  await completion;
  assert.equal(harness.messages.at(-1).type, 'cache-chunk-complete');
  harness.store.delete(new URL(tileList[0], scope).href);
  await new Promise(resolve => setTimeout(resolve, 0));
  harness.handlers.message({
    data: { type: 'precache-tiles', packageId: 'chunked', expectedCount: tileList.length },
    waitUntil(promise) { completion = promise; }
  });
  await completion;
  assert.equal(harness.messages.at(-1).loaded, 0, 'final verification must rewind to an evicted tile');
  await new Promise(resolve => setTimeout(resolve, 0));
  harness.handlers.message({
    data: { type: 'precache-tiles', packageId: 'chunked', expectedCount: tileList.length },
    waitUntil(promise) { completion = promise; }
  });
  await completion;
  assert.equal(harness.messages.at(-1).loaded, 201);
  assert.equal(harness.messages.at(-1).type, 'cache-complete');
}

async function send(harness, packageId) {
  let completion;
  harness.handlers.message({
    data: { type: 'precache-tiles', packageId, expectedCount: 1 },
    waitUntil(promise) { completion = promise; }
  });
  await completion;
}

function recoveryState(harness, packageId) {
  const key = new URL(`offline-package-${packageId}.progress`, scope).href;
  const response = harness.store.get(key);
  return response ? response.clone().json() : null;
}

{
  let fetches = 0;
  const packageId = 'already-complete';
  const harness = createHarness({
    entries: [`offline-package-${packageId}.ready`, tile],
    fetchImpl: async () => { fetches++; return new Response('jpeg', { status: 200 }); }
  });
  await send(harness, packageId);
  assert.equal(fetches, 0, 'an exact ready package must not schedule download work');
  assert.deepEqual(harness.messages.map(message => message.type), ['cache-complete']);
}

{
  const packageId = 'legacy-state';
  const progress = `offline-package-${packageId}.progress`;
  const tileList = Array.from({ length: 202 }, (_, index) => `tiles/17/1/${index}.jpg`);
  const harness = createHarness({
    entries: [[progress, JSON.stringify({ cursor: 1, total: tileList.length })], tileList[0]],
    tileList
  });
  let completion;
  harness.handlers.message({
    data: { type: 'precache-tiles', packageId, expectedCount: tileList.length },
    waitUntil(promise) { completion = promise; }
  });
  await completion;
  const state = await recoveryState(harness, packageId);
  assert.equal(state.version, 1, 'cursor-only progress must migrate to the versioned schema');
  assert.equal(state.packageId, packageId);
  assert.equal(state.total, tileList.length);
  assert.equal(state.cursor, 201);
  assert.equal(state.phase, 'primary');
  assert.deepEqual(state.failed, []);
}

{
  const packageId = 'deduplicated-failure';
  const harness = createHarness({
    fetchImpl: async () => new Response('failed', { status: 503 })
  });
  await send(harness, packageId);
  await send(harness, packageId);
  const state = await recoveryState(harness, packageId);
  assert.equal(state.version, 1);
  assert.equal(state.failed.length, 1, 'repeated failure must keep one queue entry');
  assert.equal(state.failed[0].url, tile);
  assert.equal(state.failed[0].attempts, 2);
  assert.equal(Number.isFinite(state.failed[0].nextAttemptAt), true);
}

{
  const packageId = 'normalize-duplicates';
  const progress = `offline-package-${packageId}.progress`;
  const tileList = Array.from({ length: 202 }, (_, index) => `tiles/17/1/${index}.jpg`);
  const duplicated = {
    version: 1, packageId, total: tileList.length, cursor: 0, phase: 'primary',
    failed: [
      { url: tileList[201], attempts: 1, nextAttemptAt: 5 },
      { url: tileList[201], attempts: 3, nextAttemptAt: 7 }
    ]
  };
  const harness = createHarness({
    entries: [[progress, JSON.stringify(duplicated)]], tileList
  });
  let completion;
  harness.handlers.message({
    data: { type: 'precache-tiles', packageId, expectedCount: tileList.length },
    waitUntil(promise) { completion = promise; }
  });
  await completion;
  const state = await recoveryState(harness, packageId);
  assert.deepEqual(state.failed, [
    { url: tileList[201], attempts: 3, nextAttemptAt: 7 }
  ]);
}

for (const [label, invalidState] of [
  ['wrong package', { version: 1, packageId: 'other', total: 1, cursor: 1, phase: 'primary', failed: [{ url: 'tiles/17/9/9.jpg', attempts: 9, nextAttemptAt: 1 }] }],
  ['unsupported schema', { version: 999, packageId: 'safe-rebuild', total: 1, cursor: 1, phase: 'primary', failed: [] }],
  ['invalid cursor', { version: 1, packageId: 'safe-rebuild', total: 1, cursor: 99, phase: 'primary', failed: [] }]
]) {
  const packageId = 'safe-rebuild';
  const progress = `offline-package-${packageId}.progress`;
  const harness = createHarness({
    entries: [[progress, JSON.stringify(invalidState)]],
    fetchImpl: async () => new Response('failed', { status: 503 })
  });
  await send(harness, packageId);
  const state = await recoveryState(harness, packageId);
  assert.equal(state.packageId, packageId, `${label} state must be rebuilt for the active package`);
  assert.equal(state.cursor, 1);
  assert.deepEqual(state.failed.map(entry => entry.url), [tile]);
  assert.equal(state.failed[0].attempts, 1);
}

{
  const packageId = 'corrupt-state';
  const progress = `offline-package-${packageId}.progress`;
  const harness = createHarness({
    entries: [[progress, '{not-json']],
    fetchImpl: async () => new Response('failed', { status: 503 })
  });
  await send(harness, packageId);
  const state = await recoveryState(harness, packageId);
  assert.equal(state.version, 1);
  assert.equal(state.packageId, packageId);
  assert.equal(state.failed.length, 1);
}

async function activate(harness) {
  let completion;
  harness.handlers.activate({ waitUntil(promise) { completion = promise; } });
  await completion;
}

{
  let fetches = 0;
  let markStarted;
  const firstFetchStarted = new Promise(resolve => { markStarted = resolve; });
  const harness = createHarness({
    fetchImpl: async (_url, options = {}) => {
      fetches++;
      if (fetches > 1) return new Response('jpeg', { status: 200 });
      markStarted();
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
  });
  let firstCompletion;
  harness.handlers.message({
    data: { type: 'precache-tiles', packageId: 'retry-package', expectedCount: 1 },
    waitUntil(promise) { firstCompletion = promise; }
  });
  await firstFetchStarted;
  let retryCompletion;
  harness.handlers.message({
    data: { type: 'precache-tiles', packageId: 'retry-package', expectedCount: 1 },
    waitUntil(promise) { retryCompletion = promise; }
  });
  await Promise.all([firstCompletion, retryCompletion]);
  assert.equal(fetches, 2, 'retry must abort the stalled request and run a new download');
  assert.equal(harness.messages.at(-1).type, 'cache-complete');
}

{
  const harness = createHarness({
    cacheNames: ['rio-das-mortes-v12', 'rio-das-mortes-v13', 'rio-das-mortes-google-v3']
  });
  await activate(harness);
  assert.deepEqual(harness.deletedCaches, [], 'activation must preserve the previous complete package');
  await send(harness, 'upgrade-package');
  assert.deepEqual(harness.deletedCaches, ['rio-das-mortes-v12']);
}

{
  let fetches = 0;
  const packageId = 'new-package';
  const marker = `offline-package-${packageId}.ready`;
  const harness = createHarness({
    entries: [marker],
    fetchImpl: async () => { fetches++; return new Response('jpeg', { status: 200 }); }
  });
  await send(harness, packageId);
  assert.equal(fetches, 1, 'a preserved marker must not conceal an evicted tile');
  assert.equal(harness.messages.at(-1).type, 'cache-complete');
}

{
  let fetches = 0;
  const packageId = 'swapped-package';
  const harness = createHarness({
    entries: [`offline-package-${packageId}.ready`, 'tiles/17/9/9.jpg'],
    fetchImpl: async () => { fetches++; return new Response('jpeg', { status: 200 }); }
  });
  await send(harness, packageId);
  assert.equal(fetches, 1, 'a stale extra tile must not hide a missing manifest tile');
  assert.equal([...harness.store.keys()].some(url => url.endsWith('/tiles/17/9/9.jpg')), false);
}

{
  let fetches = 0;
  const harness = createHarness({
    entries: ['offline-package-old.ready', tile],
    fetchImpl: async () => { fetches++; return new Response('new jpeg', { status: 200 }); }
  });
  await send(harness, 'new');
  assert.equal(fetches, 1, 'a new package fingerprint must replace stale tile content');
  assert.equal([...harness.store.keys()].some(url => url.includes('offline-package-old')), false);
}

{
  let fail = true;
  const harness = createHarness({
    fetchImpl: async () => fail ? new Response('failed', { status: 503 }) : new Response('jpeg', { status: 200 })
  });
  await send(harness, 'retry');
  assert.equal(harness.messages.at(-1).type, 'cache-incomplete');
  fail = false;
  await send(harness, 'retry');
  assert.equal(harness.messages.at(-1).type, 'cache-complete', 'retry must recover a failed package');
}

console.log('Offline worker regression tests passed');
