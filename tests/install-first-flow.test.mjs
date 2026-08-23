import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

const app = read('app.js');
const styles = read('style.css');
const rootWorker = read('sw.js');
const googleWorker = read('google/sw.js');

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
assert.match(rootWorker, /activeFetchControllers\.forEach\(controller => controller\.abort\(\)\)/);
assert.match(googleWorker, /activeFetchControllers\.forEach\(controller => controller\.abort\(\)\)/);
assert.match(app, /setTimeout\(\(\) => \{[\s\S]*?resume-btn[\s\S]*?8000\);/);
assert.match(app, /Math\.max\(previousLoaded, Math\.min\(loaded, total\)\)/);
assert.match(app, /setTimeout\(hideLoading, 1500\)/);
assert.doesNotMatch(
  app,
  /register\([\s\S]*?\.catch\(\(\) => \{\s*hideLoading\(\)/,
  'a worker error must remain on the download screen'
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
