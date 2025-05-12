/********************************************************************
 *  app.js  –  ANY number of GPX tracks (Leaflet + Turf + Chart.js)
 ********************************************************************/
document.addEventListener('DOMContentLoaded', () => {
    /* ——— constants ——— */
    const COLOURS = ['blue', 'red', 'green', 'purple', 'orange', 'brown'];
    const MAX_FILES = 4;                 // raise / remove if you want

    /* ——— map ——— */
    const map = L.map('map').setView([46.5, 8.5], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    /* ——— dynamic inputs ——— */
    const inputsDiv = document.getElementById('inputs');
    const addBtn    = document.getElementById('addBtn');

    const tracks = [];        // {file, layer, profile, colour, stats, name}

    addBtn.onclick = () => {
        if (tracks.length >= MAX_FILES) return alert('Limit reached.');
        const idx = tracks.length;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <label>GPX ${idx + 1}
                <input type="file" accept=".gpx">
            </label>
            <span id="stats-${idx}">—</span>
            <button type="button">✖</button>
        `;
        const [input, removeBtn] = wrapper.querySelectorAll('input,button');
        inputsDiv.appendChild(wrapper);

        input.onchange = e => loadFile(e.target.files[0], idx);
        removeBtn.onclick = () => { clearTrack(idx); wrapper.remove(); };
    };

    addBtn.click();   // add first picker on load

    /* ——— helpers (haversine etc.) ——— */
    const toRad = d => d * Math.PI / 180, R = 6371000;
    const dist = (a, b) => 2*R*Math.asin(Math.sqrt(
        Math.sin((toRad(b.lat-a.lat))/2)**2 +
        Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*
        Math.sin((toRad(b.lon-a.lon))/2)**2 ));

    const clean = (pts, tol=2) => {
        const o=[pts[0]]; for(let i=1;i<pts.length;i++)
            if(dist(o[o.length-1],pts[i])>=tol) o.push(pts[i]);
        return o.length>5000?o.filter((_,i)=>i%Math.ceil(o.length/5000)===0):o;
    };

    const stats = pts => {
        let d=0,g=0,l=0;
        for(let i=1;i<pts.length;i++){
            const seg=dist(pts[i-1],pts[i]);
            d+=seg;
            const dh=pts[i].ele-pts[i-1].ele;
            dh>0?g+=dh:l-=dh;
        }
        return {km:d/1000,gain:g,loss:l};
    };

    const makeProfile = pts => {
        let d=0,arr=[{x:0,y:pts[0].ele}];
        for(let i=1;i<pts.length;i++){d+=dist(pts[i-1],pts[i]);
            arr.push({x:d/1000,y:pts[i].ele});}
        return arr;
    };

    const toLatLngs = geom =>
        (geom.geometry.type==='LineString'?geom.geometry.coordinates
                                          :geom.geometry.coordinates.flat())
            .map(c=>[c[1],c[0]]);

    const safeOffset = (base,m)=> {
        try{const o=turf.lineOffset(base,m,{units:'meters'});
             return o.geometry.coordinates.flat().every(
               c=>isFinite(c[0])&&isFinite(c[1]))?o:base;}catch{return base;}
    };

    /* ——— chart.js set-up ——— */
    const ctx = document.getElementById('elevChart').getContext('2d');
    const chart = new Chart(ctx,{
        type:'line',
        data:{datasets:[]},
        options:{
            plugins:{legend:{position:'top'}},
            scales:{
                x:{type:'linear',title:{display:true,text:'Distance (km)'}},
                y:{title:{display:true,text:'Elevation (m)'}}
            }
        }
    });

    /* ——— core functions ——— */
    function loadFile(file, idx){
        if(!file) return;
        const reader=new FileReader();
        reader.onload=e=>{
            const gpx=new gpxParser(); gpx.parse(e.target.result);
            if(!gpx.tracks.length) return alert('No track!');
            const raw=gpx.tracks[0].points;
            const pts=clean(raw,2);
            const base={type:'Feature',
                geometry:{type:'LineString',
                          coordinates:pts.map(p=>[p.lon,p.lat])}};
            const colour=COLOURS[idx%COLOURS.length];
            const geom=safeOffset(base, (idx-Math.floor(tracks.length/2))*10);
            const latlngs=toLatLngs(geom);
            const layer=L.polyline(latlngs,{
                color:colour,weight:4,opacity:0.85}).addTo(map);

            const st=stats(pts); const prof=makeProfile(pts);
            tracks[idx]={file,layer,profile:prof,colour,stats:st,
                         name:gpx.tracks[0].name||file.name};

            document.getElementById(`stats-${idx}`).textContent =
                `${st.km.toFixed(1)} km / ↑${st.gain.toFixed(0)} m / ↓${st.loss.toFixed(0)} m`;
            refresh();
        };
        reader.readAsText(file);
    }

    function clearTrack(idx){
        const t=tracks[idx]; if(!t) return;
        map.removeLayer(t.layer);
        tracks[idx]=null;
        refresh();
    }

    function refresh(){
        /* fit map */
        const layers=tracks.filter(Boolean).map(t=>t.layer);
        if(layers.length) map.fitBounds(L.featureGroup(layers).getBounds(),
                                        {padding:[20,20]});
        else map.setView([46.5,8.5],5);

        /* chart */
        chart.data.datasets = tracks.filter(Boolean).map(t=>({
            label:t.name, data:t.profile,
            borderColor:t.colour,pointRadius:0,tension:0.1}));
        chart.update();
    }
});
