import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const scope = 'https://example.test/rio-das-mortes/';
const engine = fs.readFileSync(new URL('../offline-recovery-engine.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

assert.match(worker, /const CACHE_NAME = 'rio-das-mortes-v13';/,
  'the production cache identity must preserve partial downloads');
assert.match(worker, /importScripts\('\.\/tile-manifest\.js', '\.\/offline-recovery-engine\.js'\)/);
assert.match(worker, /Field-proven Pindaiba downloader/);

const handlers = {};
const store = new Map([[new URL('app.js', scope).href, new Response('cached-app')]]);
const cache = {
  async addAll() {},
  async match(key) { return store.get(new URL(typeof key === 'string' ? key : key.url, scope).href)?.clone(); },
  async put(key, value) { store.set(new URL(typeof key === 'string' ? key : key.url, scope).href, value.clone()); },
  async delete(key) { return store.delete(new URL(typeof key === 'string' ? key : key.url, scope).href); }
};
const context = {
  URL, Request, Response, Promise,
  importScripts() {},
  getTileList: () => ['tiles/17/1/1.jpg'],
  TILE_PACKAGE_META: { id: 'package-current' },
  fetch: async () => new Response('network'),
  caches: {
    async open() { return cache; },
    async keys() { return ['rio-das-mortes-v13']; },
    async delete() { return true; },
    async match() { throw new Error('must not use another package for shell assets'); }
  },
  self: {
    registration: { scope },
    clients: { async matchAll() { return []; }, async claim() {} },
    skipWaiting() {},
    addEventListener(type, handler) { handlers[type] = handler; }
  }
};
vm.createContext(context);
vm.runInContext(engine, context);
vm.runInContext(worker, context);

let responsePromise;
handlers.fetch({
  request: new Request(new URL('app.js', scope)),
  respondWith(promise) { responsePromise = promise; }
});
assert.equal(await (await responsePromise).text(), 'cached-app');

console.log('INPE worker regression tests passed');
