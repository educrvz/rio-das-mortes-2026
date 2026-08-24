import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../google/reiniciar.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../google/reset-download.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../google/sw.js', import.meta.url), 'utf8');

assert.match(html, /APAGAR DOWNLOAD E COMEÇAR DO ZERO/);
assert.match(html, /reset-download\.js/);
assert.match(worker, /\.\/reiniciar\.html/);
assert.match(worker, /\.\/reset-download\.js/);

const listeners = {};
const deletedCaches = [];
const unregistered = [];
const replaced = [];
const storage = new Map([
  ['rio-das-mortes-google-user-notes-v1', '[{"text":"preservar"}]'],
  ['rio-das-mortes-google-user-notes-v1-offline-progress-active', 'old-package'],
  ['rio-das-mortes-google-user-notes-v1-offline-progress-old-package', '{"stored":14000}'],
  ['rio-das-mortes-user-notes-v1-offline-progress-active', 'inpe-package']
]);
const button = {
  disabled: false,
  textContent: '',
  addEventListener(type, handler) { listeners[type] = handler; }
};
const status = { textContent: '' };

const context = vm.createContext({
  URL,
  Date: { now: () => 1234 },
  Promise,
  caches: {
    async keys() {
      return ['rio-das-mortes-google-v2', 'rio-das-mortes-google-v3', 'rio-das-mortes-v13', 'carinhanha-v4'];
    },
    async delete(name) { deletedCaches.push(name); return true; }
  },
  navigator: {
    serviceWorker: {
      async getRegistrations() {
        return [
          { scope: 'https://example.test/rio-das-mortes/google/', async unregister() { unregistered.push('google'); } },
          { scope: 'https://example.test/other/', async unregister() { unregistered.push('other'); } }
        ];
      }
    }
  },
  localStorage: {
    get length() { return storage.size; },
    key(index) { return [...storage.keys()][index] ?? null; },
    removeItem(key) { storage.delete(key); }
  },
  document: {
    getElementById(id) { return id === 'reset-button' ? button : status; }
  },
  location: {
    href: 'https://example.test/rio-das-mortes/google/reiniciar.html',
    replace(url) { replaced.push(url); }
  },
  setTimeout(callback) { callback(); }
});

vm.runInContext(script, context);
await listeners.click();

assert.deepEqual(deletedCaches, [
  'rio-das-mortes-google-v2', 'rio-das-mortes-google-v3',
  'rio-das-mortes-google-v2', 'rio-das-mortes-google-v3'
]);
assert.deepEqual(unregistered, ['google'], 'only the Google Mortes service worker is unregistered');
assert.equal(storage.has('rio-das-mortes-google-user-notes-v1'), true, 'field notes are preserved');
assert.equal(storage.has('rio-das-mortes-google-user-notes-v1-offline-progress-active'), false);
assert.equal(storage.has('rio-das-mortes-google-user-notes-v1-offline-progress-old-package'), false);
assert.equal(storage.has('rio-das-mortes-user-notes-v1-offline-progress-active'), true,
  'the INPE edition progress is preserved');
assert.equal(replaced.length, 1);
assert.match(replaced[0], /^index\.html\?fresh=1234$/);

console.log('Google clean restart flow passed');
