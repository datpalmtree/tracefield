'use strict';
/* =====================================================================
   Tracefield · geo
   one camera + projection interface over three map engines:
   MapLibre (no key), Google Maps JS (key), Google 3D tiles via Cesium (key)
   ===================================================================== */

const LIBRE_CDN = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/';
const CESIUM_CDN = 'https://cdn.jsdelivr.net/npm/cesium@1.146.0/Build/Cesium/';

/* Free tiles must work with no key and from a page opened as a file. Other free servers fail one
   of those: CARTO watermarks tiles without a key, and OpenStreetMap's own servers refuse such requests. */
const esri = path => [`https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`];
const ESRI_MAP_ATTR = 'Powered by Esri · Sources: Esri, HERE, Garmin, USGS, FAO, NOAA, © OpenStreetMap contributors';
const ESRI_SAT_ATTR = 'Powered by Esri · Imagery: Esri, Maxar, Earthstar Geographics';
const PLACE_LABELS = esri('Reference/World_Boundaries_and_Places');

const BASEMAPS = [
  { id: 'streets', label: 'Streets', engine: 'libre', tiles: esri('World_Street_Map'), attr: ESRI_MAP_ATTR, maxzoom: 19 },
  { id: 'night', label: 'Night', engine: 'libre', tiles: esri('Canvas/World_Dark_Gray_Base'), labels: esri('Canvas/World_Dark_Gray_Reference'), attr: ESRI_MAP_ATTR, maxzoom: 16 },
  { id: 'satellite', label: 'Satellite', engine: 'libre', tiles: esri('World_Imagery'), attr: ESRI_SAT_ATTR, maxzoom: 19 },
  { id: 'hybrid', label: 'Satellite + labels', engine: 'libre', tiles: esri('World_Imagery'), labels: PLACE_LABELS, attr: ESRI_SAT_ATTR, maxzoom: 19 },
  { id: 'earth', label: 'Earth globe', engine: 'libre', tiles: esri('World_Imagery'), labels: PLACE_LABELS, attr: ESRI_SAT_ATTR, maxzoom: 19, globe: true, terrain: true },
  { id: 'g-roadmap', label: 'Google Maps', engine: 'google', gtype: 'roadmap', key: true },
  { id: 'g-satellite', label: 'Google Satellite', engine: 'google', gtype: 'satellite', key: true },
  { id: 'g-hybrid', label: 'Google Hybrid', engine: 'google', gtype: 'hybrid', key: true },
  { id: 'g-terrain', label: 'Google Terrain', engine: 'google', gtype: 'terrain', key: true },
  { id: 'g-earth', label: 'Google Earth 3D', engine: 'cesium', key: true },
];
const basemap = id => BASEMAPS.find(b => b.id === id);

/** The key lives in this browser only, never in S, so project exports can't leak it. */
const GoogleKey = {
  get() { try { return localStorage.getItem('tracefield.googleKey') || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem('tracefield.googleKey', v.trim()) : localStorage.removeItem('tracefield.googleKey'); } catch {} },
};

const _loaded = new Map();
function loadScript(src) {
  if (!_loaded.has(src)) _loaded.set(src, new Promise((res, rej) => {
    document.head.append(el('script', { src, onload: () => res(), onerror: () => { _loaded.delete(src); rej(new Error('could not load ' + src.split('/')[2] + ' — check your connection')); } }));
  }));
  return _loaded.get(src);
}
function loadCss(href) {
  if (!_loaded.has(href)) _loaded.set(href, new Promise(res => { document.head.append(el('link', { rel: 'stylesheet', href, onload: () => res(), onerror: () => res() })); }));
  return _loaded.get(href);
}

/* ---------- geographic maths ---------- */

const DEG = Math.PI / 180;
const EARTH_R = 6371008.8;
const EARTH_C = 40075016.68;
function meters(a, b) {
  const dLat = (b[1] - a[1]) * DEG, dLng = (b[0] - a[0]) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Metres per CSS pixel at MapLibre zoom z (512 px tiles). */
const metersPerPx = (lat, z) => EARTH_C * Math.cos(lat * DEG) / (512 * 2 ** z);
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Metres from p to the region's edge; 0 when inside. */
function ringDistance(p, ring) {
  if (inRing(p, ring)) return 0;
  const k = Math.cos(p[1] * DEG) * 111320, m = 111320;
  const q = v => [(v[0] - p[0]) * k, (v[1] - p[1]) * m];
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = q(ring[j]), b = q(ring[i]), dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? clamp(-(a[0] * dx + a[1] * dy) / L, 0, 1) : 0;
    best = Math.min(best, Math.hypot(a[0] + t * dx, a[1] + t * dy));
  }
  return best;
}
function ringCentroid(ring) {
  let x = 0, y = 0;
  for (const [a, b] of ring) { x += a; y += b; }
  return [x / ring.length, y / ring.length];
}

/* ---------- engines ---------- */

const Geo = (() => {
  let E = null, host = null, cur = null, moved = () => {}, failed = () => {}, token = 0;

  function libreStyle(bm) {
    const style = {
      version: 8,
      projection: { type: bm.globe ? 'globe' : 'mercator' },
      sources: { base: { type: 'raster', tiles: bm.tiles, tileSize: 256, maxzoom: bm.maxzoom, attribution: bm.attr } },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    };
    if (bm.labels) {
      style.sources.labels = { type: 'raster', tiles: bm.labels, tileSize: 256, maxzoom: bm.maxzoom };
      style.layers.push({ id: 'labels', type: 'raster', source: 'labels' });
    }
    if (bm.terrain) {
      style.sources.dem = { type: 'raster-dem', tiles: ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 14, attribution: 'Terrain Tiles · Mapzen / AWS' };
      style.terrain = { source: 'dem', exaggeration: 1.3 };
      style.sky = { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 7, 0.6, 10, 0] };
    }
    return style;
  }

  async function mountLibre(bm, cam) {
    await loadCss(LIBRE_CDN + 'maplibre-gl.css');
    await loadScript(LIBRE_CDN + 'maplibre-gl.js');
    const box = el('div', { class: 'geo-engine' });
    host.append(box);
    const map = new maplibregl.Map({
      container: box, style: libreStyle(bm), center: [cam.lng, cam.lat], zoom: cam.zoom, pitch: cam.pitch || 0, bearing: cam.bearing || 0,
      maxPitch: 78, keyboard: false, attributionControl: { compact: false }, cancelPendingTileRequestsWhileZooming: true,
    });
    map.on('move', () => moved());
    map.on('render', () => moved());
    map.on('error', e => console.warn('map', e.error?.message || e));
    return {
      kind: 'libre', map,
      restyle(next) { map.setStyle(libreStyle(next)); },
      project(lng, lat) {
        const p = map.project([lng, lat]);
        return { x: p.x, y: p.y, hidden: !!map.transform.isLocationOccluded?.(new maplibregl.LngLat(lng, lat)) };
      },
      unproject(x, y) { const l = map.unproject([x, y]); return [l.lng, l.lat]; },
      camera() { const c = map.getCenter(); return { lng: c.lng, lat: c.lat, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }; },
      flyTo(c, ms) { map.flyTo({ center: [c.lng, c.lat], zoom: c.zoom, pitch: c.pitch, bearing: c.bearing, duration: ms, essential: true }); },
      zoomBy(k) { map.easeTo({ zoom: map.getZoom() + Math.log2(k), duration: 220 }); },
      orbit(deg) { map.setBearing(map.getBearing() + deg); },
      fit(b, pad, maxZoom) { map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: pad, duration: 1100, maxZoom, essential: true }); },
      destroy() { map.remove(); box.remove(); },
    };
  }

  /** Google's importLibrary only exists once its callback fires, which is later than the script's load event. */
  let googleReady = null;
  function loadGoogle(key) {
    if (!googleReady) googleReady = new Promise((res, rej) => {
      window.__tfGoogleReady = res;
      loadScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__tfGoogleReady`).catch(err => { googleReady = null; rej(err); });
    });
    return googleReady.then(() => google.maps.importLibrary('maps'));
  }

  async function mountGoogle(bm, cam) {
    window.gm_authFailure = () => failed(new Error('Google rejected this API key (is the Maps JavaScript API enabled and billing on?)'));
    await loadGoogle(GoogleKey.get());
    const box = el('div', { class: 'geo-engine' });
    host.append(box);
    const map = new google.maps.Map(box, { center: { lat: cam.lat, lng: cam.lng }, zoom: Math.round(cam.zoom + 1), mapTypeId: bm.gtype, gestureHandling: 'greedy', disableDefaultUI: true, keyboardShortcuts: false, clickableIcons: false, tilt: 0 });
    const ov = new google.maps.OverlayView();
    ov.onAdd = () => {}; ov.onRemove = () => {};
    await new Promise(res => { ov.draw = () => { res(); moved(); }; ov.setMap(map); setTimeout(res, 6000); });
    map.addListener('bounds_changed', () => moved());
    return {
      kind: 'google', map,
      restyle(next) { map.setMapTypeId(next.gtype); },
      project(lng, lat) {
        const p = ov.getProjection()?.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng));
        return p ? { x: p.x, y: p.y, hidden: false } : { x: -1e4, y: -1e4, hidden: true };
      },
      unproject(x, y) {
        const l = ov.getProjection()?.fromContainerPixelToLatLng(new google.maps.Point(x, y));
        return l ? [l.lng(), l.lat()] : null;
      },
      camera() { const c = map.getCenter(); return c ? { lng: c.lng(), lat: c.lat(), zoom: map.getZoom() - 1, pitch: 0, bearing: 0 } : null; },
      flyTo(c) { map.panTo({ lat: c.lat, lng: c.lng }); map.setZoom(Math.round(c.zoom + 1)); },
      zoomBy(k) { map.setZoom(map.getZoom() + Math.sign(Math.log(k))); },
      orbit() {},
      fit(b, pad) { map.fitBounds({ west: b[0], south: b[1], east: b[2], north: b[3] }, pad); },
      async geocode(q) {
        await google.maps.importLibrary('geocoding');
        const r = await new google.maps.Geocoder().geocode({ address: q });
        return r.results.slice(0, 5).map(g => ({ name: g.formatted_address, lng: g.geometry.location.lng(), lat: g.geometry.location.lat(), bbox: null }));
      },
      destroy() { ov.setMap(null); google.maps.event.clearInstanceListeners(map); box.remove(); },
    };
  }

  /** Google's 3D tiles are the same photogrammetry Earth shows; Google Earth itself has no embeddable API. */
  async function mountCesium(bm, cam) {
    window.CESIUM_BASE_URL = CESIUM_CDN;
    await loadCss(CESIUM_CDN + 'Widgets/widgets.css');
    await loadScript(CESIUM_CDN + 'Cesium.js');
    const box = el('div', { class: 'geo-engine' });
    host.append(box);
    const viewer = new Cesium.Viewer(box, {
      globe: false, baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
      animation: false, timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false, requestRenderMode: false,
    });
    const scene = viewer.scene, key = GoogleKey.get();
    try {
      scene.primitives.add(await Cesium.createGooglePhotorealistic3DTileset({ key, onlyUsingWithGoogleGeocoder: true }, { showCreditsOnScreen: true }));
    } catch (err) {
      viewer.destroy(); box.remove();
      throw new Error('Google 3D tiles refused (is the Map Tiles API enabled for this key?)');
    }
    const FOV_K = () => 2 * Math.tan(scene.camera.frustum.fovy / 2);
    const range = (lat, z) => metersPerPx(lat, z) * box.clientHeight / FOV_K();
    const look = (c, ms) => {
      const sphere = new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(c.lng, c.lat, 0), 1);
      scene.camera.flyToBoundingSphere(sphere, { duration: ms / 1000, offset: new Cesium.HeadingPitchRange((c.bearing || 0) * DEG, ((c.pitch || 0) - 90) * DEG, range(c.lat, c.zoom)) });
    };
    const centerGround = () => scene.camera.pickEllipsoid(new Cesium.Cartesian2(box.clientWidth / 2, box.clientHeight / 2));
    const heights = new Map();
    const heightAt = (lng, lat) => {
      const k = `${lng.toFixed(5)},${lat.toFixed(5)}`;
      if (heights.has(k)) return heights.get(k);
      heights.set(k, 0);
      scene.clampToHeightMostDetailed([Cesium.Cartesian3.fromDegrees(lng, lat)]).then(([p]) => { if (p) heights.set(k, Cesium.Cartographic.fromCartesian(p).height); }).catch(() => {});
      return 0;
    };
    const postRender = scene.postRender.addEventListener(() => moved());
    look(cam, 0);
    return {
      kind: 'cesium', viewer,
      restyle() {},
      project(lng, lat) {
        const p = Cesium.SceneTransforms.worldToWindowCoordinates(scene, Cesium.Cartesian3.fromDegrees(lng, lat, heightAt(lng, lat)));
        return p ? { x: p.x, y: p.y, hidden: false } : { x: -1e4, y: -1e4, hidden: true };
      },
      unproject(x, y) {
        const at = new Cesium.Cartesian2(x, y);
        const hit = (scene.pickPositionSupported && scene.pickPosition(at)) || scene.camera.pickEllipsoid(at);
        if (!hit) return null;
        const g = Cesium.Cartographic.fromCartesian(hit);
        return [g.longitude / DEG, g.latitude / DEG];
      },
      camera() {
        const g = centerGround(), c = scene.camera, geo = g ? Cesium.Cartographic.fromCartesian(g) : c.positionCartographic;
        const lat = geo.latitude / DEG, d = g ? Cesium.Cartesian3.distance(c.positionWC, g) : c.positionCartographic.height;
        const zoom = Math.log2(EARTH_C * Math.cos(lat * DEG) * box.clientHeight / (512 * d * FOV_K()));
        return { lng: geo.longitude / DEG, lat, zoom: clamp(zoom, 0, 22), pitch: clamp(c.pitch / DEG + 90, 0, 85), bearing: c.heading / DEG };
      },
      flyTo: look,
      zoomBy(k) { const d = Cesium.Cartesian3.distance(scene.camera.positionWC, centerGround() || scene.camera.positionWC); k > 1 ? scene.camera.zoomIn(d * (1 - 1 / k)) : scene.camera.zoomOut(d * (1 / k - 1)); },
      orbit(deg) { const g = centerGround(); if (g) scene.camera.rotate(Cesium.Cartesian3.normalize(g, new Cesium.Cartesian3()), -deg * DEG); },
      fit(b) { scene.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(b[0], b[1], b[2], b[3]), duration: 1.2 }); },
      async geocode(q) {
        const r = await new Cesium.GoogleGeocoderService({ key }).geocode(q);
        return r.slice(0, 5).map(g => { const c = Cesium.Cartographic.fromCartesian(g.destination instanceof Cesium.Rectangle ? Cesium.Cartographic.toCartesian(Cesium.Rectangle.center(g.destination)) : g.destination); return { name: g.displayName, lng: c.longitude / DEG, lat: c.latitude / DEG, bbox: null }; });
      },
      destroy() { postRender(); viewer.destroy(); box.remove(); },
    };
  }

  const mounts = { libre: mountLibre, google: mountGoogle, cesium: mountCesium };

  /** Switch background; the camera carries over. Throws with a readable message on failure. */
  async function use(id, cam) {
    const bm = basemap(id);
    if (!bm) throw new Error('unknown background');
    if (bm.key && !GoogleKey.get()) throw new Error('needs-key');
    const mine = ++token;
    if (E && E.kind === bm.engine) { E.restyle(bm); cur = bm; moved(); return E; }
    // the new engine mounts first, so a refused key or dead connection leaves the current map and view alone
    const next = await mounts[bm.engine](bm, E?.camera() || cam);
    if (mine !== token) { next.destroy(); return E; }
    E?.destroy();
    E = next; cur = bm; moved();
    return E;
  }

  async function search(q) {
    if (E?.geocode) return E.geocode(q);
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error(`geocoder answered ${r.status}`);
    return (await r.json()).map(g => ({ name: g.display_name, lng: +g.lon, lat: +g.lat, bbox: g.boundingbox && [+g.boundingbox[2], +g.boundingbox[0], +g.boundingbox[3], +g.boundingbox[1]] }));
  }

  return {
    init(h, onMove, onFail) { host = h; moved = onMove; failed = onFail; },
    use, search,
    get ready() { return !!E; },
    get current() { return cur; },
    get engine() { return E; },
    project: (lng, lat) => E ? E.project(lng, lat) : { x: -1e4, y: -1e4, hidden: true },
    unproject: (x, y) => E ? E.unproject(x, y) : null,
    camera: () => E ? E.camera() : null,
    flyTo: (c, ms = 2400) => E?.flyTo(c, ms),
    zoomBy: k => E?.zoomBy(k),
    orbit: deg => E?.orbit(deg),
    fit: (b, pad, maxZoom) => E?.fit(b, pad, maxZoom),
  };
})();
