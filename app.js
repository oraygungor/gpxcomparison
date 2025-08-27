/**
 * Multi-track GPX Comparator -- Overlap Detection & Stats Logic (optimized, elevation fix)
 */

document.addEventListener('DOMContentLoaded', () => {
  // --- CONFIGURATION ---
  const MAX_TRACKS = 4;
  const TRACK_COLORS = ['#007bff', '#dc3545', '#28a745', '#ffc107'];
  let OVERLAP_COLOR = '#ffd000';          // default: Sarı
  const OVERLAP_THRESHOLD_METERS = 20;
  const RESAMPLE_STEP_METERS = 10;

  // --- GLOBAL STATE ---
  let map, canvasRenderer;
  let elevationChart;
  let tracksData = [];
  let mapLayers = [];
  let chartDatasets = [];
  let overlapLayer = null;

  // --- DOM ELEMENTS ---
  const inputsDiv = document.getElementById('inputs');
  const addBtn = document.getElementById('addBtn');

  // küçük yardımcı fonksiyon: calcDistanceBetween doğru çalışsın diye lon/lng farkını gider
  function distMeters(gpx, a, b) {
    return gpx.calcDistanceBetween(
      { lat: a.lat, lon: a.lng },
      { lat: b.lat, lon: b.lng }
    );
  }

  /** Initializes the Leaflet map (canvas renderer). */
  function initMap() {
    map = L.map('map', { preferCanvas: true }).setView([41.0082, 28.9784], 10);
    canvasRenderer = L.canvas({ padding: 0.5 });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
  }

  /** Initializes Chart.js chart. */
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

  /** Stats section. */
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
        .stats-section li { background:#f8f9fa; border:1px solid #dee2e6; padding:10px 15px; border-radius:8px; margin-bottom:8px; font-size:.95rem; display:flex; justify-content:space-between; }
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

  /** File input ekler. */
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
    colorIndicator.style.cssText = `display:inline-block; width:16px; height:16px; background:${TRACK_COLORS[trackIndex]}; border-radius:50%; margin-right:10px; flex-shrink:0;`;

    container.appendChild(colorIndicator);
    container.appendChild(input);
    inputsDiv.appendChild(container);

    input.addEventListener('change', (event) => handleFileSelect(event, trackIndex));
    addBtn.disabled = inputsDiv.children.length >= MAX_TRACKS;
  }

  /** File select handler. */
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
      console.error('Error parsing GPX:', err);
      alert('GPX dosyası okunurken bir hata oluştu.');
    }
  }

  /** GPX verisini işler (mesafe + elevasyon). */
  function processTrack(gpx, trackIndex) {
    const tr = gpx.tracks?.[0];
    if (!tr || !tr.points?.length) throw new Error('Empty GPX track');

    const rawPoints = tr.points.map(p => ({
      lat: p.lat,
      lng: p.lon, // dikkat: biz lng tutuyoruz
      ele: (p.ele == null || isNaN(p.ele)) ? null : Number(p.ele)
    }));

    // toplam mesafe metre
    let cumulativeDistance = 0;
    for (let i = 1; i < rawPoints.length; i++) {
      cumulativeDistance += distMeters(gpx, rawPoints[i - 1], rawPoints[i]);
    }

    // chart datası
    let chartDist = 0;
    const chartData = [];
    for (let i = 0; i < rawPoints.length; i++) {
      if (i > 0) chartDist += distMeters(gpx, rawPoints[i - 1], rawPoints[i]);
      if (Number.isFinite(rawPoints[i].ele)) {
        chartData.push({ x: chartDist / 1000, y: rawPoints[i].ele });
      }
    }

    const totalDistanceMeters = tr.distance?.total ?? cumulativeDistance;

    tracksData[trackIndex] = {
      name: tr.name || `Rota ${trackIndex + 1}`,
      points: rawPoints,
      chartData,
      color: TRACK_COLORS[trackIndex],
      totalDistance: totalDistanceMeters / 1000
    };
  }

  /** Polyline çizer. */
  function drawTrackOnMap(trackData, trackIndex) {
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
    map.fitBounds(polyline.getBounds().pad(0.1));
  }

  /** Elevation chart çizer. */
  function drawTrackOnChart(trackData, trackIndex) {
    if (!trackData.chartData.length) {
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

  /** ... removeTrack, overlap detection vs (önceki kodun aynısı, değişiklik yok) ... */
  // (Burayı uzun olmaması için kısaltıyorum, ama sende zaten var — sadece processTrack ve distMeters değişti)

  // --- INITIALIZATION ---
  initMap();
  initChart();
  createStatsSection();
  addFileInput();
  addBtn.addEventListener('click', addFileInput);

  // Renk seçici
  document.getElementById('overlap-color-tools')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ovc]');
    if (!btn) return;
    OVERLAP_COLOR = btn.getAttribute('data-ovc') || OVERLAP_COLOR;
    if (overlapLayer) overlapLayer.setStyle({ color: OVERLAP_COLOR });
  });
});
