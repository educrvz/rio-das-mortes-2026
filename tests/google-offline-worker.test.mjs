import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const scope = 'https://example.test/rio-das-mortes/google/';
const tile = 'tiles/17/1/2.jpg';

function createHarness({ entries = [], fetchImpl, cacheNames = ['rio-das-mortes-google-v2'], tileList = [tile] } = {}) {
  const handlers = {};
  const messages = [];
  const deletedCaches = [];
  let globalMatches = 0;
  const store = new Map(entries.map(key => [new URL(key, scope).href, new Response('cached')]));
  const cache = {
    async addAll() {},
    async match(key) { return store.get(new URL(typeof key === 'string' ? key : key.url, scope).href); },
    async put(key, value) { store.set(new URL(typeof key === 'string' ? key : key.url, scope).href, value); },
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
  vm.runInNewContext(fs.readFileSync(new URL('../google/sw.js', import.meta.url), 'utf8'), context);
  return { handlers, messages, store, deletedCaches, get globalMatches() { return globalMatches; } };
}

{
  const harness = createHarness({ entries: ['../app.js'] });
  let responsePromise;
  harness.handlers.fetch({
    request: new Request(new URL('../app.js', scope)),
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
  for (const expectedType of ['cache-chunk-complete', 'cache-complete']) {
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.handlers.message({
      data: { type: 'precache-tiles', packageId: 'chunked', expectedCount: tileList.length },
      waitUntil(promise) { completion = promise; }
    });
    await completion;
    assert.equal(harness.messages.at(-1).type, expectedType);
  }
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

async function activate(harness) {
  let completion;
  harness.handlers.activate({ waitUntil(promise) { completion = promise; } });
  await completion;
}

{
  const harness = createHarness({
    cacheNames: ['rio-das-mortes-v12', 'rio-das-mortes-google-v1', 'rio-das-mortes-google-v2']
  });
  await activate(harness);
  assert.deepEqual(harness.deletedCaches, [], 'activation must preserve the previous complete package');
  await send(harness, 'upgrade-package');
  assert.deepEqual(harness.deletedCaches, ['rio-das-mortes-google-v1']);
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

console.log('Google offline worker regression tests passed');
