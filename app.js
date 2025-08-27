/**
 * Multi-track GPX Comparator -- Hardened build (fixed drawing & elevation; overlap in stable yellow)
 */

document.addEventListener('DOMContentLoaded', () => {
  // --- CONFIG ---
  const MAX_TRACKS = 4;
  const TRACK_COLORS = ['#007bff', '#dc3545', '#28a745', '#ffc107'];
  const OVERLAP_COLOR = '#ffd000';        // sabit: sarı
  const OVERLAP_THRESHOLD_METERS = 20;
  const RESAMPLE_STEP_METERS = 10;

  // --- STATE ---
  let map, canvasRenderer;
  let elevationChart;
  let tracksData = [];     // each: { name, points[{lat,lng,ele}], chartData[{x,y}], color, totalDistance }
  let mapLayers = [];      // polylines per index
  let chartDatasets = [];  // chart datasets per index
  let overlapLayer = null;

  const inputsDiv = document.getElementById('inputs');
  const addBtn = document.getElementById('addBtn');

  // --- Utils ---
  // Güvenli mesafe: gpxparser'ın calcDistanceBetween yoksa/hatalıysa kendi Haversine'ımızı kullan
  function safeDistMeters(gpxMaybe, a, b) {
    try {
      if (gpxMaybe && typeof gpxMaybe.calcDistanceBetween === 'function') {
        // gpxparser genelde {lat, lon} bekler
        return gpxMaybe.calcDistanceBetween(
          { lat: a.lat, lon: a.lng },
          { lat: b.lat, lon: b.lng }
        );
      }
    } catch (e) {
      // fallback'e düş
    }
    // fallback haversine
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
    const dφ = toRad(b.lat - a.lat);
    const dλ = toRad(b.lng - a.lng);
    const s = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // --- Map ---
  function initMap() {
    map = L.map('map', { preferCanvas: true }).setView([41.0082, 28.9784], 10);
    canvasRenderer = L.canvas({ padding: 0.5 });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  }

  // --- Chart ---
  function initChart() {
    const ctx = document.getElementById('elevChart').getContext('2d');
    elevationChart = new Chart(ctx, {
      type: 'line',
      data: { datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        interaction: { mode: 'index', intersect: false },
        elements: { point: { radius: 0 } },
        scales: {
          x: { type: 'linear', title: { display: true, text: 'Mesafe (km)' } },
          y: { title: { display: true, text: 'Yükseklik (m)' } }
        }
      }
    });
  }

  // --- Sidebar stats section ---
  function createStatsSection() {
    const sidebarContent = document.querySelector('.sidebar-content');
    if (!sidebarContent) return;
    const statsSection = document.createElement('section');
    statsSection.className = 'stats-section';
    statsSection.id = 'stats-section';
    statsSection.style.display = 'none';

    const title = document.createElement('h2');
    title.textContent = 'Karşılaştırma Sonuçları';

    const contentDiv = document.createElement('div');
    contentDiv.id = 'stats-content';
    contentDiv.innerHTML = `
      <style>
        .stats-section ul { list-style-type:none; padding:0; margin:0; }
        .stats-section li { background:#f8f9fa; border:1px solid #dee2e6; padding:10px 15px; border-radius:8px;
                            margin-bottom:8px; font-size:.95rem; display:flex; justify-content:space-between; }
        .stats-section li strong { color:#495057; }
      </style>
      <ul></ul>
    `;
    statsSection.appendChild(title);
    statsSection.appendChild(contentDiv);

    const chartSection = document.querySelector('.chart-section');
    if (chartSection) chartSection.parentNode.insertBefore(statsSection, chartSection.nextSibling);
    else sidebarContent.appendChild(statsSection);
  }

  // --- Inputs ---
  function addFileInput() {
    const trackIndex = inputsDiv.children.length;
    if (trackIndex >= MAX_TRACKS) return;

    const container = document.createElement('div');
    container.className = 'input-container';
    container.style.cssText = 'display:flex; align-items:center; margin-bottom:0.5rem;';

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gpx';
    input.dataset.index = trackIndex;
    input.style.flexGrow = '1';

    const colorIndicator = document.createElement('span');
    colorIndicator.style.cssText = `display:inline-block; width:16px; height:16px; background:${TRACK_COLORS[trackIndex]};
                                    border-radius:50%; margin-right:10px; flex-shrink:0;`;

    container.appendChild(colorIndicator);
    container.appendChild(input);
    inputsDiv.appendChild(container);

    input.addEventListener('change', (event) => handleFileSelect(event, trackIndex));
    addBtn.disabled = inputsDiv.children.length >= MAX_TRACKS;
  }

  async function handleFileSelect(event, trackIndex) {
    const file = event.target.files[0];
    if (!file) return;

    addRemoveButton(event.target.parentElement, trackIndex, file.name);

    try {
      const gpxText = await file.text();
      const parser = new gpxParser();
      parser.parse(gpxText);

      processTrack(parser, trackIndex);
      drawTrackOnMap(tracksData[trackIndex], trackIndex);
      drawTrackOnChart(tracksData[trackIndex], trackIndex);

      checkForOverlap();
    } catch (err) {
      console.error('GPX parse/handle error:', err);
      alert('GPX dosyası okunurken bir hata oluştu.');
    }
  }

  // --- Track processing ---
  function processTrack(gpx, trackIndex) {
    const tr = gpx && gpx.tracks && gpx.tracks[0];
    if (!tr || !Array.isArray(tr.points) || tr.points.length < 2) {
      throw new Error('Geçersiz/eksik GPX: yeterli nokta yok');
    }

    // points -> {lat,lng,ele}
    const rawPoints = tr.points.map(p => ({
      lat: p.lat,
      lng: p.lon,  // gpxparser noktasında 'lon' var; bizde 'lng' olarak saklıyoruz
      ele: (p.ele == null || isNaN(p.ele)) ? null : Number(p.ele)
    }));

    // toplam mesafe (metre) — güvenli mesafe fonksiyonu
    let cumulativeDistance = 0;
    for (let i = 1; i < rawPoints.length; i++) {
      cumulativeDistance += safeDistMeters(gpx, rawPoints[i - 1], rawPoints[i]);
    }

    // Chart data: yalnızca ele değeri olan noktaları plot et
    let chartDist = 0;
    const chartData = [];
    for (let i = 0; i < rawPoints.length; i++) {
      if (i > 0) chartDist += safeDistMeters(gpx, rawPoints[i - 1], rawPoints[i]);
      if (Number.isFinite(rawPoints[i].ele)) {
        chartData.push({ x: chartDist / 1000, y: rawPoints[i].ele });
      }
    }

    const totalDistanceMeters = (tr.distance && tr.distance.total) ? tr.distance.total : cumulativeDistance;

    tracksData[trackIndex] = {
      name: tr.name || `Rota ${trackIndex + 1}`,
      points: rawPoints,
      chartData,                         // [{x,y}] (ele yoksa boş kalabilir)
      color: TRACK_COLORS[trackIndex],
      totalDistance: totalDistanceMeters / 1000
    };
  }

  // --- Drawing ---
  function drawTrackOnMap(trackData, trackIndex) {
    if (!trackData || !Array.isArray(trackData.points) || trackData.points.length < 2) return;

    if (mapLayers[trackIndex]) map.removeLayer(mapLayers[trackIndex]);

    const latlngs = trackData.points.map(p => [p.lat, p.lng]);
    const polyline = L.polyline(latlngs, {
      color: trackData.color,
      weight: 4,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
      smoothFactor: 1.0,
      renderer: canvasRenderer
    }).addTo(map);

    mapLayers[trackIndex] = polyline;
    try {
      map.fitBounds(polyline.getBounds().pad(0.1));
    } catch (_) {
      // bazı edge-case'lerde fitBounds hata verebilir; görmezden gel
    }
  }

  function drawTrackOnChart(trackData, trackIndex) {
    // Ele hiç yoksa grafiğe dataset koymayalım (Chart.js NaN sorunlarını önler)
    if (!trackData || !Array.isArray(trackData.chartData) || trackData.chartData.length === 0) {
      chartDatasets[trackIndex] = null;
      elevationChart.data.datasets = chartDatasets.filter(Boolean);
      elevationChart.update();
      return;
    }
    const ds = {
      label: `${trackData.name} (${trackData.totalDistance.toFixed(2)} km)`,
      data: trackData.chartData,
      borderColor: trackData.color,
      backgroundColor: trackData.color + '33',
      borderWidth: 2,
      fill: false,
      spanGaps: true,
      pointRadius: 0
    };
    chartDatasets[trackIndex] = ds;
    elevationChart.data.datasets = chartDatasets.filter(Boolean);
    elevationChart.update();
  }

  function addRemoveButton(container, trackIndex, fileName) {
    container.querySelector('button')?.remove();
    container.querySelector('span.file-name')?.remove();

    const nameSpan = document.createElement('span');
    nameSpan.textContent = fileName.length > 26 ? fileName.substring(0, 24) + '…' : fileName;
    nameSpan.className = 'file-name';
    nameSpan.style.cssText = 'font-size:.9rem; color:#6c757d; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.title = 'Rotayı kaldır';
    removeBtn.style.cssText = 'margin-left:10px; cursor:pointer; border:none; background:#dc3545; color:#fff; border-radius:50%; width:22px; height:22px; line-height:22px; text-align:center; flex-shrink:0;';

    container.querySelector('input').style.display = 'none';
    container.appendChild(nameSpan);
    container.appendChild(removeBtn);

    removeBtn.onclick = () => removeTrack(trackIndex, container);
  }

  function removeTrack(trackIndex, container) {
    tracksData[trackIndex] = null;

    if (mapLayers[trackIndex]) {
      map.removeLayer(mapLayers[trackIndex]);
      mapLayers[trackIndex] = null;
    }
    if (chartDatasets[trackIndex]) {
      chartDatasets[trackIndex] = null;
      elevationChart.data.datasets = chartDatasets.filter(Boolean);
      elevationChart.update();
    }

    container.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gpx';
    input.dataset.index = trackIndex;
    input.style.flexGrow = '1';
    input.addEventListener('change', (event) => handleFileSelect(event, trackIndex));

    const colorIndicator = document.createElement('span');
    colorIndicator.style.cssText = `display:inline-block; width:16px; height:16px; background:${TRACK_COLORS[trackIndex]};
                                    border-radius:50%; margin-right:10px; flex-shrink:0;`;

    container.appendChild(colorIndicator);
    container.appendChild(input);

    checkForOverlap();
    addBtn.disabled = inputsDiv.children.length >= MAX_TRACKS;
  }

  // --- Overlap & stats ---
  function clearOverlapStats() {
    const statsSection = document.getElementById('stats-section');
    if (!statsSection) return;
    statsSection.style.display = 'none';
    const ul = statsSection.querySelector('#stats-content ul');
    if (ul) ul.innerHTML = '';
  }

  function displayOverlapStats(overlapKm, track1, track2) {
    const statsSection = document.getElementById('stats-section');
    const contentUl = statsSection?.querySelector('#stats-content ul');
    if (!statsSection || !contentUl) return;

    const overlapKmFormatted = overlapKm.toFixed(2);
    const t1 = Math.max(0, track1.totalDistance - overlapKm).toFixed(2);
    const t2 = Math.max(0, track2.totalDistance - overlapKm).toFixed(2);

    contentUl.innerHTML = `
      <li><strong>Ortak Mesafe:</strong> <span>${overlapKmFormatted} km</span></li>
      <li><strong>${track1.name} Farkı:</strong> <span>${t1} km</span></li>
      <li><strong>${track2.name} Farkı:</strong> <span>${t2} km</span></li>
    `;
    statsSection.style.display = 'block';
  }

  function checkForOverlap() {
    clearOverlapStats();
    if (overlapLayer) { map.removeLayer(overlapLayer); overlapLayer = null; }

    const active = tracksData.filter(Boolean);
    if (active.length === 2) {
      try { findAndDrawOverlap(active[0], active[1]); }
      catch (e) {
        console.warn('Overlap hesaplanamadı:', e);
      }
    }
  }

  function findAndDrawOverlap(track1, track2) {
    // kırılmaları engelle: en az 2 nokta olmalı
    if (track1.points.length < 2 || track2.points.length < 2) return;

    const ls1 = turf.lineString(track1.points.map(p => [p.lng, p.lat]));
    const ls2 = turf.lineString(track2.points.map(p => [p.lng, p.lat]));
    const len1 = turf.length(ls1, { units: 'kilometers' });
    const len2 = turf.length(ls2, { units: 'kilometers' });

    const shortLine = len1 <= len2 ? ls1 : ls2;
    const longLine  = len1 <= len2 ? ls2 : ls1;

    const stepKm = RESAMPLE_STEP_METERS / 1000;
    const shortLenKm = turf.length(shortLine, { units: 'kilometers' });
    const sampled = [];
    for (let d = 0; d <= shortLenKm; d += stepKm) {
      sampled.push(turf.along(shortLine, d, { units: 'kilometers' }).geometry.coordinates);
    }
    const lastCoord = shortLine.geometry.coordinates[shortLine.geometry.coordinates.length - 1];
    if (!sampled.length || sampled[sampled.length - 1][0] !== lastCoord[0] || sampled[sampled.length - 1][1] !== lastCoord[1]) {
      sampled.push(lastCoord);
    }

    const enterThresh = OVERLAP_THRESHOLD_METERS;
    const exitThresh  = OVERLAP_THRESHOLD_METERS + 5;

    const overlappingSegments = [];
    let current = [];
    let inside = false;

    for (const coord of sampled) {
      const distM = turf.pointToLineDistance(turf.point(coord), longLine, { units: 'meters' });
      if (!inside) {
        if (distM <= enterThresh) { inside = true; current.push(coord); }
      } else {
        if (distM <= exitThresh) { current.push(coord); }
        else { if (current.length > 1) overlappingSegments.push(current); current = []; inside = false; }
      }
    }
    if (current.length > 1) overlappingSegments.push(current);

    if (overlappingSegments.length) {
      const leafletCoords = overlappingSegments.map(seg => seg.map(c => [c[1], c[0]]));
      overlapLayer = L.polyline(leafletCoords, {
        color: OVERLAP_COLOR,
        weight: 8,
        opacity: 0.8,
        lineCap: 'round',
        lineJoin: 'round',
        renderer: canvasRenderer
      }).addTo(map);
      overlapLayer.bringToFront();

      const multi = turf.multiLineString(overlappingSegments);
      const overlapKm = turf.length(multi, { units: 'kilometers' });
      displayOverlapStats(overlapKm, track1, track2);
    }
  }

  // --- Init ---
  initMap();
  initChart();
  createStatsSection();
  addFileInput();
  addBtn.addEventListener('click', addFileInput);
});
