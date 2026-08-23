import assert from 'node:assert/strict';
import fs from 'node:fs';

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
assert.match(recoveryEngine, /controllers\.forEach\(metadata => \{/);
assert.match(recoveryEngine, /metadata\.controller\.abort\(\)/);
assert.match(app, /setTimeout\(\(\) => \{[\s\S]*?Aguardando a rede[\s\S]*?8000\);/);
assert.doesNotMatch(
  app,
  /setTimeout\(\(\) => \{[\s\S]*?resume-btn[\s\S]*?8000\);/,
  'an eight-second gap must show a non-actionable waiting state, not manual retry'
);
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
assert.match(
  app,
  /cache-progress[\s\S]*?event\.data\.stored, event\.data\.failed/,
  'continuous worker progress must use its confirmed stored count'
);
assert.match(app, /setTimeout\(hideLoading, 1500\)/);
assert.doesNotMatch(
  app,
  /register\([\s\S]*?\.catch\(\(\) => \{\s*hideLoading\(\)/,
  'a worker error must remain on the download screen'
);
assert.match(app, /function scheduleRecovery\(nextRetryAt\)/);
assert.match(app, /cache-recovery-wait/);
assert.match(app, /cache-recovery-exhausted/);
assert.match(app, /storage-blocked/);
assert.match(app, /package-integrity-blocked/);
assert.match(app, /forceRetry: forceRetry === true/);
assert.match(app, /onlineTransition: onlineTransition === true/);
assert.match(app, /window\.addEventListener\('offline'/);
assert.match(app, /window\.addEventListener\('online'/);
assert.match(app, /document\.addEventListener\('visibilitychange'/);
assert.match(app, /if \(\(terminalPackageBlocked \|\| offlinePackageReady\) && !forceRetry\) return;/);
assert.match(
  app,
  /function showDownloadBlocked\(message\) \{[\s\S]*?button\.textContent = 'Reiniciar e tentar novamente';[\s\S]*?window\.location\.reload\(\)/,
  'generic worker failures need a reload action distinct from package force-retry'
);
assert.match(app, /let offlinePackageReady = false;/);
assert.match(
  app,
  /if \(packageChanged\) \{[\s\S]*?offlinePackageReady = false;/,
  'a changed package identity must invalidate prior ready state'
);
assert.match(
  app,
  /cache-complete[\s\S]*?offlinePackageReady = true;/,
  'only worker exact completion can mark the package ready'
);
assert.match(
  app,
  /package-integrity-blocked[\s\S]*?Arquivos do pacote não estão disponíveis na publicação/,
  'a missing deployed tile must not be presented as an ordinary retry'
);
assert.match(
  app,
  /cache-complete[\s\S]*?hideLoading/,
  'only the worker exact-complete message may reveal the map'
);
assert.match(
  app,
  /const remainingBytes = Math\.ceil\(requiredBytes \* \(1 - confirmedStored \/ total\)\);/,
  'storage preflight must reserve space only for unconfirmed tiles'
);
assert.match(
  app,
  /storagePrepared = false;[\s\S]*?showManualRetry\('O navegador não tem espaço suficiente/,
  'a storage-blocked worker result must force the manual retry to re-estimate space'
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
