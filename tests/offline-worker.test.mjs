import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const scope = 'https://example.test/rio-das-mortes/';
const tile = 'tiles/17/1/2.jpg';

function createHarness({ entries = [], fetchImpl } = {}) {
  const handlers = {};
  const messages = [];
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
    getTileList: () => [tile],
    fetch: fetchImpl || (async () => new Response('jpeg', { status: 200 })),
    caches: {
      async open() { return cache; },
      async keys() { return ['rio-das-mortes-v10']; },
      async delete() { return true; },
      async match(key) { return cache.match(key); }
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
  return { handlers, messages, store };
}

async function send(harness, packageId) {
  let completion;
  harness.handlers.message({
    data: { type: 'precache-tiles', packageId, expectedCount: 1 },
    waitUntil(promise) { completion = promise; }
  });
  await completion;
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
