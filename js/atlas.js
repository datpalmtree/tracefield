'use strict';
/* =====================================================================
   Tracefield · atlas
   the map background: sound points + regions, pinned graphs, links,
   listening dock, soundwalk, journey, exhibit mode, atlas demo
   ===================================================================== */

const LINK_STYLES = [['arrow', 'Arrow', 'Direction matters: journeys follow arrows'], ['line', 'Line', 'A plain connection'], ['dash', 'Dashed', 'A looser association'], ['flow', 'Flow', 'Particles travel it at the felt tempo; journeys follow it too']];
const AUDIO_ACCEPT = 'audio/*,.wav,.wave,.mp3,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm,.aif,.aiff';

const Atlas = (() => {
  let root, layer, svg, fx, fcx, catchEl, dockEl;
  let active = false, tool = 'select', sel = null, dirty = true, raf = 0, lastTick = 0, focus = null;
  let draft = null, tempLink = null, spaceFlip = false, mixBase = 1, exhibitOn = false, walkOn = false;
  let pointer = null, listener = null;
  const nodes = new Map(), rings = [], linkGeo = new Map(), screen = new Map();
  const V = id => screen.get(id) || screen.set(id, {}).get(id);
  const CALM = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const A = () => S.atlas;
  const placeOf = id => A().places.find(p => p.id === id);
  const pinOf = id => A().pins.find(p => p.id === id);
  const linkOf = id => A().links.find(l => l.id === id);
  const hasSound = p => !!(p && (p.audio || p.felt));
  const anchor = p => p.kind === 'region' ? ringCentroid(p.ring) : [p.lng, p.lat];
  const placeColor = n => PALETTE[(n * 3) % PALETTE.length];

  /* ---------- lifecycle ---------- */
  function init() {
    root = $('#atlas'); layer = $('#geo-layer'); svg = $('#geo-svg'); fx = $('#geo-fx'); fcx = fx.getContext('2d'); catchEl = $('#geo-catch'); dockEl = $('#geo-dock');
    Geo.init($('#geo-map'), () => { dirty = true; }, err => { toast(err.message, 'bad', 7000); setBackground('satellite'); });
    Scape.onEnded = id => { if (Journey.on) Journey.ended(id); else { showDock(); if (sel === id) Inspector.show(); } };

    $$('#atlas-tools [data-gtool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.gtool)));
    $('#btn-bg').onclick = e => pickBackground(e.currentTarget);
    $('#btn-walk').onclick = () => setWalk(!walkOn);
    $('#btn-journey').onclick = () => Journey.toggle();
    $('#btn-exhibit').onclick = () => exhibit(true);
    $('#gd-play').onclick = () => { const p = placeOf(focus); if (p) toggle(p); };
    $('#gd-mix-in').addEventListener('input', e => setMix(+e.target.value));
    $('#gd-mix-in').addEventListener('change', e => e.target.blur());
    $('#gd-wave').addEventListener('pointerdown', e => {
      const seek = ev => { const r = e.target.getBoundingClientRect(); Scape.seek(focus, clamp((ev.clientX - r.left) / r.width, 0, 1)); };
      seek(e); track(e, seek);
    });
    $('#geo-exit').onclick = () => exhibit(false);
    $('#gi-journey').onclick = () => { $('#geo-intro').hidden = true; Scape.ensure(); Journey.start(); };
    $('#gi-walk').onclick = () => { $('#geo-intro').hidden = true; Scape.ensure(); setWalk(true); };
    $('#gk-save').onclick = saveKey;
    $('#gk-input').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') saveKey(); });
    $('#gk-clear').onclick = () => { GoogleKey.set(''); $('#gk-input').value = ''; $('#geo-key').hidden = true; toast('Google key removed from this browser.'); };

    const search = $('#geo-q');
    search.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') runSearch(search.value); if (e.key === 'Escape') { $('#geo-results').hidden = true; search.blur(); } });

    layer.addEventListener('pointerdown', onLayerDown);
    layer.addEventListener('dblclick', onLayerDbl);
    layer.addEventListener('wheel', e => { if (!e.target.closest('.scroll')) { e.preventDefault(); Geo.zoomBy(Math.exp(-e.deltaY * 0.0016)); } }, { passive: false });
    svg.addEventListener('pointerdown', onSvgDown);
    root.addEventListener('contextmenu', onContext);
    root.addEventListener('pointerdown', onRootDown, true);
    catchEl.addEventListener('pointerup', onCatchUp);
    catchEl.addEventListener('dblclick', e => { e.preventDefault(); finishRegion(); });
    catchEl.addEventListener('wheel', e => { e.preventDefault(); Geo.zoomBy(Math.exp(-e.deltaY * 0.0016)); }, { passive: false });
    root.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('application/x-tf-map')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    root.addEventListener('drop', onItemDrop);
    window.addEventListener('pointermove', e => { if (e.target.closest?.('#atlas')) pointer = { x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' }; });
    window.addEventListener('resize', () => { dirty = true; });
    window.addEventListener('keyup', e => { if (e.key === ' ' && spaceFlip) { spaceFlip = false; setMix(mixBase); } });
  }

  async function enter(id) {
    active = true;
    document.body.classList.add('atlas-on');
    S.geo.on = true;
    Board.setTool('select');
    Tip.hide(); Player.stop();
    setTool('select');
    await setBackground(id || S.geo.basemap);
    rebuild();
    if (!raf) raf = requestAnimationFrame(frame);
    Inspector.show(); Library.render(); saveSoon();
  }

  function leave() {
    if (exhibitOn) exhibit(false);
    Journey.stop(); setWalk(false); Scape.stopAll();
    active = false; focus = null;
    document.body.classList.remove('atlas-on');
    S.geo.on = false;
    cancelAnimationFrame(raf); raf = 0;
    dockEl.hidden = true;
    bgLabel();
    Board.applyView(); Inspector.show(); Library.render(); saveSoon();
  }

  async function setBackground(id) {
    const bm = basemap(id);
    if (bm?.key && !GoogleKey.get()) { keyDialog(id); id = S.geo.basemap; if (basemap(id)?.key) id = 'satellite'; }
    App.setBusy(`Loading ${basemap(id).label}…`);
    try {
      await Geo.use(id, S.geo.cam);
      S.geo.basemap = id;
      document.body.dataset.basemap = id;
      bgLabel();
      saveSoon();
    } catch (err) {
      console.warn(err);
      toast(`Could not load ${basemap(id).label}: ${err.message}`, 'bad', 7000);
      if (id !== 'satellite' && !Geo.ready) { App.setBusy(null); return setBackground('satellite'); }
      if (!Geo.ready) { App.setBusy(null); leave(); return; }
    }
    App.setBusy(null);
    dirty = true;
    if (active) Inspector.show();
  }

  function bgLabel() {
    const n = $('#btn-bg span');
    if (n) n.textContent = active ? (basemap(S.geo.basemap)?.label || 'Map') : 'Pinboard';
  }

  function pickBackground(btn) {
    const r = btn.getBoundingClientRect(), hasKey = !!GoogleKey.get();
    const on = id => active && S.geo.basemap === id;
    const row = b => ({ label: b.label + (on(b.id) ? '  ✓' : ''), icon: b.engine === 'libre' ? (b.globe ? 'earth' : 'map') : 'earth', action: () => active ? setBackground(b.id) : enter(b.id) });
    Menu.show(r.left, r.bottom + 8, [
      { header: 'Background' },
      { label: 'Pinboard' + (active ? '' : '  ✓'), icon: 'grid', action: () => { if (active) leave(); } },
      '-',
      { header: 'Maps · no key needed' },
      ...BASEMAPS.filter(b => !b.key).map(row),
      '-',
      { header: hasKey ? 'Google' : 'Google · needs your API key' },
      ...BASEMAPS.filter(b => b.key).map(b => hasKey ? row(b) : ({ ...row(b), action: () => keyDialog(b.id) })),
      { label: hasKey ? 'Change Google API key…' : 'Add Google API key…', icon: 'lock', action: () => keyDialog() },
    ]);
  }

  let keyThen = null;
  function keyDialog(then) {
    keyThen = then || null;
    $('#gk-input').value = GoogleKey.get();
    $('#geo-key').hidden = false;
    setTimeout(() => $('#gk-input').focus(), 30);
  }
  function saveKey() {
    const v = $('#gk-input').value.trim(), changed = GoogleKey.get() && GoogleKey.get() !== v;
    GoogleKey.set(v);
    $('#geo-key').hidden = true;
    if (changed && window.google?.maps) toast('New key saved. Reload the page for Google Maps to use it.', '', 6000);
    else if (v) toast('Key saved in this browser only. Exports never include it.', 'good');
    if (v && keyThen) (active ? setBackground(keyThen) : enter(keyThen));
    Inspector.show();
  }

  /* ---------- tools ---------- */
  function setTool(t) {
    if (draft && t !== 'region') { draft = null; dirty = true; }
    tool = t;
    root.dataset.tool = t;
    catchEl.hidden = !(t === 'point' || t === 'region');
    $$('#atlas-tools [data-gtool]').forEach(b => b.classList.toggle('on', b.dataset.gtool === t));
    const hint = { point: 'Click the map to drop a sound point.', region: 'Click to outline a region. Double-click or Enter to finish, Esc to cancel.', link: 'Drag from a point or graph to another to link them.' }[t];
    if (hint && !exhibitOn) toast(hint, '', 2600);
  }

  function select(id) {
    sel = id;
    for (const [k, n] of nodes) n.classList.toggle('selected', k === id);
    const p = placeOf(id);
    if (p && hasSound(p) && !walkOn && !Journey.on) { focus = p.id; showDock(); }
    dirty = true;
    Inspector.show();
  }

  /* ---------- creating + removing ---------- */
  function newPlace(lng, lat, extra = {}) {
    const n = A().places.length, cam = Geo.camera() || S.geo.cam;
    const p = {
      id: uid('g'), kind: 'point', name: `Point ${n + 1}`, who: '', note: '', quote: '', lng: round(lng, 6), lat: round(lat, 6), ring: null,
      color: placeColor(n), audio: null, felt: null, vol: 1, radius: Math.round(metersPerPx(lat, cam.zoom) * 150), drive: defaultDrive(), ...extra,
    };
    A().places.push(p);
    return p;
  }

  function pinItem(itemId, at, linkTo) {
    const it = getItem(itemId);
    if (!it) return null;
    const [lng, lat] = at;
    const pin = { id: uid('n'), item: itemId, lng: round(lng, 6), lat: round(lat, 6), dx: 38, dy: -250, w: it.type === 'lens' ? 460 : 380, h: it.type === 'lens' ? 300 : 240, z0: (Geo.camera() || S.geo.cam).zoom, small: false };
    A().pins.push(pin);
    if (linkTo) link(linkTo, pin.id, { style: 'dash', color: placeOf(linkTo)?.color });
    return pin;
  }

  function link(a, b, o = {}) {
    if (A().links.some(l => (l.a === a && l.b === b) || (l.a === b && l.b === a))) { toast('Already linked'); return null; }
    const l = { id: uid('k'), a, b, style: o.style || S.geo.linkStyle || 'arrow', color: o.color || '#ffffff', label: '' };
    A().links.push(l);
    return l;
  }

  function removeSel() {
    if (!sel) return;
    const a = A(), id = sel;
    if (placeOf(id)) { Scape.drop(id); a.places = a.places.filter(p => p.id !== id); if (focus === id) focus = null; }
    else if (pinOf(id)) a.pins = a.pins.filter(p => p.id !== id);
    else if (linkOf(id)) a.links = a.links.filter(l => l.id !== id);
    a.links = a.links.filter(l => l.a !== id && l.b !== id);
    sel = null;
    rebuild(); commit(); Inspector.show(); showDock();
  }

  /** Board items were deleted: unpin them and clear any drive that read them. */
  function forget(ids) {
    const a = A();
    const gone = a.pins.filter(p => ids.has(p.item)).map(p => p.id);
    a.pins = a.pins.filter(p => !ids.has(p.item));
    a.links = a.links.filter(l => !gone.includes(l.a) && !gone.includes(l.b));
    for (const p of a.places) if (ids.has(p.drive?.graph)) { p.drive = defaultDrive(); Scape.refresh(p); }
    if (active) rebuild();
  }

  function linkedItems(place) {
    const ids = new Set();
    for (const l of A().links) {
      const other = l.a === place.id ? l.b : l.b === place.id ? l.a : null;
      const pin = other && pinOf(other);
      if (pin) ids.add(pin.item);
    }
    if (place.drive?.graph) ids.add(place.drive.graph);
    return [...ids];
  }

  function pinsFor(place) {
    const items = linkedItems(place);
    return A().pins.filter(p => items.includes(p.item));
  }

  /* ---------- DOM ---------- */
  function buildPlace(p) {
    const n = el('div', { class: 'gp' + (p.kind === 'region' ? ' region' : ''), dataset: { gid: p.id }, style: { '--c': p.color } },
      el('div', { class: 'gp-ring' }),
      el('div', { class: 'gp-dot', html: ic(hasSound(p) ? 'wave' : 'pin') }),
      el('div', { class: 'gp-name' }, p.name || 'Untitled'),
      hasSound(p) && el('button', { class: 'gp-play', title: 'Play', 'aria-label': 'Play', html: ic('play') }));
    n.classList.toggle('sound', hasSound(p));
    n.classList.toggle('selected', sel === p.id);
    layer.append(n);
    nodes.set(p.id, n);
  }

  function buildPin(pin) {
    const it = getItem(pin.item);
    if (!it) return;
    const title = it.type === 'lens' ? it.title : it.meta.title;
    const sub = it.type === 'lens' ? `${it.maps.length} maps` : [it.meta.participant, it.meta.condition].filter(Boolean).join(' · ');
    const plot = el('div', { class: 'plot gn-plot' });
    const n = el('div', { class: 'gn' + (pin.small ? ' small' : ''), dataset: { gid: pin.id }, style: { '--c': it.color || Theme.t().accent } },
      el('div', { class: 'gn-head' }, el('span', { class: 'swatch' }), el('div', { class: 'titles' }, el('b', {}, title || 'Graph'), sub && el('small', {}, sub)),
        el('button', { class: 'ibtn gn-size', title: 'Collapse / expand', 'aria-label': 'Collapse or expand', html: ic(pin.small ? 'plus' : 'minus') })),
      plot, el('div', { class: 'resize' }));
    n.classList.toggle('selected', sel === pin.id);
    const dot = el('div', { class: 'gn-anchor', dataset: { anchor: pin.id }, title: 'Drag to re-pin', style: { '--c': it.color || Theme.t().accent } });
    layer.append(dot, n);
    nodes.set(pin.id, n);
    nodes.set('a:' + pin.id, dot);
    renderPlot(pin);
  }

  function renderPlot(pin) {
    const n = nodes.get(pin.id), it = getItem(pin.item);
    const plot = n?.querySelector('.gn-plot');
    if (!plot || !it || pin.small) return;
    const h = pin.h - 40;
    if (it.type === 'lens') Plot.renderLens(plot, it, pin.w, h); else Plot.renderMap(plot, it, pin.w, h);
  }

  function rebuild() {
    layer.innerHTML = ''; nodes.clear();
    if (sel && !placeOf(sel) && !pinOf(sel) && !linkOf(sel)) sel = null;
    for (const v of [...Scape.voices.values()]) {
      const p = placeOf(v.place.id);
      if (!p || v.key !== `${p.audio}|${p.felt}`) Scape.drop(v.place.id); else Scape.refresh(p);
    }
    A().pins.forEach(buildPin);
    A().places.forEach(buildPlace);
    $('#geo-hint').hidden = !!A().places.length || exhibitOn;
    dirty = true;
  }

  /* ---------- per-frame layout ---------- */
  function layout() {
    const cam = Geo.camera();
    if (!cam) return;
    saveCam(cam);
    const zl = $('#zoom-label'); if (zl) zl.textContent = 'z' + cam.zoom.toFixed(1);
    root.classList.toggle('zoomed-out', cam.zoom < 7);
    for (const p of A().places) {
      const n = nodes.get(p.id);
      if (!n) continue;
      const [lng, lat] = anchor(p), s = Geo.project(lng, lat);
      n.style.transform = `translate(${s.x}px, ${s.y}px)`;
      n.classList.toggle('gone', s.hidden);
      V(p.id).s = s;
    }
    for (const pin of A().pins) {
      const n = nodes.get(pin.id), dot = nodes.get('a:' + pin.id);
      if (!n) continue;
      const s = Geo.project(pin.lng, pin.lat);
      // pinned right on its linked place: the link already says where it belongs
      const pv = V(pin.id);
      pv.onPlace = A().links.some(l => (l.a === pin.id || l.b === pin.id) && (() => { const q = placeOf(l.a === pin.id ? l.b : l.a); if (!q) return false; const [x, y] = anchor(q); return Math.abs(x - pin.lng) + Math.abs(y - pin.lat) < 1e-4; })());
      const small = pin.small || cam.zoom < pin.z0 - 3.5;
      const cardDims = small ? [190, 40] : [pin.w, pin.h];
      if (n.classList.contains('far') !== (small && !pin.small)) n.classList.toggle('far', small && !pin.small);
      dot.style.transform = `translate(${s.x}px, ${s.y}px)`;
      dot.classList.toggle('gone', s.hidden || pv.onPlace);
      n.classList.toggle('gone', s.hidden);
      n.style.transform = `translate(${s.x + pin.dx}px, ${s.y + pin.dy}px)`;
      if (!small) { n.style.width = pin.w + 'px'; n.style.height = pin.h + 'px'; } else { n.style.width = ''; n.style.height = ''; }
      pv.s = s; pv.box = { x: s.x + pin.dx, y: s.y + pin.dy, w: cardDims[0], h: cardDims[1] };
    }
    drawSvg();
  }
  let camAt = 0;
  function saveCam(c) {
    const was = S.geo.cam, t = performance.now();
    if (t - camAt < 1000 || (was.lng === c.lng && was.lat === c.lat && was.zoom === c.zoom && was.pitch === c.pitch && was.bearing === c.bearing)) return;
    camAt = t; S.geo.cam = c; saveSoon();
  }

  function endPoint(id, toward) {
    const { s: ps, box: b } = V(id);
    if (placeOf(id) && ps) {
      const d = Math.hypot(toward[0] - ps.x, toward[1] - ps.y) || 1;
      return [ps.x + (toward[0] - ps.x) / d * 17, ps.y + (toward[1] - ps.y) / d * 17];
    }
    if (!b) return null;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = toward[0] - cx, dy = toward[1] - cy;
    const t = Math.min(dx ? (b.w / 2 + 4) / Math.abs(dx) : 1e9, dy ? (b.h / 2 + 4) / Math.abs(dy) : 1e9, 1);
    return [cx + dx * t, cy + dy * t];
  }
  const centerOf = id => {
    const { s, box: b } = V(id);
    if (placeOf(id) && s) return [s.x, s.y];
    return b ? [b.x + b.w / 2, b.y + b.h / 2] : null;
  };
  const isHidden = id => { const s = V(id).s; return !s || s.hidden; };

  function drawSvg() {
    svg.innerHTML = '';
    const gShape = sv('g'), gLink = sv('g'), gTop = sv('g');
    for (const p of A().places) {
      const on = sel === p.id || (walkOn && hasSound(p));
      if (p.kind === 'region') {
        const pts = p.ring.map(([x, y]) => Geo.project(x, y));
        if (pts.some(q => q.hidden)) continue;
        const d = 'M' + pts.map(q => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join('L') + 'Z', lv = Scape.level(p.id);
        gShape.append(sv('path', { d, fill: rgba(p.color, 0.13 + lv * 0.35), stroke: p.color, 'stroke-width': sel === p.id ? 2.4 : 1.6, 'stroke-linejoin': 'round', 'data-region': p.id }));
        if (sel === p.id && !exhibitOn) pts.forEach((q, i) => gTop.append(sv('circle', { cx: q.x, cy: q.y, r: 5, class: 'g-vertex', 'data-place': p.id, 'data-vertex': i, fill: '#fff', stroke: p.color, 'stroke-width': 2 })));
      }
      const ps = V(p.id).s;
      if (on && hasSound(p) && ps && !ps.hidden) {
        const [lng, lat] = anchor(p), top = Geo.project(lng, lat + p.radius / 111320);
        const r = Math.hypot(top.x - ps.x, top.y - ps.y);
        if (p.kind !== 'region') gShape.append(sv('circle', { cx: ps.x, cy: ps.y, r, fill: rgba(p.color, 0.05), stroke: p.color, 'stroke-width': 1, 'stroke-dasharray': '3 6', opacity: 0.8 }));
      }
    }
    for (const pin of A().pins) {
      const { s, onPlace } = V(pin.id);
      if (!s || s.hidden || onPlace || !nodes.has(pin.id)) continue;
      const it = getItem(pin.item), to = endPoint(pin.id, [s.x, s.y]);
      gLink.append(sv('line', { x1: s.x, y1: s.y, x2: to[0], y2: to[1], stroke: it?.color || '#fff', 'stroke-width': 1.5, opacity: 0.75, class: 'g-stem' }));
    }
    linkGeo.clear();
    for (const l of A().links) {
      if (isHidden(l.a) || isHidden(l.b)) continue;
      const ca = centerOf(l.a), cb = centerOf(l.b);
      if (!ca || !cb) continue;
      const p0 = endPoint(l.a, cb), p2 = endPoint(l.b, ca);
      if (!p0 || !p2) continue;
      const dx = p2[0] - p0[0], dy = p2[1] - p0[1], len = Math.hypot(dx, dy) || 1;
      const c = [(p0[0] + p2[0]) / 2 - dy * 0.1, (p0[1] + p2[1]) / 2 + dx * 0.1];
      const d = `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)}Q${c[0].toFixed(1)} ${c[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
      const on = sel === l.id, w = on ? 3.2 : 2.2;
      linkGeo.set(l.id, { p0, c, p2, l, len });
      gLink.append(sv('path', { d, fill: 'none', stroke: 'rgba(0,0,0,.45)', 'stroke-width': w + 2.5, 'stroke-linecap': 'round' }));
      gLink.append(sv('path', { d, fill: 'none', stroke: l.color, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-dasharray': l.style === 'dash' ? '7 7' : l.style === 'flow' ? '2 8' : null }));
      if (l.style === 'arrow' || l.style === 'flow') {
        const ax = p2[0] - c[0], ay = p2[1] - c[1], al = Math.hypot(ax, ay) || 1, ux = ax / al, uy = ay / al, s = on ? 13 : 11;
        const head = `M${p2[0] - ux * s - uy * s * 0.55} ${p2[1] - uy * s + ux * s * 0.55}L${p2[0]} ${p2[1]}L${p2[0] - ux * s + uy * s * 0.55} ${p2[1] - uy * s - ux * s * 0.55}`;
        gLink.append(sv('path', { d: head, fill: 'none', stroke: 'rgba(0,0,0,.45)', 'stroke-width': w + 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        gLink.append(sv('path', { d: head, fill: 'none', stroke: l.color, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      }
      gLink.append(sv('path', { d, class: 'g-hit', 'data-link': l.id }));
      if (l.label) gTop.append(sv('text', { x: c[0], y: c[1] - 6, class: 'g-label', 'text-anchor': 'middle', text: l.label }));
    }
    if (tempLink) {
      const a = centerOf(tempLink.from);
      if (a) gLink.append(sv('path', { d: `M${a[0]} ${a[1]}L${tempLink.x} ${tempLink.y}`, stroke: '#fff', 'stroke-width': 2, 'stroke-dasharray': '6 6', fill: 'none' }));
    }
    if (draft?.length) {
      const pts = draft.map(([x, y]) => Geo.project(x, y));
      gShape.append(sv('polyline', { points: pts.map(q => `${q.x},${q.y}`).join(' '), fill: 'rgba(255,255,255,.12)', stroke: '#fff', 'stroke-width': 2, 'stroke-dasharray': '6 5' }));
      pts.forEach(q => gTop.append(sv('circle', { cx: q.x, cy: q.y, r: 4, fill: '#fff' })));
    }
    svg.append(gShape, gLink, gTop);
  }

  /* ---------- pointer input ---------- */
  function onRootDown(e) {
    if (!e.target.closest('#geo-map') || e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    const up = ev => { window.removeEventListener('pointerup', up); if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5 && sel) select(null); };
    window.addEventListener('pointerup', up);
  }

  function onCatchUp(e) {
    if (e.button !== 0) return;
    const at = Geo.unproject(e.clientX, e.clientY);
    if (!at) return;
    if (tool === 'point') {
      const p = newPlace(at[0], at[1]);
      rebuild(); select(p.id); setTool('select'); commit();
    } else if (tool === 'region') {
      draft = draft || [];
      draft.push(at.map(v => round(v, 6)));
      dirty = true;
    }
  }

  function finishRegion() {
    if (!draft) return;
    // a double-click leaves the same corner twice
    const ring = draft.filter((q, i) => !i || Math.hypot(q[0] - draft[i - 1][0], q[1] - draft[i - 1][1]) > 1e-6);
    draft = null;
    if (ring.length < 3) { toast('A region needs at least three corners.'); setTool('select'); return; }
    const [lng, lat] = ringCentroid(ring);
    const n = A().places.filter(p => p.kind === 'region').length;
    const p = newPlace(lng, lat, { kind: 'region', ring, name: `Region ${n + 1}`, radius: Math.round(metersPerPx(lat, (Geo.camera() || S.geo.cam).zoom) * 90) });
    rebuild(); select(p.id); setTool('select'); commit();
  }

  function onLayerDown(e) {
    if (e.button !== 0) return;
    const t = e.target;
    const dot = t.closest('[data-anchor]');
    if (dot) return dragAnchor(e, pinOf(dot.dataset.anchor));
    const n = t.closest('[data-gid]');
    if (!n) return;
    const id = n.dataset.gid, p = placeOf(id), pin = pinOf(id);
    if (t.closest('.gp-play')) { e.stopPropagation(); toggle(p); return; }
    if (t.closest('.gn-size')) { pin.small = !pin.small; rebuild(); commit(); return; }
    if (exhibitOn) { if (p && hasSound(p)) toggle(p); else if (p) select(id); return; }
    if (tool === 'link') return startLink(e, id);
    if (t.closest('.resize') && pin) return resizePin(e, pin);
    if (sel !== id) select(id);
    if (p) dragPlace(e, p); else if (pin && t.closest('.gn-head')) dragPin(e, pin);
  }

  function onLayerDbl(e) {
    const id = e.target.closest('[data-gid]')?.dataset.gid, p = placeOf(id);
    if (p && hasSound(p) && !exhibitOn) toggle(p);
  }

  function onSvgDown(e) {
    if (e.button !== 0) return;
    const lid = e.target.dataset?.link;
    if (lid) { select(lid); return; }
    const vtx = e.target.dataset?.vertex;
    if (vtx != null) {
      const p = placeOf(e.target.dataset.place), i = +vtx;
      e.stopPropagation();
      track(e, ev => { const at = Geo.unproject(ev.clientX, ev.clientY); if (at) { p.ring[i] = at.map(v => round(v, 6)); dirty = true; } }, () => commit());
    }
  }

  function dragPlace(e, p) {
    const x0 = e.clientX, y0 = e.clientY, start = Geo.unproject(x0, y0), ring0 = p.ring && clone(p.ring), l0 = [p.lng, p.lat];
    let moved = false;
    track(e, ev => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      moved = true;
      const at = Geo.unproject(ev.clientX, ev.clientY);
      if (!at || !start) return;
      const dx = at[0] - start[0], dy = at[1] - start[1];
      if (ring0) p.ring = ring0.map(([a, b]) => [round(a + dx, 6), round(b + dy, 6)]);
      p.lng = round(l0[0] + dx, 6); p.lat = round(l0[1] + dy, 6);
      dirty = true;
    }, () => { if (moved) commit(); });
  }
  function dragPin(e, pin) {
    const x0 = e.clientX, y0 = e.clientY, d0 = [pin.dx, pin.dy];
    let moved = false;
    track(e, ev => { moved = true; pin.dx = d0[0] + ev.clientX - x0; pin.dy = d0[1] + ev.clientY - y0; dirty = true; }, () => { if (moved) commit(); });
  }
  function dragAnchor(e, pin) {
    if (exhibitOn) return;
    track(e, ev => { const at = Geo.unproject(ev.clientX, ev.clientY); if (at) { pin.lng = round(at[0], 6); pin.lat = round(at[1], 6); dirty = true; } }, () => commit());
  }
  function resizePin(e, pin) {
    const x0 = e.clientX, y0 = e.clientY, w0 = pin.w, h0 = pin.h;
    const redraw = rafThrottle(() => renderPlot(pin));
    track(e, ev => { pin.w = Math.round(Math.max(260, w0 + ev.clientX - x0)); pin.h = Math.round(Math.max(170, h0 + ev.clientY - y0)); dirty = true; redraw(); }, () => commit());
  }
  function startLink(e, from) {
    tempLink = { from, x: e.clientX, y: e.clientY };
    track(e, ev => { tempLink.x = ev.clientX; tempLink.y = ev.clientY; dirty = true; }, ev => {
      tempLink = null; dirty = true;
      const to = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-gid]')?.dataset.gid;
      if (!to || to === from) return;
      const l = link(from, to, { color: placeOf(from)?.color || placeOf(to)?.color });
      if (l) { select(l.id); autoDrive(l); commit(); }
    });
  }

  /** Linking a sound to a graph hands that graph to the drive, if none is set yet. */
  function autoDrive(l) {
    const place = placeOf(l.a) || placeOf(l.b), pin = pinOf(l.a) || pinOf(l.b);
    if (place && pin && !place.drive?.graph) setDriveGraph(place, pin.item);
  }
  function setDriveGraph(p, itemId) {
    p.drive = p.drive || defaultDrive();
    p.drive.graph = itemId || null;
    const lines = graphLines(getItem(itemId));
    const pick = (re, not) => (lines.find(l => re.test(l.name) && l.id !== not) || null)?.id || null;
    p.drive.tempo.line = pick(/pace|tempo|time|speed|felt|passage/i) || lines[0]?.id || null;
    p.drive.gain.line = pick(/emph|loud|salien|intens|sound|attention/i, p.drive.tempo.line) || null;
    p.drive.bright.line = null; p.drive.space.line = null;
    Scape.refresh(p);
  }

  function onContext(e) {
    e.preventDefault();
    if (exhibitOn) return;
    const n = e.target.closest('[data-gid]');
    const at = Geo.unproject(e.clientX, e.clientY);
    if (!n) {
      if (!at) return;
      Menu.show(e.clientX, e.clientY, [
        { label: 'Add sound point here', icon: 'pin', action: () => { const p = newPlace(at[0], at[1]); rebuild(); select(p.id); commit(); } },
        { label: 'Draw a region', icon: 'region', action: () => setTool('region') },
        '-',
        { label: 'Fit everything', icon: 'fit', action: () => fitAll() },
      ]);
      return;
    }
    const id = n.dataset.gid, p = placeOf(id), pin = pinOf(id);
    select(id);
    Menu.show(e.clientX, e.clientY, [
      p && hasSound(p) && { label: Scape.isPlaying(id) ? 'Pause' : 'Play', icon: 'play', action: () => toggle(p) },
      p && { label: 'Upload sound…', icon: 'upload', action: () => upload(p, 'audio') },
      p && { label: 'Start journey from here', icon: 'route', action: () => Journey.start(id) },
      pin && { label: pin.small ? 'Expand' : 'Collapse', icon: pin.small ? 'plus' : 'minus', action: () => { pin.small = !pin.small; rebuild(); commit(); } },
      '-',
      { label: 'Link to…', icon: 'link', action: () => setTool('link') },
      { label: pin ? 'Unpin from the map' : 'Delete', icon: 'trash', danger: true, action: () => removeSel() },
    ]);
  }

  function onItemDrop(e) {
    const id = e.dataTransfer.getData('application/x-tf-map');
    if (!id) return;
    e.preventDefault(); e.stopPropagation();
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-gid]')?.dataset.gid;
    const place = placeOf(target);
    const at = place ? anchor(place) : Geo.unproject(e.clientX, e.clientY);
    if (!at) return;
    const pin = pinItem(id, at, place?.id);
    if (!pin) return;
    if (place && !place.drive?.graph) setDriveGraph(place, id);
    rebuild(); select(pin.id); commit();
  }

  /** Audio files dropped on the map become points; dropped on a point they attach to it. */
  async function dropFiles(files, x, y) {
    const list = [...files];
    const sounds = list.filter(f => AudioLib.isAudio(f));
    if (!sounds.length) {
      if (list.length) toast('Drop sound files here. Scans and photos go on the Pinboard background.', '', 4500);
      return;
    }
    const target = placeOf(document.elementFromPoint(x, y)?.closest('[data-gid]')?.dataset.gid);
    const base = Geo.unproject(x, y);
    let i = 0, last = null;
    for (const f of sounds) {
      App.setBusy(`Reading ${f.name}…`);
      await nextFrame();
      try {
        const id = await AudioLib.add(f);
        const looksFelt = /felt|re-?design|warp|subjective/i.test(f.name);
        if (target) {
          Scape.drop(target.id);
          target[looksFelt || (target.audio && !target.felt) ? 'felt' : 'audio'] = id;
          last = target;
        } else if (base) {
          const meta = parseName(f.name), k = metersPerPx(base[1], Geo.camera().zoom) * 70 * i / 111320;
          last = newPlace(base[0] + k, base[1] - k * 0.6, { name: meta.title, who: meta.participant, [looksFelt ? 'felt' : 'audio']: id });
          i++;
        }
      } catch (err) { console.error(err); toast(`Could not read ${f.name}: ${err.message}`, 'bad', 6000); }
    }
    App.setBusy(null);
    if (!last) return;
    rebuild(); select(last.id); commit();
    toast(`Added ${sounds.length} sound${sounds.length > 1 ? 's' : ''}. Link a graph to drive ${sounds.length > 1 ? 'them' : 'it'}.`, 'good');
  }

  function upload(p, slot) {
    const input = el('input', { type: 'file', accept: AUDIO_ACCEPT, hidden: true, onchange: async e => {
      const f = e.target.files[0];
      input.remove();
      if (!f) return;
      App.setBusy(`Reading ${f.name}…`);
      await nextFrame();
      try {
        const id = await AudioLib.add(f);
        Scape.drop(p.id);
        p[slot] = id;
        rebuild(); select(p.id); commit();
      } catch (err) { console.error(err); toast(`Could not read ${f.name}: ${err.message}`, 'bad', 6000); }
      App.setBusy(null);
    } });
    document.body.append(input);
    input.click();
  }

  /* ---------- playback ---------- */
  function toggle(p) {
    if (!p) return;
    if (Scape.isPlaying(p.id) && !walkOn) { Scape.pause(p.id); clearPlayheads(); showDock(); return; }
    if (walkOn) setWalk(false);
    Scape.stopAll();
    if (!Scape.play(p)) return;
    focus = p.id;
    showDock();
  }

  function setMix(v) {
    Scape.mix = v;
    S.geo.mix = spaceFlip ? S.geo.mix : v;
    $('#gd-mix-in').value = v;
    $('#gd-mix-state').textContent = v > 0.66 ? 'As felt' : v < 0.34 ? 'As recorded' : 'Blended';
    saveSoon();
  }

  function clearPlayheads() {
    for (const pin of A().pins) {
      const ctx = nodes.get(pin.id)?.querySelector('.gn-plot')?._ctx;
      if (ctx?.play) ctx.play.innerHTML = '';
    }
  }

  function updatePlayheads() {
    const seen = new Set();
    for (const v of Scape.voices.values()) {
      if (!v.playing) continue;
      const st = Scape.state(v.place.id);
      for (const pin of pinsFor(v.place)) {
        if (seen.has(pin.id)) continue;
        const ctx = nodes.get(pin.id)?.querySelector('.gn-plot')?._ctx;
        if (!ctx?.play) continue;
        seen.add(pin.id);
        Plot.cursor(ctx, ctx.play, st.u, { color: v.place.color, width: 2, opacity: 0.9, r: 5, labels: ctx.kind === 'map' });
      }
    }
    for (const pin of A().pins) {
      nodes.get(pin.id)?.classList.toggle('spot', seen.has(pin.id));
      if (seen.has(pin.id)) continue;
      const ctx = nodes.get(pin.id)?.querySelector('.gn-plot')?._ctx;
      if (ctx?.play?.firstChild) ctx.play.innerHTML = '';
    }
  }

  /* ---------- soundwalk ---------- */
  function setWalk(on) {
    if (walkOn === on) return;
    if (on && !A().places.some(hasSound)) { toast('Add a point with a sound first.'); return; }
    if (on) { Journey.stop(); if (!Scape.ensure()) return; Scape.stopAll(); }
    walkOn = on;
    $('#btn-walk').classList.toggle('on', on);
    root.classList.toggle('walking', on);
    if (!on) { Scape.stopAll(); listener = null; }
    else toast('Soundwalk: move across the map and each place fades in as you get close.', 'good', 4200);
    dirty = true;
  }

  function walkTick() {
    const c = Geo.camera();
    if (!c) return;
    const useCursor = pointer && !pointer.touch;
    const at = useCursor ? Geo.unproject(pointer.x, pointer.y) : [c.lng, c.lat];
    if (!at) return;
    listener = at;
    const me = Geo.project(at[0], at[1]);
    let best = null, bestG = 0;
    for (const p of A().places) {
      if (!hasSound(p)) continue;
      const d = p.kind === 'region' ? ringDistance(at, p.ring) : meters(at, [p.lng, p.lat]);
      const k = 1 - d / Math.max(1, p.radius), g = k <= 0 ? 0 : k ** 1.6;
      const level = g * (p.vol ?? 1);
      V(p.id).g = g;
      if (g > 0.004) {
        const s = V(p.id).s, top = Geo.project(...anchor(p).map((v, i) => i ? v + p.radius / 111320 : v));
        const rpx = s ? Math.max(1, Math.hypot(top.x - s.x, top.y - s.y)) : 1;
        const pan = s && g < 0.99 ? clamp((s.x - me.x) / rpx, -1, 1) * 0.85 : 0;
        if (!Scape.isPlaying(p.id)) Scape.play(p, { loop: true, level, pan });
        else Scape.spatial(p.id, level, pan);
        if (g > bestG) { bestG = g; best = p; }
      } else if (Scape.isPlaying(p.id)) Scape.pause(p.id);
    }
    if (best && focus !== best.id) { focus = best.id; showDock(); }
  }

  /* ---------- effects canvas ---------- */
  function drawFx(now) {
    const dpr = devicePixelRatio || 1, W = root.clientWidth, H = root.clientHeight;
    if (fx.width !== Math.round(W * dpr) || fx.height !== Math.round(H * dpr)) { fx.width = Math.round(W * dpr); fx.height = Math.round(H * dpr); }
    fcx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fcx.clearRect(0, 0, W, H);
    if (CALM) return;
    // ripples leave each sounding place at its felt tempo: slow time, slow rings
    for (const v of Scape.voices.values()) {
      const p = v.place, s = V(p.id).s;
      if (!v.playing || !s || s.hidden) continue;
      if (now - (v.lastRing || 0) > 1050 / v.rate) { v.lastRing = now; rings.push({ id: p.id, t: now, c: p.color, sp: v.rate }); if (rings.length > 80) rings.shift(); }
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i], s = placeOf(r.id) && V(r.id).s;
      const age = (now - r.t) / (2600 / Math.max(0.5, r.sp));
      if (!s || age >= 1) { rings.splice(i, 1); continue; }
      const lv = Scape.level(r.id);
      fcx.beginPath();
      fcx.arc(s.x, s.y, 16 + age * (70 + lv * 90), 0, Math.PI * 2);
      fcx.strokeStyle = rgba(r.c, (1 - age) ** 1.5 * (0.25 + lv * 0.75));
      fcx.lineWidth = 1 + lv * 2.4;
      fcx.stroke();
    }
    // particles along links travel at the tempo of whichever end is sounding
    for (const g of linkGeo.values()) {
      const l = g.l, va = Scape.voices.get(l.a), vb = Scape.voices.get(l.b);
      const v = va?.playing ? va : vb?.playing ? vb : null;
      if (!v && l.style !== 'flow') continue;
      const lv = V(l.id);
      lv.ph = ((lv.ph || 0) + (v ? v.rate : 0.5) * 0.0045 * (220 / Math.max(80, g.len)) * 16) % 1;
      for (let k = 0; k < 4; k++) {
        const t = (lv.ph + k / 4) % 1, m = 1 - t;
        const x = m * m * g.p0[0] + 2 * m * t * g.c[0] + t * t * g.p2[0], y = m * m * g.p0[1] + 2 * m * t * g.c[1] + t * t * g.p2[1];
        fcx.beginPath();
        fcx.arc(x, y, v ? 3.2 : 2.2, 0, Math.PI * 2);
        fcx.fillStyle = l.color;
        fcx.globalAlpha = Math.sin(t * Math.PI) * 0.95;
        fcx.fill();
      }
      fcx.globalAlpha = 1;
    }
    // the listener, tethered to whatever it can hear
    if (walkOn && listener) {
      const me = Geo.project(listener[0], listener[1]);
      for (const p of A().places) {
        const { s, g } = V(p.id);
        if (!hasSound(p) || !s || !(g > 0.004)) continue;
        fcx.beginPath(); fcx.moveTo(me.x, me.y); fcx.lineTo(s.x, s.y);
        fcx.strokeStyle = rgba(p.color, 0.15 + g * 0.6);
        fcx.lineWidth = 0.6 + g * 3;
        fcx.setLineDash([2, 7]); fcx.stroke(); fcx.setLineDash([]);
      }
      const pulse = 1 + Math.sin(now / 420) * 0.12;
      fcx.beginPath(); fcx.arc(me.x, me.y, 15 * pulse, 0, Math.PI * 2); fcx.strokeStyle = 'rgba(255,255,255,.75)'; fcx.lineWidth = 1.5; fcx.stroke();
      fcx.beginPath(); fcx.arc(me.x, me.y, 4.5, 0, Math.PI * 2); fcx.fillStyle = '#fff'; fcx.fill();
    }
  }

  /* ---------- listening dock ---------- */
  function showDock() {
    const p = placeOf(focus);
    dockEl.hidden = !p || !hasSound(p);
    if (dockEl.hidden) return;
    $('#gd-name').textContent = p.name || 'Untitled';
    $('#gd-sub').textContent = [p.who, !p.felt && !p.drive?.tempo?.line && !p.drive?.gain?.line ? 'no felt-time drive yet' : ''].filter(Boolean).join(' · ') || (p.felt ? (p.audio ? 'recording + re-design' : 're-designed take') : 'driven by the graph');
    const driven = (!p.felt || p.drive?.feltToo) && DRIVE_TARGETS.some(([k]) => p.drive?.[k]?.line);
    $('#gd-mix').classList.toggle('off', !(p.audio && p.felt) && !driven);
    drawDock();
  }

  function drawDock() {
    if (dockEl.hidden) return;
    const p = placeOf(focus);
    if (!p) return;
    const st = Scape.state(p.id), a = AUDIO.get(p.audio || p.felt);
    const playBtn = $('#gd-play'), playing = !!st?.playing;
    if (playBtn.dataset.on !== String(playing)) { playBtn.dataset.on = String(playing); playBtn.innerHTML = ic(playing ? 'pause' : 'play'); }
    const dur = st?.dur || a?.dur || 0, u = st?.u || 0;
    const cv = $('#gd-wave'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const cx = cv.getContext('2d'), T = Theme.t();
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, W, H);
    const peaks = a?.peaks, bars = Math.max(10, Math.floor(W / 3));
    for (let i = 0; i < bars; i++) {
      const k = i / bars, v = peaks ? peaks[Math.floor(k * peaks.length)] : 0.3, h = Math.max(1.5, v * (H - 6));
      cx.fillStyle = k <= u ? p.color : rgba(T.text, 0.25);
      cx.fillRect(i * 3, (H - h) / 2, 2, h);
    }
    // the driving line over the waveform, so the listener sees what is steering the sound
    const d = p.drive, lines = d?.graph ? graphLinesCached(d.graph) : [];
    const shown = lines.find(l => l.id === d?.tempo?.line) || lines.find(l => l.id === d?.gain?.line);
    if (shown) {
      cx.beginPath();
      let pen = false;
      for (let i = 0; i <= 80; i++) {
        const v = sampleAt(shown.pts, i / 80);
        if (v == null) { pen = false; continue; }
        const x = i / 80 * W, y = (1 - v) * (H - 4) + 2;
        pen ? cx.lineTo(x, y) : cx.moveTo(x, y);
        pen = true;
      }
      cx.strokeStyle = shown.color; cx.lineWidth = 1.6; cx.stroke();
    }
    cx.fillStyle = T.text; cx.fillRect(u * W - 0.75, 0, 1.5, H);
    const clock = st?.clock ?? 0, felt = st?.felt ?? 0, feltDur = st?.feltDur ?? dur;
    $('#gd-time').textContent = `${fmtTime(clock)} / ${fmtTime(dur)}`;
    $('#gd-felt').textContent = `felt ${fmtTime(felt)} / ${fmtTime(feltDur)}`;
    const rate = st?.rate ?? 1;
    $('#gd-pace').textContent = !st?.playing ? '' : rate < 0.92 ? `time dragging ×${rate.toFixed(2)}` : rate > 1.08 ? `time flying ×${rate.toFixed(2)}` : 'time steady';
    dial(clock, felt, p.color);
  }

  function dial(clock, felt, color) {
    const cv = $('#gd-dial'), dpr = devicePixelRatio || 1, S0 = cv.clientWidth;
    if (cv.width !== S0 * dpr) { cv.width = cv.height = S0 * dpr; }
    const cx = cv.getContext('2d'), T = Theme.t(), r = S0 / 2 - 2;
    cx.setTransform(dpr, 0, 0, dpr, S0 / 2, S0 / 2);
    cx.clearRect(-S0 / 2, -S0 / 2, S0, S0);
    cx.beginPath(); cx.arc(0, 0, r, 0, Math.PI * 2); cx.strokeStyle = rgba(T.text, 0.25); cx.lineWidth = 1.5; cx.stroke();
    const hand = (sec, len, col, w) => { const a = sec / 60 * Math.PI * 2 - Math.PI / 2; cx.beginPath(); cx.moveTo(0, 0); cx.lineTo(Math.cos(a) * len, Math.sin(a) * len); cx.strokeStyle = col; cx.lineWidth = w; cx.lineCap = 'round'; cx.stroke(); };
    const ac = clock / 60 * Math.PI * 2 - Math.PI / 2, af = felt / 60 * Math.PI * 2 - Math.PI / 2;
    if (Math.abs(felt - clock) > 0.2) { cx.beginPath(); cx.moveTo(0, 0); cx.arc(0, 0, r - 3, ac, af, felt < clock); cx.closePath(); cx.fillStyle = rgba(color, 0.32); cx.fill(); }
    hand(clock, r - 5, T.text, 1.6);
    hand(felt, r - 2, color, 2.4);
  }

  const lineCache = new Map();
  function graphLinesCached(id) {
    const c = lineCache.get(id);
    if (c && performance.now() - c.t < 1500) return c.lines;
    const lines = graphLines(getItem(id));
    lineCache.set(id, { t: performance.now(), lines });
    return lines;
  }

  /* ---------- frame ---------- */
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!active || !Geo.ready) return;
    if (dirty) { dirty = false; layout(); }
    if (now - lastTick > 40) {
      lastTick = now;
      if (walkOn) walkTick();
      Scape.tick();
      updatePlayheads();
      for (const p of A().places) nodes.get(p.id)?.style.setProperty('--lv', Scape.level(p.id).toFixed(3));
      for (const p of A().places) nodes.get(p.id)?.classList.toggle('playing', Scape.isPlaying(p.id));
      drawDock();
      if (A().places.some(p => p.kind === 'region' && Scape.level(p.id) > 0.01)) dirty = true;
    }
    Journey.frame();
    drawFx(now);
  }

  /* ---------- camera ---------- */
  function bounds() {
    const pts = [...A().places.flatMap(p => p.ring || [[p.lng, p.lat]]), ...A().pins.map(p => [p.lng, p.lat])];
    if (!pts.length) return null;
    return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
  }
  function fitAll() {
    const b = bounds();
    if (!b) return toast('Nothing on the map yet.');
    if (b[0] === b[2] && b[1] === b[3]) return Geo.flyTo({ lng: b[0], lat: b[1], zoom: 14, pitch: 0, bearing: 0 }, 1400);
    const left = $('#library').classList.contains('collapsed') ? 70 : 300, right = $('#inspector').classList.contains('collapsed') ? 70 : 370;
    Geo.fit(b, exhibitOn ? 120 : { top: 120, bottom: 150, left, right }, 15);
  }
  function flyToPlace(p) {
    const [lng, lat] = anchor(p), c = Geo.camera();
    const zoom = Math.log2(EARTH_C * Math.cos(lat * DEG) / (512 * Math.max(40, p.radius) / 170));
    Geo.flyTo({ lng, lat, zoom: clamp(zoom, 2, 18), pitch: c?.pitch || 0, bearing: c?.bearing || 0 }, 1800);
  }

  async function runSearch(q) {
    q = q.trim();
    const box = $('#geo-results');
    if (!q) { box.hidden = true; return; }
    box.hidden = false; box.innerHTML = '<div class="gr-empty">Searching…</div>';
    try {
      const rows = await Geo.search(q);
      box.innerHTML = '';
      if (!rows.length) { box.innerHTML = '<div class="gr-empty">Nothing found.</div>'; return; }
      for (const r of rows) box.append(el('button', { class: 'gr', onclick: () => {
        box.hidden = true;
        if (r.bbox) Geo.fit(r.bbox, 140, 16); else Geo.flyTo({ lng: r.lng, lat: r.lat, zoom: 14, pitch: 0, bearing: 0 });
      } }, r.name));
    } catch (err) { box.innerHTML = ''; box.append(el('div', { class: 'gr-empty' }, 'Search failed: ' + err.message)); }
  }

  /* ---------- journey ---------- */
  const Journey = {
    on: false, list: [], i: 0, timer: 0, token: 0,
    /** Places in story order: follow arrows and flows, passing through graphs, then anything left. */
    route(from) {
      const a = A(), next = new Map(), incoming = new Set();
      for (const l of a.links) if (l.style === 'arrow' || l.style === 'flow') { (next.get(l.a) || next.set(l.a, []).get(l.a)).push(l.b); incoming.add(l.b); }
      const out = [], seen = new Set();
      const walk = id => {
        if (seen.has(id)) return;
        seen.add(id);
        if (placeOf(id)) out.push(placeOf(id));
        (next.get(id) || []).forEach(walk);
      };
      if (from) walk(from);
      a.places.filter(p => !incoming.has(p.id)).forEach(p => walk(p.id));
      a.places.forEach(p => walk(p.id));
      return out;
    },
    toggle() { this.on ? this.stop() : this.start(sel && placeOf(sel) ? sel : null); },
    start(from) {
      const list = this.route(from);
      if (!list.length) return toast('Add some points first.');
      if (!Scape.ensure()) return;
      setWalk(false);
      Scape.stopAll();
      Object.assign(this, { on: true, list, i: -1 });
      $('#btn-journey').classList.add('on');
      root.classList.add('journeying');
      this.next();
    },
    stop() {
      if (!this.on) return;
      this.on = false; this.token++;
      clearTimeout(this.timer);
      Scape.stopAll();
      $('#btn-journey').classList.remove('on');
      root.classList.remove('journeying');
      $('#geo-caption').hidden = true;
      for (const q of A().places) nodes.get(q.id)?.classList.remove('spot');
      clearPlayheads();
    },
    next(step = 1) {
      this.i += step;
      if (this.i >= this.list.length || this.i < 0) { this.stop(); toast('End of the journey.'); return fitAll(); }
      const p = this.list[this.i], tok = ++this.token;
      clearTimeout(this.timer);
      Scape.stopAll();
      const [lng, lat] = anchor(p), c = Geo.camera();
      const zoom = clamp(Math.log2(EARTH_C * Math.cos(lat * DEG) / (512 * Math.max(40, p.radius) / 170)), 2, 17.5);
      Geo.flyTo({ lng, lat, zoom, pitch: 58, bearing: (c?.bearing || 0) + 35 }, 3400);
      focus = p.id;
      for (const q of A().places) nodes.get(q.id)?.classList.toggle('spot', q === p);
      $('#gc-name').textContent = p.name || '';
      $('#gc-who').textContent = p.who || '';
      $('#gc-quote').textContent = p.quote || p.note || '';
      $('#gc-count').textContent = `${this.i + 1} / ${this.list.length}`;
      $('#geo-caption').hidden = false;
      showDock();
      this.timer = setTimeout(() => {
        if (tok !== this.token) return;
        if (hasSound(p) && Scape.play(p)) {
          showDock();
          const cap = (A().stopSecs || 40) * 1000;
          this.timer = setTimeout(() => { if (tok === this.token) this.next(); }, cap);
        } else this.timer = setTimeout(() => { if (tok === this.token) this.next(); }, 5000);
      }, 2800);
    },
    ended(id) { if (this.on && this.list[this.i]?.id === id) { const tok = this.token; clearTimeout(this.timer); this.timer = setTimeout(() => { if (tok === this.token) this.next(); }, 1200); } },
    frame() { if (this.on && Scape.isPlaying(this.list[this.i]?.id) && !CALM) Geo.orbit(0.012); },
  };

  /* ---------- exhibit mode ---------- */
  function exhibit(on, intro = true) {
    exhibitOn = on;
    document.body.classList.toggle('exhibit', on);
    $('#geo-hint').hidden = on || !!A().places.length;
    if (!on) { Journey.stop(); setWalk(false); $('#geo-intro').hidden = true; Inspector.show(); return; }
    select(null);
    setTool('select');
    $('#geo-exit').hidden = !!App.locked;
    $('#gi-title').textContent = A().title || 'Felt time';
    $('#gi-text').textContent = A().intro || 'Each place holds a recording, reshaped by how someone experienced the passing of time there. Wander the map and listen, or take the guided journey.';
    $('#geo-intro').hidden = !intro;
    fitAll();
  }

  /* ---------- keyboard ---------- */
  function key(e) {
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === ' ') {
      e.preventDefault();
      if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
      if (!e.repeat && !spaceFlip) { spaceFlip = true; mixBase = Scape.mix; setMix(mixBase > 0.5 ? 0 : 1); }
      return;
    }
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? Hist.redo() : Hist.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); Hist.redo(); return; }
    if (mod && k === 's') { e.preventDefault(); App.exportProject(); return; }
    if (mod || e.altKey) return;
    if (exhibitOn) {
      if (k === 'escape') { if (Journey.on) Journey.stop(); else if (!App.locked) exhibit(false); }
      if (k === 'arrowright' && Journey.on) Journey.next();
      if (k === 'arrowleft' && Journey.on) Journey.next(-1);
      return;
    }
    const act = {
      v: () => setTool('select'), a: () => setTool('point'), r: () => setTool('region'), c: () => setTool('link'),
      w: () => setWalk(!walkOn), j: () => Journey.toggle(), x: () => exhibit(true), f: () => fitAll(), '?': () => Help.open(),
      '=': () => Geo.zoomBy(1.6), '+': () => Geo.zoomBy(1.6), '-': () => Geo.zoomBy(0.6),
      delete: () => removeSel(), backspace: () => removeSel(),
      enter: () => { if (tool === 'region') finishRegion(); },
      arrowright: () => { if (Journey.on) Journey.next(); },
      arrowleft: () => { if (Journey.on) Journey.next(-1); },
      escape: () => {
        if (Journey.on) return Journey.stop();
        if (walkOn) return setWalk(false);
        if (tool !== 'select') return setTool('select');
        Scape.stopAll(); select(null);
      },
    };
    const f = act[k];
    if (f) { e.preventDefault(); f(); }
  }

  /* ---------- inspector forms ---------- */
  function form() {
    if (!sel) return overview();
    if (placeOf(sel)) return placeForm(placeOf(sel));
    if (pinOf(sel)) return pinForm(pinOf(sel));
    if (linkOf(sel)) return linkForm(linkOf(sel));
    return overview();
  }

  const head = (color, kind, title, sub) => el('div', { class: 'insp-head' }, el('span', { class: 'swatch big', style: { background: color } }), el('div', {}, el('small', {}, kind), el('h3', {}, title), sub && el('p', {}, sub)));
  const nodeName = id => { const p = placeOf(id); if (p) return p.name || 'Point'; const it = getItem(pinOf(id)?.item); return it ? (it.type === 'lens' ? it.title : it.meta.title) : '—'; };
  const sync = () => { dirty = true; };

  function overview() {
    const a = A(), key = GoogleKey.get();
    const stops = Journey.route();
    return [
      el('div', { class: 'insp-head' }, el('span', { class: 'logo-mini', html: ic('earth') }), el('div', {}, el('small', {}, 'Atlas'), el('h3', {}, a.title || 'Soundscape map'), el('p', {}, 'Select a point, graph or link to edit it.'))),
      el('div', { class: 'kpis' }, [['Points', a.places.filter(p => p.kind !== 'region').length], ['Regions', a.places.filter(p => p.kind === 'region').length], ['Sounds', a.places.filter(hasSound).length], ['Graphs', a.pins.length]].map(([l, n]) => el('div', { class: 'kpi' }, el('b', {}, n), el('small', {}, l)))),
      el('div', { class: 'btn-grid' },
        UI.btn('Soundwalk', 'walk', () => setWalk(!walkOn), walkOn ? 'primary' : ''),
        UI.btn('Journey', 'route', () => Journey.toggle(), Journey.on ? 'primary' : ''),
        UI.btn('Exhibit mode', 'sparkle', () => exhibit(true)),
        UI.btn('Fit everything', 'fit', () => fitAll())),
      UI.section('Background', [
        el('div', { class: 'bg-grid' }, BASEMAPS.map(b => el('button', { type: 'button', class: 'bg-tile' + (S.geo.basemap === b.id ? ' on' : '') + (b.key && !key ? ' locked' : ''), onclick: () => setBackground(b.id) }, b.label, b.key && !key && el('span', { html: ic('lock') })))),
        UI.btn(key ? 'Change Google API key' : 'Add Google API key', 'lock', () => keyDialog(), 'ghost'),
      ]),
      UI.section('Journey', [
        stops.length ? el('ol', { class: 'stops' }, stops.map(p => el('li', {}, el('button', { type: 'button', onclick: () => { select(p.id); flyToPlace(p); } }, el('i', { style: { background: p.color } }), p.name, hasSound(p) && el('span', { html: ic('wave') }))))) : UI.hint('Add points to build a route.'),
        UI.hint('Order follows your arrows and flow links. Points with no route come last.'),
        UI.field('Longest stop', UI.range(a.stopSecs || 40, 10, 180, 5, x => { a.stopSecs = x; }, x => x + ' s')),
      ], false),
      UI.section('Exhibit text', [
        UI.field('Title', UI.text(a.title, x => { a.title = x; })),
        UI.field('Introduction', UI.area(a.intro, x => { a.intro = x; }, { rows: 3, placeholder: 'What should a visitor know before they listen?' })),
      ], false),
      UI.section('Data', [el('div', { class: 'btn-grid' },
        UI.btn('Load sound demo', 'sparkle', () => loadDemo()),
        UI.btn('Export GeoJSON', 'download', () => exportGeo()))], false),
    ];
  }

  function slot(p, key, title, hint) {
    const a = AUDIO.get(p[key]);
    if (!a) return el('div', { class: 'slot empty' }, el('b', {}, title), el('p', { class: 'hint' }, hint), UI.btn('Upload sound', 'upload', () => upload(p, key), 'ghost'));
    const cv = el('canvas', { class: 'slot-wave', width: 300, height: 36 });
    requestAnimationFrame(() => {
      const cx = cv.getContext('2d'), n = a.peaks?.length || 0;
      cx.fillStyle = p.color;
      for (let i = 0; i < 100 && n; i++) { const v = a.peaks[Math.floor(i / 100 * n)], h = Math.max(1, v * 34); cx.fillRect(i * 3, (36 - h) / 2, 2, h); }
    });
    return el('div', { class: 'slot' }, el('b', {}, title), cv,
      el('small', { class: 'slot-meta', title: a.name }, `${a.name} · ${fmtTime(a.dur)} · ${(a.size / 1e6).toFixed(1)} MB`),
      UI.row(UI.btn('Replace', 'upload', () => upload(p, key), 'ghost'), UI.btn('Remove', 'x', () => { Scape.drop(p.id); p[key] = null; rebuild(); commit(); Inspector.show(); showDock(); }, 'ghost danger')));
  }

  function placeForm(p) {
    const up = () => { nodes.get(p.id)?.querySelector('.gp-name')?.replaceChildren(p.name || 'Untitled'); dirty = true; };
    const d = p.drive || (p.drive = defaultDrive());
    const graphs = [...itemsOf('map'), ...itemsOf('lens')];
    const linked = linkedItems(p).map(getItem).filter(Boolean);
    const gname = it => it.type === 'lens' ? `Lens · ${it.title}` : it.meta.title || 'Untitled map';
    const lines = graphLines(getItem(d.graph));
    return [
      head(p.color, p.kind === 'region' ? 'Region' : 'Sound point', p.name || 'Untitled', [`${anchor(p)[1].toFixed(4)}, ${anchor(p)[0].toFixed(4)}`].join('')),
      hasSound(p) && el('div', { class: 'btn-grid' }, UI.btn(Scape.isPlaying(p.id) ? 'Pause' : 'Play', Scape.isPlaying(p.id) ? 'pause' : 'play', () => { toggle(p); Inspector.show(); }, 'primary'), UI.btn('Fly here', 'fit', () => flyToPlace(p))),
      UI.section('Place', [
        UI.field('Name', UI.text(p.name, x => { p.name = x; up(); })),
        UI.field('Participant', UI.text(p.who, x => { p.who = x; }, { placeholder: 'P01', list: 'dl-participants' })),
        UI.field('Quote or note, shown on the journey', UI.area(p.quote, x => { p.quote = x; }, { rows: 2, placeholder: '“It felt like the afternoon stopped here.”' })),
        UI.field('Colour', UI.swatches(p.color, PALETTE, c => { p.color = c; rebuild(); commit(); })),
      ]),
      UI.section('Sound', [
        slot(p, 'audio', 'As recorded', 'The original soundscape: WAV, MP3, M4A, OGG or FLAC.'),
        slot(p, 'felt', 'As felt (re-designed)', 'Optional: your re-designed version. Without one, the felt-time drive below reshapes the recording live.'),
        UI.field('Volume', UI.range(p.vol ?? 1, 0, 1.5, 0.01, x => { p.vol = x; if (Scape.isPlaying(p.id) && !walkOn) Scape.spatial(p.id, x, 0); }, pct)),
        UI.field('Soundwalk reach', UI.range(p.radius, 20, 20000, 10, x => { p.radius = x; sync(); }, x => x >= 1000 ? (x / 1000).toFixed(1) + ' km' : x + ' m')),
      ]),
      UI.section(`Linked graphs (${linked.length})`, [
        linked.length ? el('div', { class: 'linked' }, linked.map(it => el('div', { class: 'linked-row' }, el('span', { class: 'swatch', style: { background: it.color || Theme.t().accent } }), el('span', {}, gname(it))))) : null,
        graphs.length ? UI.field('Pin a graph here and link it', UI.select('', [['', 'Choose a graph…'], ...graphs.map(g => [g.id, gname(g)])], id => {
          if (!id) return;
          const pin = pinItem(id, anchor(p), p.id);
          if (pin && !p.drive.graph) setDriveGraph(p, id);
          rebuild();
          Inspector.show();
        })) : UI.hint('No graphs yet. Import scans on the Pinboard background, or load the sound demo.'),
      ]),
      UI.section('Felt-time drive', [
        UI.hint(p.felt ? 'Your “as felt” file plays exactly as uploaded. To steer it with a drawn line as well, choose the lines below and tick the box.' : 'Let a drawn line steer the recording while it plays, then compare with the slider in the dock.'),
        UI.field('Read lines from', UI.select(d.graph || '', [['', 'No graph'], ...graphs.map(g => [g.id, gname(g)])], id => { setDriveGraph(p, id); showDock(); })),
        d.graph && p.felt && UI.check(!!d.feltToo, 'Apply to the “as felt” file', x => { d.feltToo = x; Scape.refresh(p); showDock(); }),
        d.graph && DRIVE_TARGETS.map(([k, label, tip]) => el('div', { class: 'drive-row', title: tip },
          el('div', { class: 'drive-top' }, el('b', {}, label), UI.select(d[k].line || '', [['', 'Off'], ...lines.map(l => [l.id, l.name])], id => { d[k].line = id || null; Scape.refresh(p); showDock(); })),
          d[k].line && el('div', { class: 'drive-bot' }, UI.range(d[k].depth, 0, 2, 0.05, x => { d[k].depth = x; Scape.refresh(p); }, x => x.toFixed(2)), UI.check(d[k].inv, 'Invert', x => { d[k].inv = x; Scape.refresh(p); })))),
        d.graph && d.tempo.line && UI.check(d.keepPitch !== false, 'Keep pitch when the tempo changes', x => { d.keepPitch = x; Scape.refresh(p); }),
      ]),
      el('div', { class: 'btn-grid' }, UI.btn('Link to…', 'link', () => setTool('link')), UI.btn('Delete', 'trash', () => removeSel(), 'danger')),
    ];
  }

  function pinForm(pin) {
    const it = getItem(pin.item), title = it.type === 'lens' ? it.title : it.meta.title;
    const places = A().places;
    return [
      head(it.color || Theme.t().accent, it.type === 'lens' ? 'Pinned lens' : 'Pinned graph', title || 'Graph', `${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`),
      UI.check(pin.small, 'Collapsed to a title', x => { pin.small = x; rebuild(); }),
      UI.row(UI.field('Width', UI.num(pin.w, x => { pin.w = Math.max(260, x); renderPlot(pin); sync(); })), UI.field('Height', UI.num(pin.h, x => { pin.h = Math.max(170, x); renderPlot(pin); sync(); }))),
      places.length > 0 && UI.field('Link to a place', UI.select('', [['', 'Choose a place…'], ...places.map(p => [p.id, p.name])], id => {
        if (!id) return;
        const place = placeOf(id), l = link(id, pin.id, { style: 'dash', color: place.color });
        if (l) autoDrive(l);
        dirty = true; Inspector.show();
      })),
      UI.hint('Drag the title bar to move the card; drag the small dot on the map to re-pin it.'),
      el('div', { class: 'btn-grid' },
        UI.btn('Open on pinboard', 'grid', () => { leave(); Board.select([it.id]); Board.fit([it.id]); }),
        UI.btn('Unpin', 'trash', () => removeSel(), 'danger')),
    ];
  }

  function linkForm(l) {
    return [
      head(l.color, 'Link', `${nodeName(l.a)} → ${nodeName(l.b)}`),
      UI.field('Style', UI.seg(l.style, LINK_STYLES, x => { l.style = x; S.geo.linkStyle = x; sync(); })),
      UI.field('Label', UI.text(l.label, x => { l.label = x; sync(); }, { placeholder: 'e.g. same participant, later' })),
      UI.field('Colour', UI.swatches(l.color, ['#ffffff', ...PALETTE.slice(0, 6)], c => { l.color = c; sync(); commit(); })),
      el('div', { class: 'btn-grid' }, UI.btn('Flip direction', 'route', () => { [l.a, l.b] = [l.b, l.a]; sync(); commit(); Inspector.show(); }), UI.btn('Delete', 'trash', () => removeSel(), 'danger')),
    ];
  }

  /* ---------- GeoJSON ---------- */
  function exportGeo() {
    const feats = A().places.map(p => ({
      type: 'Feature',
      geometry: p.kind === 'region' ? { type: 'Polygon', coordinates: [[...p.ring, p.ring[0]]] } : { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: { id: p.id, name: p.name, participant: p.who, quote: p.quote, recording: AUDIO.get(p.audio)?.name || null, felt: AUDIO.get(p.felt)?.name || null, reach_m: p.radius, graphs: linkedItems(p) },
    }));
    for (const pin of A().pins) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [pin.lng, pin.lat] }, properties: { id: pin.id, graph: pin.item, name: nodeName(pin.id) } });
    download(`tracefield-atlas-${App.stamp()}.geojson`, JSON.stringify({ type: 'FeatureCollection', features: feats }, null, 1), 'application/geo+json');
  }

  /* ---------- demo ---------- */
  async function loadDemo() {
    if (!active) await enter('satellite');
    App.setBusy('Synthesising demo soundscapes…');
    await nextFrame();
    try {
      const secs = 26, rnd = mulberry32(11);
      const axes = { ...defaultAxes(), yHigh: 'Time flew', yLow: 'Time dragged', xStart: 'Start', xEnd: 'End', xTitle: 'Listening', xMin: 0, xMax: 10, xUnit: 'min', yMax: 100 };
      const wobble = (f, amp) => { const ph = rnd() * 6; return u => Math.sin(u * f + ph) * amp; };
      const mk = (name, color, f) => { const w = wobble(9, 0.025), pts = []; for (let i = 0; i <= 120; i++) { const u = i / 120; pts.push([round(u), round(clamp(f(u) + w(u), 0, 1))]); } return { id: uid('l'), name, key: name, color, visible: true, pts, adj: { dy: 0, sy: 1, smooth: 0 } }; };
      const scenes = [
        { name: 'Djurgården woods', who: 'P01', kind: 'forest', cond: 'woodland', quote: 'Demo text: “The longer I listened, the more the minutes stretched out.”', pace: u => 0.42 - 0.3 * Math.sin(u * Math.PI), sal: u => 0.35 + 0.5 * Math.abs(Math.sin(u * 9)), ring: [[18.103, 59.3305], [18.1215, 59.3345], [18.1335, 59.3272], [18.1195, 59.3208], [18.104, 59.3238]], at: [18.118, 59.3278], radius: 700 },
        { name: 'Skeppsholmen quay', who: 'P02', kind: 'harbour', cond: 'waterside', quote: 'Demo text: “It slowed, then everything rushed back when the horn went.”', pace: u => clamp(0.3 + 0.75 * u ** 2.4, 0, 1), sal: u => 0.3 + 0.55 * u, at: [18.0855, 59.3253], radius: 480, warp: true },
        { name: 'Slussen crossing', who: 'P03', kind: 'city', cond: 'traffic', quote: 'Demo text: “Time flew. I could not tell you what I heard, only that it was over.”', pace: u => 0.8 - 0.14 * Math.sin(u * 7), sal: u => 0.72 - 0.42 * u, at: [18.0715, 59.3203], radius: 460 },
      ];
      const made = [];
      const [cx, cy] = Board.centerWorld();
      for (let i = 0; i < scenes.length; i++) {
        const s = scenes[i];
        App.setBusy(`Synthesising ${s.name}…`);
        await nextFrame();
        const lines = [mk('Felt pace', '#5aa9ff', s.pace), mk('Sound salience', '#ff4fa3', s.sal)];
        const m = App.createMap({ axes: clone(axes), meta: { title: `${s.who} · ${s.name}`, participant: s.who, session: '1', condition: s.cond, date: today(), tags: ['demo', 'sound'], notes: 'Synthetic demo data.' }, lines }, null, [cx - 300, cy + 500 + i * 420]);
        const buf = await DemoSound.render(s.kind, secs, 3 + i);
        const file = new File([DemoSound.wav(buf)], `demo-${s.kind}.wav`, { type: 'audio/wav' });
        const audio = await AudioLib.add(file);
        let felt = null;
        if (s.warp) {
          const warped = await DemoSound.warp(buf, lines[0].pts);
          felt = await AudioLib.add(new File([DemoSound.wav(warped)], `demo-${s.kind}-felt.wav`, { type: 'audio/wav' }));
        }
        const extra = { name: s.name, who: s.who, quote: s.quote, audio, felt, radius: s.radius, color: PALETTE[[3, 0, 1][i]] };
        const p = s.ring ? newPlace(s.at[0], s.at[1], { kind: 'region', ring: s.ring, ...extra }) : newPlace(s.at[0], s.at[1], extra);
        const pin = pinItem(m.id, s.at, p.id);
        Object.assign(pin, { w: 285, h: 190, dx: [-71, -99, -290][i], dy: [198, 155, 69][i], z0: 11.5 });
        setDriveGraph(p, m.id);
        made.push(p);
      }
      link(made[0].id, made[1].id, { style: 'arrow', color: '#ffffff' });
      link(made[1].id, made[2].id, { style: 'flow', color: '#ffffff' });
      A().title = A().title || 'Felt time (demo)';
      rebuild();
      Library.render();
      commit();
      Geo.flyTo({ lng: 18.0975, lat: 59.325, zoom: 12.6, pitch: 0, bearing: 0 }, 1800);
      toast('Demo loaded. Sounds and quotes are synthetic. Try Soundwalk (W) or Journey (J).', 'good', 6500);
    } catch (err) { console.error(err); toast('Demo failed: ' + err.message, 'bad', 6000); }
    App.setBusy(null);
  }

  function focusItem(itemId) {
    const pin = A().pins.find(p => p.item === itemId);
    if (pin) { select(pin.id); Geo.flyTo({ lng: pin.lng, lat: pin.lat, zoom: Math.max(Geo.camera().zoom, pin.z0), pitch: Geo.camera().pitch, bearing: Geo.camera().bearing }, 1400); return; }
    const c = Geo.camera(), p = pinItem(itemId, [c.lng, c.lat]);
    if (p) { rebuild(); select(p.id); commit(); }
  }

  /** From the pinboard's card menu: open the map and pin this graph at the camera. */
  async function pinFromBoard(itemId) {
    if (!active) await enter();
    focusItem(itemId);
  }

  return {
    init, enter, leave, rebuild, form, key, forget, dropFiles, loadDemo, exhibit, focusItem, pinFromBoard,
    get active() { return active; },
    get exhibiting() { return exhibitOn; },
    screenOf: id => V(id),
    zoomBy: k => Geo.zoomBy(k), fitAll, setMix,
    setBackground, keyDialog,
  };
})();
