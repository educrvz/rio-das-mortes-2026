import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const engineSource = fs.readFileSync(new URL('../offline-recovery-engine.js', import.meta.url), 'utf8');

assert.doesNotMatch(engineSource, /AbortController|\.abort\(/,
  'the Pindaiba-style downloader must never cancel a request');
assert.doesNotMatch(engineSource, /\.progress[^\n]*cache\.put|writeState|STATE_VERSION/,
  'Cache Storage membership, not a second mutable checkpoint, is the download state');
assert.match(engineSource, /const BATCH_SIZE = 30;/,
  'the downloader must retain Pindaiba batch sizing');

const variants = [
  { name: 'INPE', scope: 'https://example.test/rio-das-mortes/', cacheName: 'rio-das-mortes-v13' },
  { name: 'Google', scope: 'https://example.test/rio-das-mortes/google/', cacheName: 'rio-das-mortes-google-v3' }
];

function harnessFor(variant, { tileList = ['tiles/17/1/1.jpg'], entries = [], fetchImpl, putImpl } = {}) {
  const handlers = {};
  const messages = [];
  const store = new Map(entries.map(entry => {
    const [key, body = 'cached'] = Array.isArray(entry) ? entry : [entry];
    return [new URL(key, variant.scope).href, new Response(body)];
  }));
  const cache = {
    async match(key) {
      return store.get(new URL(typeof key === 'string' ? key : key.url, variant.scope).href)?.clone();
    },
    async put(key, response) {
      if (putImpl) return putImpl({ key, response, store, scope: variant.scope });
      store.set(new URL(typeof key === 'string' ? key : key.url, variant.scope).href, response.clone());
    },
    async delete(key) {
      return store.delete(new URL(typeof key === 'string' ? key : key.url, variant.scope).href);
    }
  };
  const context = {
    URL, Response, Promise,
    getTileList: () => tileList,
    fetch: fetchImpl || (async () => new Response('jpeg', { status: 200 })),
    caches: {
      async open() { return cache; },
      async keys() { return [variant.cacheName]; },
      async delete() { return true; }
    },
    self: {
      registration: { scope: variant.scope },
      clients: { async matchAll() { return [{ postMessage(message) { messages.push(message); } }]; } },
      addEventListener(type, handler) { handlers[type] = handler; }
    }
  };
  vm.createContext(context);
  vm.runInContext(engineSource, context);
  context.self.installOfflineRecovery({
    cacheName: variant.cacheName,
    cachePrefix: variant.cacheName.replace(/v\d+$/, 'v'),
    expectedPackageId: 'package-current',
    getTileList: () => tileList
  });

  function start(extra = {}) {
    let completion;
    handlers.message({
      data: {
        type: 'precache-tiles', packageId: 'package-current',
        expectedCount: tileList.length, ...extra
      },
      waitUntil(promise) { completion = promise; }
    });
    return completion;
  }

  return { start, handlers, messages, store };
}

for (const variant of variants) {
  {
    const tiles = ['tiles/17/1/1.jpg', 'tiles/17/1/2.jpg', 'tiles/17/1/3.jpg'];
    let fetches = 0;
    const h = harnessFor(variant, {
      tileList: tiles,
      entries: [tiles[0], tiles[1], ['offline-package-package-current.progress', '{}']],
      fetchImpl: async () => { fetches += 1; return new Response('jpeg', { status: 200 }); }
    });
    await h.start();
    assert.equal(fetches, 1, `${variant.name}: existing tiles are reused`);
    assert.equal(h.messages.at(-1).type, 'cache-complete');
    assert.equal(h.messages.at(-1).stored, 3);
    assert.equal([...h.store.keys()].some(url => url.endsWith('.progress')), false,
      `${variant.name}: the former fragile checkpoint is removed only after completion`);
  }

  {
    let rejectOneBody = true;
    const tile = 'tiles/17/2/1.jpg';
    const h = harnessFor(variant, {
      tileList: [tile],
      putImpl: async ({ key, response, store, scope }) => {
        const url = new URL(typeof key === 'string' ? key : key.url, scope).href;
        if (url.endsWith('.jpg') && rejectOneBody) {
          rejectOneBody = false;
          throw new DOMException('body interrupted', 'AbortError');
        }
        store.set(url, response.clone());
      }
    });
    await h.start();
    assert.equal(h.messages.at(-1).type, 'cache-recovery-exhausted');
    assert.equal('reasons' in h.messages.at(-1), false,
      `${variant.name}: an individual AbortError is not promoted to a fatal diagnostic`);
    assert.equal(h.messages.some(message => message.type === 'cache-runtime-blocked'), false);
    await h.start({ forceRetry: true });
    assert.equal(h.messages.at(-1).type, 'cache-complete',
      `${variant.name}: the next pass downloads the one still-missing tile`);
  }

  {
    let fetches = 0;
    let firstFetchStarted;
    const started = new Promise(resolve => { firstFetchStarted = resolve; });
    const h = harnessFor(variant, {
      fetchImpl: async () => {
        fetches += 1;
        if (fetches === 1) {
          firstFetchStarted();
          return new Promise(() => {});
        }
        return new Response('jpeg', { status: 200 });
      }
    });
    h.start();
    await started;
    await h.start({ forceRetry: true });
    assert.equal(fetches, 2,
      `${variant.name}: Continue starts a fresh scan even while an old request is stuck`);
    assert.equal(h.messages.at(-1).type, 'cache-complete');
  }

  {
    const h = harnessFor(variant);
    let completion;
    h.handlers.message({
      data: { type: 'precache-tiles', packageId: 'old-package', expectedCount: 1 },
      waitUntil(promise) { completion = promise; }
    });
    await completion;
    assert.equal(h.messages.at(-1).type, 'package-mismatch');
  }
}

console.log('Pindaiba-style offline recovery policy tests passed for INPE and Google');
