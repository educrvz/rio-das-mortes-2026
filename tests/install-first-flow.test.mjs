import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

const app = read('app.js');
const styles = read('style.css');
const rootWorker = read('sw.js');
const googleWorker = read('google/sw.js');
const recoveryEngine = read('offline-recovery-engine.js');

assert.doesNotMatch(
  app,
  /classList\.add\(['"]background-download['"]\)/,
  'the download screen must never collapse into a map overlay'
);
assert.doesNotMatch(
  styles,
  /#loading-overlay\.background-download/,
  'the compact map-overlay presentation must stay removed'
);
assert.doesNotMatch(rootWorker, /activePrecache && activePackageId/);
assert.doesNotMatch(googleWorker, /activePrecache && activePackageId/);
assert.doesNotMatch(recoveryEngine, /function abortActive\(/,
  'manual continuation must not cancel an in-flight download');
assert.doesNotMatch(recoveryEngine, /metadata\.forced/,
  'the only allowed AbortController cancellation is the per-request timeout');
assert.match(
  app,
  /setTimeout\(\(\) => \{[\s\S]*?showManualRetry\('O download pausou\.', 'Continuar download'\)/,
  'a silent worker must offer continuation without aborting it automatically'
);
assert.doesNotMatch(app, /Retomando automaticamente/);
assert.match(app, /Math\.max\(previousStored, Math\.min\(stored, total\)\)/);
assert.match(
  app,
  /function hydrateStoredProgress\(packageId, total\)/,
  'preflight must restore confirmed tile progress after a browser restart'
);
assert.match(
  app,
  /localStorage\.getItem\(packageProgressKey\(packageId\)\)/,
  'stored progress must be keyed by the imagery package identity'
);
assert.match(
  app,
  /localStorage\.setItem\(packageProgressKey\(currentPackageId\)/,
  'every confirmed stored count must refresh the durable preflight estimate'
);
assert.match(
  app,
  /hydrateStoredProgress\(packageId, total\);[\s\S]*?prepareOfflineStorage\(requiredBytes, total\)/,
  'preflight must run after persisted progress is restored'
);
assert.doesNotMatch(
  app,
  /register\([\s\S]*?\.catch\(\(\) => \{\s*hideLoading\(\)/,
  'a worker error must remain on the download screen'
);
assert.match(app, /function scheduleRecovery\(nextRetryAt\)/);

{
  const handlers = {};
  const posted = [];
  const elements = new Map();
  const storedValues = new Map();
  const timers = new Map();
  let nextTimer = 1;
  let reloads = 0;
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        textContent: '',
        style: { display: id === 'loading-overlay' ? 'block' : 'none' },
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; }
      });
    }
    return elements.get(id);
  };
  const recoveryHandlerStart = app.indexOf("navigator.serviceWorker.addEventListener('message'");
  const recoveryHandlerEnd = app.indexOf('\n  const workerUrl', recoveryHandlerStart);
  assert.notEqual(recoveryHandlerStart, -1);
  assert.notEqual(recoveryHandlerEnd, -1);
  const harnessSource = [
    app.match(/let lastProgress = \{ stored: 0, total: 0 \};/)[0],
    app.match(/let stallTimer = null;/)[0],
    app.match(/let recoveryTimer = null;/)[0],
    app.match(/let storagePrepared = false;/)[0],
    app.match(/let offlineDownloadActive = false;/)[0],
    app.match(/let wentOffline = navigator\.onLine === false;/)[0],
    app.match(/let terminalPackageBlocked = false;/)[0],
    app.match(/let offlinePackageReady = false;/)[0],
    app.match(/let currentPackageId = null;/)[0],
    "const OFFLINE_PROGRESS_KEY_PREFIX = 'test-offline-progress';",
    app.slice(app.indexOf('function packageProgressKey'), app.indexOf('async function prepareOfflineStorage')),
    'async function prepareOfflineStorage() { return true; }',
    app.slice(app.indexOf('async function startTilePreCache'), app.indexOf("window.addEventListener('beforeunload'")),
    app.slice(recoveryHandlerStart, recoveryHandlerEnd),
    app.match(/window\.addEventListener\('offline',[\s\S]*?\n}\);/)[0],
    app.match(/window\.addEventListener\('online',[\s\S]*?\n}\);/)[0],
    app.match(/document\.addEventListener\('visibilitychange',[\s\S]*?\n}\);/)[0]
  ].join('\n');
  const context = vm.createContext({
    TILE_PACKAGE_META: { id: 'test-package', count: 10, bytes: 1000 },
    Date: { now: () => 1_000 },
    navigator: {
      onLine: false,
      serviceWorker: {
        controller: { postMessage(message) { posted.push(message); } },
        addEventListener(type, handler) { handlers[type] = handler; }
      }
    },
    window: {
      location: { reload() { reloads++; } },
      addEventListener(type, handler) { handlers[type] = handler; }
    },
    document: {
      hidden: false,
      getElementById: element,
      addEventListener(type, handler) { handlers[type] = handler; }
    },
    localStorage: {
      getItem(key) { return storedValues.get(key) ?? null; },
      setItem(key, value) { storedValues.set(key, String(value)); },
      removeItem(key) { storedValues.delete(key); }
    },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    console
  });
  vm.runInContext(harnessSource, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const dispatch = data => handlers.message({ data: { packageId: 'test-package', ...data } });
  const runTimer = delay => {
    const match = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(match, `expected an active ${delay}ms timer`);
    timers.delete(match[0]);
    match[1].callback();
  };

  await vm.runInContext('startTilePreCache()', context);
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({
    type: 'precache-tiles', packageId: 'test-package', expectedCount: 10,
    forceRetry: false, onlineTransition: false, foregroundTransition: false
  }), 'initial download posts all recovery options explicitly');

  dispatch({ type: 'cache-progress', total: 10, stored: 3, failed: 0 });
  const postsBeforeStall = posted.length;
  runTimer(8_000);
  assert.equal(posted.length, postsBeforeStall,
    'the watchdog must never abort or restart an in-flight worker');
  assert.equal(element('resume-btn').style.display, 'inline-block',
    'a silent worker offers a manual continuation');
  assert.equal(element('resume-btn').textContent, 'Continuar download');
  element('resume-btn').onclick();
  await flush();
  assert.equal(posted.at(-1).forceRetry, true,
    'manual continuation asks the worker for a queued recovery pass');

  handlers.online();
  await flush();
  handlers.online();
  handlers.visibilitychange();
  await flush();
  assert.equal(posted.filter(message => message.onlineTransition).length, 1,
    'initial offline state grants exactly one online recovery');
  assert.equal(posted.at(-1).foregroundTransition, true,
    'foregrounding requests an immediate circuit probe');

  const beforeStaleMessage = element('progress-text').textContent;
  handlers.message({
    data: {
      type: 'cache-recovery-exhausted', packageId: 'old-package',
      total: 10, stored: 0, failed: 10
    }
  });
  assert.equal(element('progress-text').textContent, beforeStaleMessage,
    'messages from an old package cannot change the current UI');

  dispatch({ type: 'cache-recovery-wait', total: 10, stored: 3, failed: 2, nextRetryAt: 5_000 });
  assert.equal(element('resume-btn').style.display, 'none');
  assert.equal(element('loading-overlay').style.display, 'block', 'waiting cannot reveal the map');
  assert.equal([...timers.values()].some(timer => timer.delay === 4_000), true,
    'waiting schedules recovery for the worker deadline');
  const saved = JSON.parse(storedValues.get('test-offline-progress-test-package'));
  assert.equal(saved.stored, 3, 'confirmed worker count is persisted');
  runTimer(4_000);
  await flush();
  assert.equal(posted.at(-1).forceRetry, false, 'scheduled recovery is an ordinary continuation');

  dispatch({ type: 'cache-recovery-exhausted', total: 10, stored: 3, failed: 2 });
  assert.equal(element('resume-btn').style.display, 'inline-block');
  element('resume-btn').onclick();
  await flush();
  assert.equal(posted.at(-1).forceRetry, true, 'manual recovery posts an explicit force retry');
  assert.equal(element('loading-overlay').style.display, 'block', 'exhaustion cannot reveal the map');

  dispatch({ type: 'storage-blocked', total: 10, stored: 4, failed: 1 });
  assert.equal(element('resume-btn').style.display, 'inline-block');
  assert.equal(element('resume-btn').textContent, 'Verificar espaço e tentar novamente');
  assert.equal(element('loading-overlay').style.display, 'block', 'storage failure cannot reveal the map');

  dispatch({ type: 'package-integrity-blocked', total: 10, stored: 4, failed: 1 });
  assert.equal(element('resume-btn').style.display, 'none');
  assert.match(element('progress-text').textContent, /Arquivos do pacote não estão disponíveis/);
  assert.equal(element('loading-overlay').style.display, 'block', 'integrity failure cannot reveal the map');

  dispatch({
    type: 'cache-runtime-blocked', total: 10, stored: 0, failed: 0,
    reason: 'InvalidStateError'
  });
  assert.equal(element('resume-btn').style.display, 'inline-block');
  assert.equal(element('resume-btn').textContent, 'Continuar download');
  assert.match(element('progress-text').textContent, /Código: InvalidStateError/,
    'persistent Cache API failures expose a useful diagnostic code');
  element('resume-btn').onclick();
  await flush();
  assert.equal(posted.at(-1).forceRetry, true,
    'Cache API failures retry through the worker instead of only reloading the page');
  assert.equal(reloads, 0, 'Cache API recovery preserves the current page and its cached progress');
  assert.equal(element('loading-overlay').style.display, 'block', 'Cache API failure cannot reveal the map');

  dispatch({
    type: 'package-mismatch', expectedPackageId: 'new-package',
    total: 10, stored: 0, failed: 0
  });
  element('resume-btn').onclick();
  assert.equal(reloads, 1, 'package mismatch still offers a safe app restart');

  dispatch({ type: 'cache-complete', total: 10, stored: 10, failed: 0 });
  assert.equal(element('progress-text').textContent, 'Mapa offline pronto ✓');
  assert.equal(element('loading-overlay').style.display, 'block', 'completion waits for its display delay');
  runTimer(1_500);
  assert.equal(element('loading-overlay').style.opacity, '0');
  runTimer(500);
  assert.equal(element('loading-overlay').style.display, 'none', 'only exact completion reveals the map');
}
assert.match(app, /if \(\(terminalPackageBlocked \|\| offlinePackageReady\) && !forceRetry\) return;/);
assert.match(
  app,
  /cache-runtime-blocked[\s\S]*?showManualRetry\([\s\S]*?'Continuar download'/,
  'Cache API failures need a real worker continuation rather than a page reload'
);
assert.match(app, /let offlinePackageReady = false;/);
assert.match(
  app,
  /if \(packageChanged\) \{[\s\S]*?offlinePackageReady = false;/,
  'a changed package identity must invalidate prior ready state'
);
assert.match(
  app,
  /const remainingBytes = Math\.ceil\(requiredBytes \* \(1 - confirmedStored \/ total\)\);/,
  'storage preflight must reserve space only for unconfirmed tiles'
);

for (const prefix of ['', 'google/']) {
  const index = read(`${prefix}index.html`);
  const installer = read(`${prefix}instrucoes.html`);

  assert.match(index, /id="loading-overlay"/);
  assert.match(index, /O mapa aparecerá somente quando o download terminar\./);
  assert.match(index, /Parou\? Continuar download/);
  assert.match(installer, /id="tab-android"/);
  assert.match(installer, /id="tab-iphone"/);
  assert.match(installer, /BAIXAR E PREPARAR O MAPA/);
  assert.match(installer, /34\.994 de 34\.994 imagens/);
  assert.doesNotMatch(installer, /id="map"/);
}

console.log('Install-first UI regression tests passed');
