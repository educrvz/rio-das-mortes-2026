let map, userMarker, watchId = null, autoCenter = true;
let routeLine, altRouteLine;
let roadLayers = [];
let roadsVisible = true;
const TOTAL_KM = ROUTE_DATA.totalKm;
const ALL_POIS = ROUTE_DATA.pois || [];
const ALL_HOSPITALS = ROUTE_DATA.hospitals || [];
let showAllKm = false;
let kmLabelLayers = [];
let kmDotLayers = [];
let savedNotes = [];
let noteLayers = [];
let noteCreationActive = false;
let speedSamples = [];
let lastNoteEditorOpenedAt = 0;
let lastProgress = { loaded: 0, total: 0, timestamp: 0 };
let stallTimer = null;
let storagePrepared = false;
let offlineDownloadActive = false;

const NOTES_STORAGE_KEY = 'rio-das-mortes-user-notes-v1';

const TRANSPARENT_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const OfflineTileLayer = L.TileLayer.extend({
  createTile: function(coords, done) {
    const tile = document.createElement('img');
    tile.alt = '';
    tile.setAttribute('role', 'presentation');
    const z = String(coords.z);
    const x = String(coords.x);
    const y = coords.y;

    if (typeof TILE_INDEX !== 'undefined') {
      const zData = TILE_INDEX[z];
      if (!zData || !zData[x] || zData[x].indexOf(y) === -1) {
        tile.src = TRANSPARENT_TILE;
        setTimeout(() => done(null, tile), 0);
        return tile;
      }
    }

    L.DomEvent.on(tile, 'load', () => done(null, tile));
    L.DomEvent.on(tile, 'error', () => { tile.src = TRANSPARENT_TILE; done(null, tile); });
    tile.crossOrigin = '';
    tile.src = this.getTileUrl(coords);
    return tile;
  }
});

function initMap() {
  const routeCoords = ROUTE_DATA.route.map(p => [p[1], p[0]]);
  const routeBounds = L.latLngBounds(routeCoords);
  const roadCoords = (ROUTE_DATA.roads || []).flatMap(road =>
    road.route.map(p => [p[1], p[0]])
  );
  const coverageBounds = L.latLngBounds([...routeCoords, ...roadCoords]);

  map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    maxZoom: 17,
    minZoom: 10,
    maxBounds: coverageBounds.pad(0.08),
    maxBoundsViscosity: 0.8
  });

  new OfflineTileLayer('tiles/{z}/{x}/{y}.jpg', {
    maxZoom: 17,
    minZoom: 10,
    tileSize: 256,
    bounds: coverageBounds.pad(0.03),
    keepBuffer: 6,
    updateWhenZooming: false,
    updateWhenIdle: true
  }).addTo(map);

  addRoads();

  routeLine = L.polyline(routeCoords,
    { color: '#f04a28', weight: 3.5, opacity: 0.95 }
  ).addTo(map);

  if (ROUTE_DATA.altRoute.length > 0) {
    altRouteLine = L.polyline(
      ROUTE_DATA.altRoute.map(p => [p[1], p[0]]),
      { color: '#d89524', weight: 2, opacity: 0.75, dashArray: '8,6' }
    ).addTo(map);
  }

  addKmMarkers();
  addPOIs();
  loadSavedNotes();
  setupNoteCreation();

  const mid = Math.floor(routeCoords.length / 2);
  map.setView(routeCoords[mid], 13);
}

function addRoads() {
  roadLayers = (ROUTE_DATA.roads || []).map(road =>
    L.polyline(
      road.route.map(p => [p[1], p[0]]),
      { color: '#d89524', weight: 2.5, opacity: 0.88, dashArray: '7,5' }
    ).bindTooltip(`${escapeHtml(road.name)} · ${road.lengthKm.toFixed(1)} km`)
      .on('click', () => showInfo(
        `<h3>🛣️ ${escapeHtml(road.name)}</h3><p>${road.lengthKm.toFixed(1)} km</p>`
      ))
      .addTo(map)
  );
}

function toggleRoads() {
  roadsVisible = !roadsVisible;
  document.getElementById('roads-toggle-btn').classList.toggle('active', roadsVisible);
  roadLayers.forEach(layer => {
    if (roadsVisible) layer.addTo(map);
    else map.removeLayer(layer);
  });
}

function addKmMarkers() {
  kmLabelLayers.forEach(layer => map.removeLayer(layer));
  kmDotLayers.forEach(layer => map.removeLayer(layer));
  kmLabelLayers = [];
  kmDotLayers = [];

  ROUTE_DATA.kmMarkers.forEach(marker => {
    const isStart = marker.km === 0;
    const isEnd = Math.abs(marker.km - TOTAL_KM) < 0.01;
    const isMajor = marker.km % 10 === 0;
    const isMinor = marker.km % 5 === 0;
    const showLabel = showAllKm || isStart || isEnd || isMajor;

    if (showLabel) {
      const label = isStart ? 'INÍCIO' : isEnd ? 'FIM' : `${marker.km} km`;
      const layer = L.marker([marker.lat, marker.lon], {
        icon: L.divIcon({
          className: 'km-marker-label',
          html: `<span style="font-size:${showAllKm && !isMajor ? 10 : 13}px">${label}</span>`,
          iconSize: [60, 16], iconAnchor: [30, 8]
        })
      }).addTo(map);
      kmLabelLayers.push(layer);
    }

    const dot = L.circleMarker([marker.lat, marker.lon], {
      radius: isMajor ? 4 : isMinor ? 2.5 : 1.5,
      fillColor: '#fff', fillOpacity: isMajor ? 0.9 : isMinor ? 0.6 : 0.3,
      color: '#fff', weight: 0.5, opacity: isMajor ? 0.9 : isMinor ? 0.6 : 0.3
    }).addTo(map).on('click', () => {
      showInfo(`<h3>Km ${marker.km}</h3><p>Restam ${(TOTAL_KM - marker.km).toFixed(1)} km</p>`);
    });
    kmDotLayers.push(dot);
  });
}

function toggleKmDetail() {
  showAllKm = !showAllKm;
  document.getElementById('km-toggle-btn').classList.toggle('active', showAllKm);
  addKmMarkers();
}

const poiLayers = {};
const poiVisible = { beach: false, exit: false, bridge: false, island: false, town: false, house: false, lagoon: false, airstrip: false };

function addPOIs() {
  const emojis = { beach: '🏖️', bridge: '🌉', exit: '🚗', island: '🏝️', town: '🏘️', house: '🏠', lagoon: '💧', airstrip: '🛩️' };

  ALL_POIS.forEach(poi => {
    const type = poi.type || 'beach';
    const emoji = emojis[type] || '📍';
    const sz = [26, 26];

    const marker = L.marker([poi.lat, poi.lon], {
      icon: L.divIcon({
        className: 'poi-emoji',
        html: emoji,
        iconSize: sz,
        iconAnchor: [sz[0]/2, sz[1]/2]
      })
    }).on('click', () => {
      let html = `<h3>${emoji} ${escapeHtml(poi.name)}</h3>`;
      if (Number.isFinite(poi.routeKm)) html += `<p>Km aproximado da rota: <strong>${poi.routeKm.toFixed(1)}</strong></p>`;
      if (poi.info) html += `<p style="font-size:24px; margin:8px 0">${escapeHtml(poi.info)}</p>`;
      if (poi.phone) html += `<p>📞 <a href="tel:${poi.phone.replace(/[^+\d]/g,'')}" style="color:#4af">${escapeHtml(poi.phone)}</a></p>`;
      if (!poi.phone) html += `<p>${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)}</p>`;
      const sourceUrl = safeHttpsOrLocalUrl(poi.sourceUrl);
      if (sourceUrl) html += `<p><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener" style="color:#4af">Fonte: ${escapeHtml(poi.source)}${poi.sourceCell ? ` · ${escapeHtml(poi.sourceCell)}` : ''}</a></p>`;
      showInfo(html);
    });

    if (poiVisible[type] !== false) marker.addTo(map);
    if (!poiLayers[type]) poiLayers[type] = [];
    poiLayers[type].push(marker);
  });
}

function configureAvailableLayers() {
  const hasHospitals = ALL_HOSPITALS.length > 0;
  if (ALL_POIS.length === 0 && !hasHospitals) {
    document.getElementById('poi-toggle-btn').style.display = 'none';
  }
  if (!hasHospitals) {
    document.getElementById('hospital-btn').style.display = 'none';
  }
  Object.keys(poiVisible).forEach(type => {
    if (!ALL_POIS.some(p => p.type === type)) {
      const button = document.getElementById('toggle-' + type);
      if (button) button.style.display = 'none';
    }
  });
}

function togglePOILayer(type) {
  poiVisible[type] = !poiVisible[type];
  const btn = document.getElementById('toggle-' + type);
  if (btn) btn.classList.toggle('active', poiVisible[type]);
  (poiLayers[type] || []).forEach(m => {
    if (poiVisible[type]) m.addTo(map);
    else map.removeLayer(m);
  });
}

function togglePOIDrawer() {
  const drawer = document.getElementById('poi-drawer');
  const button = document.getElementById('poi-toggle-btn');
  const isOpen = drawer.classList.toggle('open');
  button.classList.toggle('active', isOpen);
  button.setAttribute('aria-expanded', String(isOpen));
}

function showImageryStatus() {
  showInfo(
    '<h3>Imagens offline incluídas</h3>' +
    '<p>O pacote cobre o corredor do rio até zoom 17 e as cinco estradas logísticas até zoom 16.</p>' +
    '<p>Fonte: imagens coloridas de 2 m do satélite CBERS-4A/WPM, publicadas pelo INPE. Cenas selecionadas entre agosto de 2025 e agosto de 2026.</p>' +
    '<p><a href="https://data.inpe.br/bdc/stac/v1/collections/CB4A-WPM-PCA-FUSED-1" target="_blank" rel="noopener">Coleção oficial do INPE</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">Licença CC BY 4.0</a></p>'
  );
}

function showHospitals() {
  const hospitals = [...ALL_HOSPITALS];
  let userLat = null, userLon = null;
  if (userMarker) {
    const ll = userMarker.getLatLng();
    userLat = ll.lat;
    userLon = ll.lng;
  }

  let html = '<h3>🐍 Referências para acidentes com animais peçonhentos</h3>';
  html += '<p style="color:#ffcf66; font-size:12px">A relação oficial não confirma estoque em tempo real. Em uma emergência, ligue 192 ou 193.</p>';
  hospitals.sort((a, b) => {
    if (!userLat) return 0;
    return haversine(userLat, userLon, a.lat, a.lon) - haversine(userLat, userLon, b.lat, b.lon);
  });

  hospitals.forEach(h => {
    let dist = '';
    if (userLat) {
      const km = haversine(userLat, userLon, h.lat, h.lon);
      dist = `<span style="color:#4af; font-weight:700">${km.toFixed(0)} km</span> — `;
    }
    html += `<div style="margin:12px 0; padding:10px; background:rgba(255,255,255,0.08); border-radius:8px">`;
    html += `<p style="font-weight:700; font-size:15px">${escapeHtml(h.name)}</p>`;
    html += `<p>${escapeHtml(h.city)}/${escapeHtml(h.state)} · CNES ${escapeHtml(h.cnes)}</p>`;
    html += `<p>${escapeHtml(h.address)}</p>`;
    html += `<p style="font-size:13px; margin:5px 0">${h.antivenoms.map(escapeHtml).join(' · ')}</p>`;
    html += `<p style="font-size:12px; color:#bbb">${escapeHtml(h.routeContext)}</p>`;
    (h.phones || []).forEach(phone => {
      html += `<p>${dist}📞 <a href="tel:${phone.replace(/[^+\d]/g,'')}" style="color:#4af">${escapeHtml(phone)}</a></p>`;
      dist = '';
    });
    html += `<p style="color:#aaa; font-size:11px">Fonte oficial: ${ROUTE_DATA.emergencySource.sourceDate.split('-').reverse().join('/')} · verificado em ${ROUTE_DATA.emergencySource.checkedAt.split('-').reverse().join('/')}</p>`;
    html += `</div>`;
  });

  html += '<p style="margin-top:10px">☎️ <a href="tel:08007226001" style="color:#4af">Disque-Intoxicação: 0800 722 6001</a></p>';
  const officialUrl = safeHttpsOrLocalUrl(ROUTE_DATA.emergencySource.officialUrl);
  const sorojaUrl = safeHttpsOrLocalUrl(ROUTE_DATA.emergencySource.sorojaUrl);
  html += `<p><a href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener" style="color:#4af">Fonte: Ministério da Saúde</a> · <a href="${escapeHtml(sorojaUrl)}" target="_blank" rel="noopener" style="color:#4af">SoroJá</a></p>`;

  if (userLat) {
    html += '<p style="color:#ffcf66; font-size:12px">As distâncias mostradas são em linha reta; não representam trajeto por estrada nem tempo de viagem.</p>';
  }

  if (!userLat) {
    html += '<p style="color:#888; font-size:12px; margin-top:8px">Ative o GPS para ver distâncias</p>';
  }

  showInfo(html);
}

function findNearestKm(lat, lon) {
  let minDist = Infinity, nearest = null;
  ROUTE_DATA.kmMarkers.forEach(m => {
    const d = haversine(lat, lon, m.lat, m.lon);
    if (d < minDist) { minDist = d; nearest = m; }
  });
  return nearest;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function safeHttpsOrLocalUrl(value) {
  try {
    const url = new URL(String(value), window.location.href);
    if (url.protocol !== 'https:' && url.origin !== window.location.origin) return '';
    return url.href;
  } catch (error) {
    return '';
  }
}

function loadSavedNotes() {
  try {
    const stored = JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) || '[]');
    savedNotes = Array.isArray(stored) ? stored.filter(note =>
      Number.isFinite(note.lat) && Number.isFinite(note.lon) && typeof note.text === 'string'
    ) : [];
  } catch (error) {
    savedNotes = [];
  }
  renderSavedNotes();
}

function persistSavedNotes() {
  localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(savedNotes));
  renderSavedNotes();
}

function renderSavedNotes() {
  noteLayers.forEach(layer => map.removeLayer(layer));
  noteLayers = savedNotes.map(note => L.marker([note.lat, note.lon], {
    icon: L.divIcon({
      className: 'user-note-marker', html: '📌', iconSize: [30, 30], iconAnchor: [15, 28]
    }),
    zIndexOffset: 800
  }).addTo(map).on('click', () => showNoteDetails(note.id)));
  const notesCount = document.getElementById('notes-count');
  notesCount.textContent = savedNotes.length;
  notesCount.style.display = savedNotes.length ? 'block' : 'none';
}

function setupNoteCreation() {
  map.on('click', event => {
    if (noteCreationActive) openNoteEditor(event.latlng);
  });
}

function toggleNoteCreation() {
  noteCreationActive = !noteCreationActive;
  const button = document.getElementById('notes-btn');
  button.classList.toggle('active', noteCreationActive);
  button.setAttribute(
    'aria-label',
    noteCreationActive ? 'Desativar criação de anotações' : 'Ativar criação de anotações'
  );
  map.getContainer().classList.toggle('note-placement-active', noteCreationActive);

  if (noteCreationActive) {
    closeInfo();
  } else {
    showSavedNotes();
  }
}

function openNoteEditor(latlng) {
  if (Date.now() - lastNoteEditorOpenedAt < 500) return;
  lastNoteEditorOpenedAt = Date.now();
  if (watchId !== null) {
    autoCenter = false;
    document.getElementById('center-btn').classList.remove('active');
  }
  showInfo(
    `<h3>📌 Nova anotação</h3>` +
    `<p>${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</p>` +
    `<label for="note-text">O que há neste ponto?</label>` +
    `<textarea id="note-text" maxlength="240" placeholder="Ex.: Acampamento do dia 3"></textarea>` +
    `<button onclick="saveNote(${latlng.lat}, ${latlng.lng})">Salvar anotação</button>`
  );
  setTimeout(() => document.getElementById('note-text')?.focus(), 50);
}

function saveNote(lat, lon) {
  const input = document.getElementById('note-text');
  const text = input ? input.value.trim() : '';
  if (!text) {
    if (input) input.focus();
    return;
  }
  savedNotes.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    lat, lon, text, createdAt: new Date().toISOString()
  });
  persistSavedNotes();
  closeInfo();
}

function showNoteDetails(id) {
  const note = savedNotes.find(item => item.id === id);
  if (!note) return;
  const created = new Date(note.createdAt).toLocaleString('pt-BR');
  showInfo(
    `<h3>📌 Anotação</h3>` +
    `<p style="font-size:16px; color:#fff">${escapeHtml(note.text)}</p>` +
    `<p>${note.lat.toFixed(5)}, ${note.lon.toFixed(5)} · ${created}</p>` +
    `<button class="danger-action" onclick="deleteNote('${note.id}')">Excluir anotação</button>`
  );
}

function deleteNote(id) {
  savedNotes = savedNotes.filter(note => note.id !== id);
  persistSavedNotes();
  closeInfo();
}

function showSavedNotes() {
  let html = '<h3>📝 Minhas anotações</h3>';
  if (savedNotes.length === 0) {
    html += '<p>Nenhuma anotação salva.</p>';
  } else {
    savedNotes.forEach(note => {
      html += `<div class="note-card" onclick="focusNote('${note.id}')">`;
      html += `<p style="color:#fff; font-weight:700">${escapeHtml(note.text)}</p>`;
      html += `<p>${note.lat.toFixed(5)}, ${note.lon.toFixed(5)}</p></div>`;
    });
    html += '<button onclick="exportNotes()">Exportar arquivo</button>';
  }
  html += '<p style="margin-top:10px">Para adicionar pontos, ative 📝 e toque no mapa. Toque em 📝 novamente quando terminar.</p>';
  html += '<p style="margin-top:10px">As anotações ficam somente neste aparelho até serem exportadas.</p>';
  showInfo(html);
}

function focusNote(id) {
  const note = savedNotes.find(item => item.id === id);
  if (!note) return;
  map.setView([note.lat, note.lon], Math.max(map.getZoom(), 16));
  showNoteDetails(id);
}

async function exportNotes() {
  const payload = {
    app: 'Rio das Mortes 2026', exportedAt: new Date().toISOString(), notes: savedNotes
  };
  const filename = `rio-das-mortes-anotacoes-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const file = new File([blob], filename, { type: 'application/json' });
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ title: 'Anotações Rio das Mortes 2026', files: [file] });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updateSpeed(speedMetersPerSecond) {
  const display = document.getElementById('speed-display');
  if (!Number.isFinite(speedMetersPerSecond) || speedMetersPerSecond < 0) {
    if (speedSamples.length === 0) display.textContent = '-- km/h';
    return;
  }
  speedSamples.push(speedMetersPerSecond * 3.6);
  if (speedSamples.length > 5) speedSamples.shift();
  const smoothed = speedSamples.reduce((sum, speed) => sum + speed, 0) / speedSamples.length;
  display.textContent = `${smoothed < 0.5 ? '0.0' : smoothed.toFixed(1)} km/h`;
}

function findNearestPOI(lat, lon) {
  let minDist = Infinity, nearest = null;
  ALL_POIS.forEach(p => {
    const d = haversine(lat, lon, p.lat, p.lon);
    if (d < minDist) { minDist = d; nearest = { ...p, dist: d }; }
  });
  return nearest;
}

function toggleGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    document.getElementById('gps-btn').classList.remove('active');
    document.getElementById('center-btn').style.display = 'none';
    document.getElementById('coords-display').style.display = 'none';
    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
    document.getElementById('remaining-display').textContent = '-- km';
    document.getElementById('speed-display').textContent = '-- km/h';
    speedSamples = [];
    return;
  }

  if (!navigator.geolocation) {
    alert('GPS não disponível neste dispositivo');
    return;
  }

  document.getElementById('gps-btn').classList.add('active');
  document.getElementById('center-btn').style.display = 'flex';
  document.getElementById('coords-display').style.display = 'block';
  autoCenter = true;
  document.getElementById('center-btn').classList.add('active');

  watchId = navigator.geolocation.watchPosition(
    onPosition,
    onPositionError,
    { enableHighAccuracy: true, timeout: 30000, maximumAge: 5000 }
  );
}

function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy, speed } = pos.coords;

  if (!userMarker) {
    userMarker = L.marker([lat, lon], {
      icon: L.divIcon({ className: 'user-marker', iconSize: [20, 20], iconAnchor: [10, 10] }),
      zIndexOffset: 1000,
      interactive: false,
      keyboard: false
    }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lon]);
  }

  if (autoCenter) {
    map.setView([lat, lon], Math.max(map.getZoom(), 15));
  }

  const nearest = findNearestKm(lat, lon);
  if (nearest) {
    document.getElementById('remaining-display').textContent = `${(TOTAL_KM - nearest.km).toFixed(1)} km`;
  }

  document.getElementById('coords-display').textContent =
    `${lat.toFixed(5)}, ${lon.toFixed(5)} | ±${accuracy.toFixed(0)}m`;
  updateSpeed(speed);
}

function onPositionError(err) {
  if (err.code === 1) {
    alert('Permissão de GPS negada. Ative a localização nas configurações.');
  } else {
    console.warn('GPS error:', err.message);
  }
}

function toggleCenter() {
  autoCenter = !autoCenter;
  document.getElementById('center-btn').classList.toggle('active', autoCenter);
  if (autoCenter && userMarker) {
    map.setView(userMarker.getLatLng(), Math.max(map.getZoom(), 15));
  }
}

function showInfo(html) {
  document.getElementById('info-content').innerHTML = html;
  document.getElementById('info-panel').style.display = 'block';
}
function closeInfo() {
  document.getElementById('info-panel').style.display = 'none';
}

function updateProgress(loaded, total, stored, failed = 0, reused = 0) {
  const pct = Math.round((loaded / total) * 100);
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-bar').setAttribute('aria-valuenow', String(pct));
  if (failed > 0) {
    document.getElementById('progress-text').textContent =
      `${pct}% — ${failed.toLocaleString('pt-BR')} imagens precisam ser repetidas`;
  } else if (reused > 0 && reused === loaded) {
    document.getElementById('progress-text').textContent = `${pct}% — Já baixado!`;
  } else {
    document.getElementById('progress-text').textContent = `${pct}% — ${loaded.toLocaleString()} de ${total.toLocaleString()} imagens`;
  }

  lastProgress = { loaded, total, timestamp: Date.now() };
  resetStallDetection();
}

function resetStallDetection() {
  if (stallTimer) clearTimeout(stallTimer);
  document.getElementById('resume-btn').style.display = 'none';

  stallTimer = setTimeout(() => {
    const pct = Math.round((lastProgress.loaded / lastProgress.total) * 100);
    if (pct < 100) {
      document.getElementById('resume-btn').style.display = 'inline-block';
    }
  }, 20000);
}

function resumeDownload() {
  document.getElementById('resume-btn').style.display = 'none';
  document.getElementById('progress-text').textContent = 'Retomando download...';
  startTilePreCache();
}

function hideLoading() {
  if (stallTimer) clearTimeout(stallTimer);
  const overlay = document.getElementById('loading-overlay');
  overlay.style.transition = 'opacity 0.5s';
  overlay.style.opacity = '0';
  setTimeout(() => overlay.style.display = 'none', 500);
}

async function prepareOfflineStorage(requiredBytes) {
  if (storagePrepared) return true;
  if (navigator.storage?.persist) {
    try { await navigator.storage.persist(); } catch (error) {}
  }
  if (navigator.storage?.estimate && requiredBytes > 0) {
    try {
      const estimate = await navigator.storage.estimate();
      const available = (estimate.quota || 0) - (estimate.usage || 0);
      if (estimate.quota && available < requiredBytes * 1.25) {
        const neededMb = Math.ceil((requiredBytes * 1.25 - available) / 1024 / 1024);
        document.getElementById('progress-text').textContent =
          `Faltam aproximadamente ${neededMb.toLocaleString('pt-BR')} MB livres no navegador.`;
        document.getElementById('resume-btn').style.display = 'inline-block';
        return false;
      }
    } catch (error) {}
  }
  storagePrepared = true;
  return true;
}

async function startTilePreCache(attempt = 0) {
  if (!navigator.serviceWorker.controller) {
    document.getElementById('progress-text').textContent = 'Ativando o modo offline…';
    return;
  }

  const total = typeof TILE_PACKAGE_META !== 'undefined' ? TILE_PACKAGE_META.count : 0;
  if (total === 0) {
    document.getElementById('download-size').textContent = 'App base pronta; imagens offline ainda não incluídas.';
    document.getElementById('progress-text').textContent = 'Rota, estradas e POIs disponíveis';
    document.getElementById('progress-fill').style.width = '100%';
    setTimeout(hideLoading, 1800);
    return;
  }

  if (typeof TILE_PACKAGE_META !== 'undefined' && TILE_PACKAGE_META.bytes) {
    const sizeMb = Math.round(TILE_PACKAGE_META.bytes / 1024 / 1024);
    document.getElementById('download-size').textContent =
      `Preparando ${total.toLocaleString('pt-BR')} imagens offline (${sizeMb} MB).`;
  } else {
    document.getElementById('download-size').textContent =
      `Preparando ${total.toLocaleString('pt-BR')} imagens offline.`;
  }
  const requiredBytes = typeof TILE_PACKAGE_META !== 'undefined' ? TILE_PACKAGE_META.bytes : 0;
  if (!(await prepareOfflineStorage(requiredBytes))) return;
  document.getElementById('progress-text').textContent = `0% — 0 de ${total.toLocaleString('pt-BR')} imagens`;
  resetStallDetection();
  offlineDownloadActive = true;

  navigator.serviceWorker.controller.postMessage({
    type: 'precache-tiles',
    packageId: typeof TILE_PACKAGE_META !== 'undefined' ? TILE_PACKAGE_META.id : 'current',
    expectedCount: total
  });
}

window.addEventListener('beforeunload', event => {
  if (!offlineDownloadActive) return;
  event.preventDefault();
  event.returnValue = '';
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data.type === 'cache-progress') {
      updateProgress(event.data.loaded, event.data.total, event.data.stored, event.data.failed, event.data.reused);
    }
    if (event.data.type === 'cache-complete') {
      offlineDownloadActive = false;
      if (stallTimer) clearTimeout(stallTimer);
      document.getElementById('resume-btn').style.display = 'none';
      document.getElementById('progress-text').textContent = 'Mapa offline pronto ✓';
      document.getElementById('progress-fill').style.width = '100%';
      document.getElementById('progress-bar').setAttribute('aria-valuenow', '100');
      setTimeout(hideLoading, 1500);
    }
    if (event.data.type === 'cache-incomplete') {
      offlineDownloadActive = false;
      if (stallTimer) clearTimeout(stallTimer);
      const failed = event.data.failed || (event.data.total - event.data.stored);
      document.getElementById('progress-text').textContent =
        `${failed.toLocaleString('pt-BR')} imagens não baixaram. Toque para repetir.`;
      document.getElementById('resume-btn').style.display = 'inline-block';
    }
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (navigator.serviceWorker.controller) {
      startTilePreCache();
    } else {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        startTilePreCache();
      });
    }
  }).catch(() => {
    hideLoading();
  });
} else {
  hideLoading();
}

initMap();
configureAvailableLayers();
requestAnimationFrame(() => {
  document.getElementById('loading-overlay').classList.add('background-download');
});

map.on('movestart', () => {
  if (watchId !== null) {
    autoCenter = false;
    document.getElementById('center-btn').classList.remove('active');
  }
});
