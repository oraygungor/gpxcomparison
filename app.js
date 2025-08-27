/**
 * Multi-track GPX Comparator -- Overlap Detection & Stats Logic (optimized)
 *
 * - Leaflet preferCanvas -> çok daha akıcı çizim
 * - Polylinelerde OFFSET KALDIRILDI (loop/halkaları önlemek için)
 * - Overlap algosu: kısa track'i sabit adımda yeniden örnekle (resample),
 *   diğer hattın lineString'i ile pointToLineDistance (metre) < eşik ise "içeride" say.
 *   Segmentleri birleştir, MultiLineString uzunluğunu hesapla, kalın tek kat overlap çiz.
 * - Chart.js animasyon/point kapalı -> daha hızlı.
 */

document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const MAX_TRACKS = 4;
    const TRACK_COLORS = ['#007bff', '#dc3545', '#28a745', '#ffc107'];
    const OVERLAP_COLOR = '#ffd000';
    const OVERLAP_THRESHOLD_METERS = 20;  // yakınlık eşiği
    const RESAMPLE_STEP_METERS = 10;      // resample aralığı (performans/hassasiyet dengesi)

    // --- GLOBAL STATE ---
    let map, canvasRenderer;
    let elevationChart;
    let tracksData = [];   // {name, points[{lat,lng,ele}], chartData[{x,y}], color, totalDistance}
    let mapLayers = [];    // L.Polyline
    let chartDatasets = [];
    let overlapLayer = null;

    // --- DOM ELEMENTS ---
    const inputsDiv = document.getElementById('inputs');
    const addBtn = document.getElementById('addBtn');

    /** Initializes the Leaflet map (canvas renderer for speed). */
    function initMap() {
        map = L.map('map', { preferCanvas: true }).setView([41.0082, 28.9784], 10);
        canvasRenderer = L.canvas({ padding: 0.5 });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
    }

    /** Initializes the Chart.js elevation chart (no animation, no points). */
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

    /** Dynamically creates stats section. */
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

    /** Add a new file input row. */
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

    /** Handle GPX file selection and render. */
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

    /** Extracts arrays and computes distance/elevation profile. */
    function processTrack(gpx, trackIndex) {
        const tr = gpx.tracks?.[0];
        if (!tr || !tr.points?.length) throw new Error('Empty GPX track');

        const points = tr.points.map(p => ({ lat: p.lat, lng: p.lon, ele: p.ele ?? 0 }));
        let cumulativeDistance = 0;

        const chartData = points.map((point, i) => {
            if (i > 0) cumulativeDistance += gpx.calcDistanceBetween(points[i - 1], point);
            return { x: cumulativeDistance / 1000, y: point.ele };
        });

        tracksData[trackIndex] = {
            name: tr.name || `Rota ${trackIndex + 1}`,
            points,
            chartData,
            color: TRACK_COLORS[trackIndex],
            totalDistance: (tr.distance?.total ?? cumulativeDistance) / 1000
        };
    }

    /** Draws track polyline (no offset to avoid loops). */
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
            // NOTE: offset intentionally removed to prevent circle artifacts
        }).addTo(map);

        mapLayers[trackIndex] = polyline;
        map.fitBounds(polyline.getBounds().pad(0.1));
    }

    /** Draws elevation dataset. */
    function drawTrackOnChart(trackData, trackIndex) {
        const ds = {
            label: `${trackData.name} (${trackData.totalDistance.toFixed(2)} km)`,
            data: trackData.chartData,
            borderColor: trackData.color,
            backgroundColor: trackData.color + '33',
            borderWidth: 2,
            fill: true,
            spanGaps: true
        };
        chartDatasets[trackIndex] = ds;
        elevationChart.data.datasets = chartDatasets.filter(Boolean);
        elevationChart.update();
    }

    /** Add remove button after file picked. */
    function addRemoveButton(container, trackIndex, fileName) {
        const existingBtn = container.querySelector('button');
        if (existingBtn) existingBtn.remove();
        const existingSpan = container.querySelector('span.file-name');
        if (existingSpan) existingSpan.remove();

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

    /** Remove a track from map, chart and UI. */
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
        colorIndicator.style.cssText = `display:inline-block; width:16px; height:16px; background:${TRACK_COLORS[trackIndex]}; border-radius:50%; margin-right:10px; flex-shrink:0;`;

        container.appendChild(colorIndicator);
        container.appendChild(input);

        checkForOverlap();
        addBtn.disabled = inputsDiv.children.length >= MAX_TRACKS ? true : false;
    }

    // --- OVERLAP DETECTION & STATS ---

    function clearOverlapStats() {
        const statsSection = document.getElementById('stats-section');
        if (statsSection) {
            statsSection.style.display = 'none';
            const ul = statsSection.querySelector('#stats-content ul');
            if (ul) ul.innerHTML = '';
        }
    }

    function displayOverlapStats(overlapKm, track1, track2) {
        const statsSection = document.getElementById('stats-section');
        const contentUl = statsSection?.querySelector('#stats-content ul');
        if (!statsSection || !contentUl) return;

        const overlapKmFormatted = overlapKm.toFixed(2);
        const track1DiffKmFormatted = Math.max(0, track1.totalDistance - overlapKm).toFixed(2);
        const track2DiffKmFormatted = Math.max(0, track2.totalDistance - overlapKm).toFixed(2);

        contentUl.innerHTML = `
            <li><strong>Ortak Mesafe:</strong> <span>${overlapKmFormatted} km</span></li>
            <li><strong>${track1.name} Farkı:</strong> <span>${track1DiffKmFormatted} km</span></li>
            <li><strong>${track2.name} Farkı:</strong> <span>${track2DiffKmFormatted} km</span></li>
        `;
        statsSection.style.display = 'block';
    }

    function checkForOverlap() {
        clearOverlapStats();
        if (overlapLayer) {
            map.removeLayer(overlapLayer);
            overlapLayer = null;
        }
        const active = tracksData.filter(Boolean);
        if (active.length === 2) {
            findAndDrawOverlap(active[0], active[1]);
        }
    }

    /**
     * Overlap finder:
     * - Kısa hattı sabit aralıkla (RESAMPLE_STEP_METERS) yeniden örnekle.
     * - Her örnek noktası için diğer hattın lineString'ine pointToLineDistance hesapla.
     * - Eşik altındaki noktaları ardışık segmentlere grupla.
     * - Segment uzunluklarını Turf.length ile topla, tek bir multiPolyline çiz.
     */
    function findAndDrawOverlap(track1, track2) {
        // choose shorter by length (km)
        const ls1 = turf.lineString(track1.points.map(p => [p.lng, p.lat]));
        const ls2 = turf.lineString(track2.points.map(p => [p.lng, p.lat]));
        const len1 = turf.length(ls1, { units: 'kilometers' });
        const len2 = turf.length(ls2, { units: 'kilometers' });

        const shortLine = len1 <= len2 ? ls1 : ls2;
        const longLine  = len1 <= len2 ? ls2 : ls1;
        const trackShort = len1 <= len2 ? track1 : track2;
        const trackLong  = len1 <= len2 ? track2 : track1;

        // resample shorter line at fixed step (meters)
        const stepKm = RESAMPLE_STEP_METERS / 1000;
        const shortLenKm = turf.length(shortLine, { units: 'kilometers' });
        const sampled = [];
        for (let d = 0; d <= shortLenKm; d += stepKm) {
            sampled.push(turf.along(shortLine, d, { units: 'kilometers' }).geometry.coordinates);
        }
        // ensure last point included exactly
        if (sampled.length === 0 || sampled[sampled.length - 1] !== shortLine.geometry.coordinates.slice(-1)[0]) {
            sampled.push(shortLine.geometry.coordinates.slice(-1)[0]);
        }

        // hysteresis ( giriş/çıkışta parazit engellemek için )
        const enterThresh = OVERLAP_THRESHOLD_METERS;      // içine girme eşiği
        const exitThresh  = OVERLAP_THRESHOLD_METERS + 5;  // çıkış için biraz tolerans

        const overlappingSegments = [];
        let current = [];
        let inside = false;

        for (const coord of sampled) {
            const pt = turf.point(coord);
            const distM = turf.pointToLineDistance(pt, longLine, { units: 'meters' });

            if (!inside) {
                if (distM <= enterThresh) {
                    inside = true;
                    current.push(coord);
                }
            } else {
                if (distM <= exitThresh) {
                    current.push(coord);
                } else {
                    if (current.length > 1) overlappingSegments.push(current);
                    current = [];
                    inside = false;
                }
            }
        }
        if (current.length > 1) overlappingSegments.push(current);

        if (overlappingSegments.length) {
            // draw as one polyline with multiple parts (multiPoly)
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

            // compute overlap length accurately
            const multi = turf.multiLineString(overlappingSegments);
            const overlapKm = turf.length(multi, { units: 'kilometers' });

            // display stats using original pair order (track1, track2) for names
            displayOverlapStats(overlapKm, track1, track2);
        }
    }

    // --- INITIALIZATION ---
    initMap();
    initChart();
    createStatsSection();
    addFileInput();
    addBtn.addEventListener('click', addFileInput);
});
