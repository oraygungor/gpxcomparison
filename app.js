/**
 * Multi-track GPX Comparator -- Overlap Detection & Stats Logic
 *
 * This script handles the application's core logic:
 * 1. Initializes Leaflet map and Chart.js chart.
 * 2. Dynamically adds file inputs AND a stats section to the DOM.
 * 3. Reads and parses GPX files.
 * 4. Draws tracks on the map and elevation profiles on the chart.
 * 5. When exactly two tracks are loaded, it:
 * a. Detects and highlights overlapping segments on the map.
 * b. Calculates total distance for each track, the overlap distance, and the difference.
 * c. Displays these statistics in the sidebar.
 */

document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const MAX_TRACKS = 4;
    const TRACK_COLORS = ['#007bff', '#dc3545', '#28a745', '#ffc107'];
    const OVERLAP_COLOR = '#d63384'; // Bright magenta for high visibility
    const OVERLAP_THRESHOLD_METERS = 20; // How close tracks need to be to be considered overlapping.

    // --- GLOBAL STATE ---
    let map;
    let elevationChart;
    let tracksData = []; // Array to hold all processed track data
    let mapLayers = []; // Array to hold map layers for easy removal
    let chartDatasets = []; // Array to hold chart datasets
    let overlapLayer = null; // Layer for the overlap polyline

    // --- DOM ELEMENTS ---
    const inputsDiv = document.getElementById('inputs');
    const addBtn = document.getElementById('addBtn');

    /**
     * Initializes the Leaflet map.
     */
    function initMap() {
        map = L.map('map').setView([41.0082, 28.9784], 10); // Default to Istanbul
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
    }

    /**
     * Initializes the Chart.js elevation chart.
     */
    function initChart() {
        const ctx = document.getElementById('elevChart').getContext('2d');
        elevationChart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: []
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        type: 'linear',
                        title: {
                            display: true,
                            text: 'Mesafe (km)'
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Yükseklik (m)'
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                    },
                },
                elements: {
                    point: {
                        radius: 0 // Hide points on the line for a cleaner look
                    }
                }
            }
        });
    }
    
    /**
     * Dynamically creates and injects the stats section into the sidebar.
     * This avoids needing to modify the HTML file manually.
     */
    function createStatsSection() {
        const sidebarContent = document.querySelector('.sidebar-content');
        if (!sidebarContent) return;

        const statsSection = document.createElement('section');
        statsSection.className = 'stats-section';
        statsSection.id = 'stats-section';
        statsSection.style.display = 'none'; // Initially hidden

        const title = document.createElement('h2');
        title.textContent = 'Karşılaştırma Sonuçları';

        const contentDiv = document.createElement('div');
        contentDiv.id = 'stats-content';
        // Basic styling for the stats list
        contentDiv.innerHTML = `
            <style>
                .stats-section ul { list-style-type: none; padding: 0; margin: 0; }
                .stats-section li { background-color: #f8f9fa; border: 1px solid #dee2e6; padding: 10px 15px; border-radius: 5px; margin-bottom: 8px; font-size: 0.95rem; display: flex; justify-content: space-between; }
                .stats-section li strong { color: #495057; }
            </style>
            <ul></ul>
        `;

        statsSection.appendChild(title);
        statsSection.appendChild(contentDiv);
        
        // Append after the chart section
        const chartSection = document.querySelector('.chart-section');
        if(chartSection) {
            chartSection.parentNode.insertBefore(statsSection, chartSection.nextSibling);
        } else {
            sidebarContent.appendChild(statsSection);
        }
    }


    /**
     * Adds a new file input element to the DOM.
     */
    function addFileInput() {
        const trackIndex = inputsDiv.children.length;
        if (trackIndex >= MAX_TRACKS) return;

        const container = document.createElement('div');
        container.className = 'input-container';
        container.style.display = 'flex';
        container.style.alignItems = 'center';
        container.style.marginBottom = '0.5rem';

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.gpx';
        input.dataset.index = trackIndex;
        input.style.flexGrow = '1';

        const colorIndicator = document.createElement('span');
        colorIndicator.style.cssText = `display: inline-block; width: 16px; height: 16px; background-color: ${TRACK_COLORS[trackIndex]}; border-radius: 50%; margin-right: 10px; flex-shrink: 0;`;
        
        container.appendChild(colorIndicator);
        container.appendChild(input);
        inputsDiv.appendChild(container);

        input.addEventListener('change', (event) => handleFileSelect(event, trackIndex));
        
        addBtn.disabled = inputsDiv.children.length >= MAX_TRACKS;
    }

    /**
     * Handles the file selection, parsing, and processing.
     */
    async function handleFileSelect(event, trackIndex) {
        const file = event.target.files[0];
        if (!file) return;

        addRemoveButton(event.target.parentElement, trackIndex, file.name);

        try {
            const gpxText = await file.text();
            const gpxParser = new gpxParser();
            gpxParser.parse(gpxText);
            processTrack(gpxParser, trackIndex);
            
            drawTrackOnMap(tracksData[trackIndex], trackIndex);
            drawTrackOnChart(tracksData[trackIndex], trackIndex);
            
            checkForOverlap();

        } catch (error) {
            console.error("Error parsing GPX file:", error);
            alert("GPX dosyası okunurken bir hata oluştu.");
        }
    }

    /**
     * Extracts and calculates data from the parsed GPX object.
     */
    function processTrack(gpx, trackIndex) {
        const points = gpx.tracks[0].points.map(p => ({
            lat: p.lat,
            lng: p.lon,
            ele: p.ele
        }));

        let cumulativeDistance = 0;
        const chartData = points.map((point, i) => {
            if (i > 0) {
                cumulativeDistance += gpx.calcDistanceBetween(points[i - 1], point);
            }
            return {
                x: cumulativeDistance / 1000, // distance in km
                y: point.ele // elevation in m
            };
        });

        tracksData[trackIndex] = {
            name: gpx.tracks[0].name || `Rota ${trackIndex + 1}`,
            points: points,
            chartData: chartData,
            color: TRACK_COLORS[trackIndex],
            totalDistance: (gpx.tracks[0].distance.total || cumulativeDistance) / 1000 // Total distance in km
        };
    }

    /**
     * Draws the track polyline on the Leaflet map.
     */
    function drawTrackOnMap(trackData, trackIndex) {
        if (mapLayers[trackIndex]) {
            map.removeLayer(mapLayers[trackIndex]);
        }
        
        const latlngs = trackData.points.map(p => [p.lat, p.lng]);
        const polyline = L.polyline(latlngs, {
            color: trackData.color,
            weight: 4,
            opacity: 0.8,
            offset: (trackIndex - 1.5) * 4 // Offset lines to avoid perfect overlap
        }).addTo(map);

        mapLayers[trackIndex] = polyline;
        map.fitBounds(polyline.getBounds().pad(0.1));
    }

    /**
     * Draws the elevation profile on the Chart.js chart.
     */
    function drawTrackOnChart(trackData, trackIndex) {
        if (chartDatasets[trackIndex]) {
            elevationChart.data.datasets[trackIndex] = null; // Placeholder
        }

        const newDataset = {
            label: `${trackData.name} (${trackData.totalDistance.toFixed(2)} km)`,
            data: trackData.chartData,
            borderColor: trackData.color,
            backgroundColor: trackData.color + '33', // Semi-transparent fill
            borderWidth: 2,
            fill: true,
        };
        
        chartDatasets[trackIndex] = newDataset;

        elevationChart.data.datasets = chartDatasets.filter(ds => ds);
        elevationChart.update();
    }
    
    /**
     * Adds a button to remove a loaded track.
     */
    function addRemoveButton(container, trackIndex, fileName) {
        const existingButton = container.querySelector('button');
        if (existingButton) existingButton.remove();
        
        const existingSpan = container.querySelector('span.file-name');
        if(existingSpan) existingSpan.remove();

        const nameSpan = document.createElement('span');
        nameSpan.textContent = `${fileName.length > 20 ? fileName.substring(0, 18) + '...' : fileName}`;
        nameSpan.className = 'file-name';
        nameSpan.style.fontSize = '0.9rem';
        nameSpan.style.color = '#6c757d';
        nameSpan.style.whiteSpace = 'nowrap';
        nameSpan.style.overflow = 'hidden';
        nameSpan.style.textOverflow = 'ellipsis';


        const removeBtn = document.createElement('button');
        removeBtn.textContent = '×';
        removeBtn.title = 'Rotayı kaldır';
        removeBtn.style.cssText = 'margin-left: 10px; cursor: pointer; border: none; background: #dc3545; color: white; border-radius: 50%; width: 22px; height: 22px; line-height: 22px; text-align: center; flex-shrink: 0;';
        
        container.querySelector('input').style.display = 'none';
        container.appendChild(nameSpan);
        container.appendChild(removeBtn);

        removeBtn.onclick = () => removeTrack(trackIndex, container);
    }
    
    /**
     * Removes a track's data, map layer, and chart dataset.
     */
    function removeTrack(trackIndex, container) {
        tracksData[trackIndex] = null;

        if (mapLayers[trackIndex]) {
            map.removeLayer(mapLayers[trackIndex]);
            mapLayers[trackIndex] = null;
        }

        if (chartDatasets[trackIndex]) {
            chartDatasets[trackIndex] = null;
            elevationChart.data.datasets = chartDatasets.filter(ds => ds);
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
        colorIndicator.style.cssText = `display: inline-block; width: 16px; height: 16px; background-color: ${TRACK_COLORS[trackIndex]}; border-radius: 50%; margin-right: 10px; flex-shrink: 0;`;
        
        container.appendChild(colorIndicator);
        container.appendChild(input);

        checkForOverlap();
    }

    // --- OVERLAP DETECTION & STATS LOGIC ---

    /**
     * Clears the stats display area.
     */
    function clearOverlapStats() {
        const statsSection = document.getElementById('stats-section');
        if (statsSection) {
            statsSection.style.display = 'none';
            const content = statsSection.querySelector('#stats-content ul');
            if(content) content.innerHTML = '';
        }
    }
    
    /**
     * Displays the calculated overlap statistics.
     */
    function displayOverlapStats(overlapKm, track1, track2) {
        const statsSection = document.getElementById('stats-section');
        const contentUl = statsSection.querySelector('#stats-content ul');
        if (!statsSection || !contentUl) return;

        const overlapKmFormatted = overlapKm.toFixed(2);
        const track1DiffKmFormatted = (track1.totalDistance - overlapKm).toFixed(2);
        const track2DiffKmFormatted = (track2.totalDistance - overlapKm).toFixed(2);

        contentUl.innerHTML = `
            <li><strong>Ortak Mesafe:</strong> <span>${overlapKmFormatted} km</span></li>
            <li><strong>${track1.name} Farkı:</strong> <span>${track1DiffKmFormatted} km</span></li>
            <li><strong>${track2.name} Farkı:</strong> <span>${track2DiffKmFormatted} km</span></li>
        `;
        statsSection.style.display = 'block';
    }

    /**
     * Checks if exactly two tracks are loaded and triggers analysis.
     */
    function checkForOverlap() {
        clearOverlapStats();
        if (overlapLayer) {
            map.removeLayer(overlapLayer);
            overlapLayer = null;
        }

        const activeTracks = tracksData.filter(t => t);
        if (activeTracks.length === 2) {
            findAndDrawOverlap(activeTracks[0], activeTracks[1]);
        }
    }

    /**
     * Finds overlap, draws it, and triggers stats display.
     */
    function findAndDrawOverlap(track1, track2) {
        const line1 = turf.lineString(track1.points.map(p => [p.lng, p.lat]));
        const line2 = turf.lineString(track2.points.map(p => [p.lng, p.lat]));

        const overlappingSegments = [];
        let currentSegment = [];

        for (const point1 of line1.geometry.coordinates) {
            const pt = turf.point(point1);
            const distance = turf.pointToLineDistance(pt, line2, { units: 'meters' });

            if (distance < OVERLAP_THRESHOLD_METERS) {
                currentSegment.push(point1);
            } else {
                if (currentSegment.length > 1) {
                    overlappingSegments.push(currentSegment);
                }
                currentSegment = [];
            }
        }
        if (currentSegment.length > 1) {
            overlappingSegments.push(currentSegment);
        }

        if (overlappingSegments.length > 0) {
            const leafletCoords = overlappingSegments.map(segment =>
                segment.map(coord => [coord[1], coord[0]])
            );

            overlapLayer = L.polyline(leafletCoords, {
                color: OVERLAP_COLOR,
                weight: 8,
                opacity: 0.75
            }).addTo(map);
            overlapLayer.bringToBack();
            
            // Calculate total length of overlap and display stats
            const overlapMultiLine = turf.multiLineString(overlappingSegments.map(s => s));
            const overlapKm = turf.length(overlapMultiLine, { units: 'kilometers' });
            displayOverlapStats(overlapKm, track1, track2);
        }
    }

    // --- INITIALIZATION ---
    initMap();
    initChart();
    createStatsSection(); // Dynamically add the stats area to the DOM
    addFileInput(); // Add the first file input
    addBtn.addEventListener('click', addFileInput);
});
