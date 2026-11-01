'use strict';
/* =====================================================================
   Tracefield · digitizer
   calibrate a scan (4-corner perspective frame + axes), read its ink,
   review / reassign / trace lines, label it, and save as a map
   ===================================================================== */

const Digitizer = (() => {
  let D = null, root, cv, cx, side, img, rectCv = null, inkCv = null, space = false;
  const V = { x: 0, y: 0, z: 1 };

  function init() {
    root = $('#digitizer'); cv = $('#dz-canvas'); cx = cv.getContext('2d'); side = $('#dz-side');
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('pointermove', e => { if (!D) return; const r = cv.getBoundingClientRect(); D.cursor = [e.clientX - r.left, e.clientY - r.top]; drawSoon(); });
    cv.addEventListener('pointerleave', () => { if (D) { D.cursor = null; drawSoon(); } });
    cv.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize', () => D && draw());
    window.addEventListener('keydown', e => {
      if (!D || root.hidden || e.target.closest('input,textarea,select')) return;
      if (e.key === 'Escape') close();
      else if (e.key === ' ') { space = true; cv.classList.add('space'); e.preventDefault(); }
      else if (e.key === 'f') fitView();
      else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') save();
      else if (['1', '2', '3', '4'].includes(e.key)) setTool(['frame', 'erase', 'trace', 'pick'][+e.key - 1]);
    });
    window.addEventListener('keyup', e => { if (e.key === ' ') { space = false; cv.classList.remove('space'); } });
    $('#dz-close').onclick = close;
    $('#dz-cancel').onclick = close;
    $('#dz-save').onclick = save;
    $('#dz-fit').onclick = () => fitView();
    $$('#dz-views [data-show]').forEach(b => b.onclick = () => setShow(b.dataset.show));
    $$('#dz-tools [data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
    $('#dz-brush').oninput = e => { if (D) { D.brush = +e.target.value; drawSoon(); } };
  }

  const setStatus = (t, busy = false) => { const s = $('#dz-status'); s.textContent = t; s.classList.toggle('busy', busy); };

  async function open({ scanId, mapId } = {}) {
    const map = mapId ? getItem(mapId) : null;
    const scan = scanId ? getItem(scanId) : map?.source ? getItem(map.source) : null;
    const assetId = map?.asset || scan?.asset;
    if (!assetId || !ASSETS.has(assetId)) return toast('No scan image is attached to this map.', 'bad');
    Player.stop();
    root.hidden = false;
    side.innerHTML = '';
    setStatus('Loading image…', true);
    const a = ASSETS.get(assetId);
    img = await Vision.loadImg(a.src);
    const px = await Vision.pixels(assetId);
    const T = S.template || {};
    D = {
      assetId, scanId: scan?.id || map?.source || null, mapId: map?.id || null, px,
      name: scan?.name || map?.meta.title || 'Scan',
      quad: map?.quad ? clone(map.quad) : Vision.detectFrame(px),
      rectLock: false,
      axes: clone(map?.axes || T.axes || defaultAxes()),
      meta: clone(map?.meta || parseName(scan?.name || '')),
      ink: { sens: 26, guard: 0.015, k: 'auto', minSpan: 0.2, erase: [], disabled: [], ...clone(T.ink || {}), ...clone(map?.ink || {}) },
      lines: map ? clone(map.lines) : [],
      live: !map || !!map.auto, res: null, tool: 'frame', show: 'photo', brush: 0.025, hl: null, cursor: null, trace: null,
    };
    D.meta.tags = D.meta.tags || [];
    $('#dz-title').textContent = D.name;
    $('#dz-save').innerHTML = ic('check') + `<span>${map ? 'Update map' : 'Create map'}</span>`;
    $('#dz-brush').value = D.brush;
    setTool('frame');
    setShow('photo', false);
    fitView();
    renderSide();
    await analyze(D.live);
  }

  function close() {
    root.hidden = true;
    D = null; rectCv = inkCv = null;
    Inspector.show();
  }

  async function analyze(replace = D?.live) {
    if (!D) return;
    const tok = (D.tok = (D.tok || 0) + 1);
    setStatus('Reading ink…', true);
    await nextFrame();
    if (!D || tok !== D.tok) return;
    const t0 = performance.now();
    let res;
    try { res = Vision.analyzePx(D.px, D.quad, D.ink); }
    catch (err) { console.error(err); setStatus('Could not read this frame: ' + err.message); return; }
    D.res = res;
    buildCanvases();
    if (replace) {
      const manual = D.lines.filter(l => l.manual), prev = D.lines.filter(l => !l.manual);
      D.lines = [...Vision.linesFrom(res, prev.length ? prev : templateLines()), ...manual];
    } else D.lines.forEach(l => { l.cands = []; });
    setStatus(`${res.clusters.length} ink colour${res.clusters.length === 1 ? '' : 's'} · ${res.cands.length} fragments · ${D.lines.length} line${D.lines.length === 1 ? '' : 's'} · ${Math.round(performance.now() - t0)} ms`);
    renderSide(); draw();
  }
  const reanalyze = debounce(() => analyze(), 280);

  function buildCanvases() {
    const { rect, labels, clusters } = D.res;
    const mk = data => { const c = document.createElement('canvas'); c.width = rect.w; c.height = rect.h; c.getContext('2d').putImageData(new ImageData(data, rect.w, rect.h), 0, 0); return c; };
    rectCv = mk(new Uint8ClampedArray(rect.data));
    const cols = clusters.map(c => hexToRgb(c.hex)), off = new Set(D.ink.disabled), out = new Uint8ClampedArray(rect.w * rect.h * 4);
    for (let i = 0; i < rect.w * rect.h; i++) {
      const l = labels[i], o = i * 4;
      if (l < 0) { out[o] = out[o + 1] = out[o + 2] = 246; out[o + 3] = 255; continue; }
      const c = off.has(l) ? [205, 205, 205] : cols[l];
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
    }
    inkCv = mk(out);
  }

  const templateLines = () => (S.template?.lines || []).map(({ id, ...l }) => l);
  const identities = lines => lines.filter(l => l.pts?.length > 1).map(l => ({ name: l.name, key: l.key || l.name, color: l.color, ink: l.ink || null, inks: l.inks || null }));

  /* ---------- view ---------- */
  function setShow(s, refit = true) {
    if (!D) return;
    if (s !== 'photo' && !D.res) s = 'photo';
    D.show = s;
    $$('#dz-views [data-show]').forEach(b => b.classList.toggle('on', b.dataset.show === s));
    if (refit) fitView(); else draw();
  }
  function setTool(t) {
    if (!D) return;
    D.tool = t;
    $$('#dz-tools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    cv.dataset.tool = t;
    $('#dz-brush-wrap').hidden = t !== 'erase';
    drawSoon();
  }
  const contentSize = () => D.show === 'photo' ? [img.naturalWidth, img.naturalHeight] : [D.res.rect.w, D.res.rect.h];
  function fitView() {
    if (!D) return;
    const W = cv.clientWidth, H = cv.clientHeight, [cw, ch] = contentSize();
    V.z = Math.min((W - 80) / cw, (H - 80) / ch);
    V.x = (W - cw * V.z) / 2; V.y = (H - ch * V.z) / 2;
    draw();
  }
  const toS = (x, y) => [V.x + x * V.z, V.y + y * V.z];
  const fromS = (sx, sy) => [(sx - V.x) / V.z, (sy - V.y) / V.z];
  const quadPx = () => D.quad.map(([x, y]) => [x * img.naturalWidth, y * img.naturalHeight]);
  function local(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  /** screen → (u, v-down) inside the plot frame */
  function toUnit(sx, sy) {
    const [x, y] = fromS(sx, sy);
    if (D.show === 'photo') return hApply(homography(quadPx(), UNIT), x, y);
    return [x / D.res.rect.w, y / D.res.rect.h];
  }

  const drawSoon = rafThrottle(() => draw());
  function draw() {
    if (!D || !img) return;
    const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, W, H);
    const T = Theme.t();
    cx.save(); cx.translate(V.x, V.y); cx.scale(V.z, V.z);
    cx.imageSmoothingQuality = 'high';
    if (D.show === 'photo') cx.drawImage(img, 0, 0);
    else { cx.imageSmoothingEnabled = V.z < 2.5; cx.drawImage(D.show === 'ink' ? inkCv : rectCv, 0, 0); }
    cx.restore();
    cx.imageSmoothingEnabled = true;

    const Hm = D.show === 'photo' ? homography(UNIT, quadPx()) : null;
    const U = (u, vd) => { const [x, y] = Hm ? hApply(Hm, u, vd) : [u * D.res.rect.w, vd * D.res.rect.h]; return toS(x, y); };
    const poly = (pts, close) => { cx.beginPath(); pts.forEach((p, i) => (i ? cx.lineTo(p[0], p[1]) : cx.moveTo(p[0], p[1]))); if (close) cx.closePath(); };
    const corners = [U(0, 0), U(1, 0), U(1, 1), U(0, 1)];

    if (D.show === 'photo') {
      cx.save();
      cx.fillStyle = 'rgba(6,7,10,0.58)';
      cx.beginPath(); cx.rect(0, 0, W, H);
      corners.forEach((p, i) => (i ? cx.lineTo(p[0], p[1]) : cx.moveTo(p[0], p[1]))); cx.closePath();
      cx.fill('evenodd');
      cx.restore();
    }
    // calibration grid
    cx.lineWidth = 1; cx.strokeStyle = rgba(T.accent, 0.22);
    for (let i = 1; i < 10; i++) { poly([U(i / 10, 0), U(i / 10, 1)]); cx.stroke(); poly([U(0, i / 10), U(1, i / 10)]); cx.stroke(); }
    cx.lineWidth = 2; cx.strokeStyle = T.accent; poly(corners, true); cx.stroke();

    // erase marks
    cx.fillStyle = 'rgba(255,79,94,0.28)';
    for (const c of D.ink.erase) {
      const [sx, sy] = U(c.u, c.v), [ex, ey] = U(c.u + c.r, c.v);
      cx.beginPath(); cx.arc(sx, sy, Math.hypot(ex - sx, ey - sy), 0, Math.PI * 2); cx.fill();
    }
    // highlighted fragment
    if (D.res && D.hl) {
      const f = D.res.cands.find(c => c.id === D.hl);
      if (f) { cx.lineWidth = 9; cx.strokeStyle = 'rgba(255,255,255,0.85)'; cx.lineCap = 'round'; poly(f.pts.map(([u, v]) => U(u, 1 - v))); cx.stroke(); }
    }
    // lines
    cx.lineJoin = 'round'; cx.lineCap = 'round';
    for (const ln of D.lines) {
      if (ln.visible === false || !ln.pts?.length) continue;
      const P = ln.pts.map(([u, v]) => U(u, 1 - v));
      cx.lineWidth = 6; cx.strokeStyle = 'rgba(0,0,0,0.55)'; poly(P); cx.stroke();
      cx.lineWidth = 3; cx.strokeStyle = ln.color; poly(P); cx.stroke();
      const e = P[P.length - 1];
      cx.font = '600 12px Space Grotesk, sans-serif'; cx.fillStyle = ln.color;
      cx.strokeStyle = 'rgba(0,0,0,0.7)'; cx.lineWidth = 3; cx.strokeText(ln.name, e[0] + 7, e[1] + 4); cx.fillText(ln.name, e[0] + 7, e[1] + 4);
    }
    // live trace
    if (D.trace) { cx.lineWidth = 3; cx.strokeStyle = T.accent; cx.setLineDash([6, 5]); poly(D.trace.map(([u, v]) => U(u, 1 - v))); cx.stroke(); cx.setLineDash([]); }
    // handles
    if (D.show === 'photo') {
      const labels = [D.axes.yHigh || 'Y max', '', D.axes.xEnd || 'X max', 'Origin'];
      corners.forEach(([x, y], i) => {
        cx.beginPath(); cx.arc(x, y, 8, 0, Math.PI * 2);
        cx.fillStyle = T.card; cx.fill(); cx.lineWidth = 2.5; cx.strokeStyle = T.accent; cx.stroke();
        cx.beginPath(); cx.arc(x, y, 2.5, 0, Math.PI * 2); cx.fillStyle = T.accent; cx.fill();
        if (labels[i]) {
          cx.font = '600 11px Space Grotesk, sans-serif';
          const tw = cx.measureText(labels[i]).width, lx = i === 2 ? x - tw - 14 : x + 13, ly = i === 3 || i === 2 ? y + 22 : y - 12;
          cx.fillStyle = 'rgba(10,11,15,0.82)'; cx.fillRect(lx - 5, ly - 12, tw + 10, 17);
          cx.fillStyle = T.accent; cx.fillText(labels[i], lx, ly);
        }
      });
    }
    // brush cursor
    if (D.cursor && D.tool === 'erase') {
      const [ux, uy] = toUnit(...D.cursor), [sx, sy] = U(ux, uy), [ex, ey] = U(ux + D.brush, uy);
      cx.beginPath(); cx.arc(sx, sy, Math.max(3, Math.hypot(ex - sx, ey - sy)), 0, Math.PI * 2);
      cx.strokeStyle = '#ff4f5e'; cx.lineWidth = 1.5; cx.setLineDash([4, 3]); cx.stroke(); cx.setLineDash([]);
    }
  }

  /* ---------- pointer ---------- */
  function onWheel(e) {
    if (!D) return;
    e.preventDefault();
    const [px, py] = local(e), k = Math.exp(-(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY) * 0.0018), z = clamp(V.z * k, 0.05, 30);
    V.x = px - (px - V.x) * (z / V.z); V.y = py - (py - V.y) * (z / V.z); V.z = z;
    draw();
  }
  function pan(e) {
    const sx = e.clientX, sy = e.clientY, ox = V.x, oy = V.y;
    cv.classList.add('panning');
    track(e, ev => { V.x = ox + ev.clientX - sx; V.y = oy + ev.clientY - sy; draw(); }, () => cv.classList.remove('panning'));
  }
  function onDown(e) {
    if (!D) return;
    e.preventDefault();
    if (e.button === 1 || e.button === 2 || space) return pan(e);
    if (e.button !== 0) return;
    const [sx, sy] = local(e);
    if (D.show === 'photo') {
      const Q = quadPx().map(p => toS(...p));
      const hit = Q.findIndex(([qx, qy]) => Math.hypot(qx - sx, qy - sy) < 15);
      if (hit >= 0) return dragCorner(e, hit);
    }
    if (D.tool === 'erase') return paintErase(e);
    if (D.tool === 'trace') return trace(e);
    if (D.tool === 'pick') return pick(sx, sy);
    if (D.tool === 'frame' && D.show === 'photo') {
      const [u, v] = toUnit(sx, sy);
      if (u > 0 && u < 1 && v > 0 && v < 1) return moveQuad(e);
    }
    pan(e);
  }
  function dragCorner(e, i) {
    const W = img.naturalWidth, H = img.naturalHeight;
    track(e, ev => {
      const [x, y] = fromS(...local(ev)), nx = clamp(x / W, 0, 1), ny = clamp(y / H, 0, 1);
      D.quad[i] = [nx, ny];
      if (D.rectLock) {
        const pair = [[1, 3], [0, 2], [3, 1], [2, 0]][i]; // [shares y, shares x]
        D.quad[pair[0]][1] = ny; D.quad[pair[1]][0] = nx;
      }
      draw();
    }, () => analyze());
  }
  function moveQuad(e) {
    const start = fromS(...local(e)), orig = clone(D.quad), W = img.naturalWidth, H = img.naturalHeight;
    track(e, ev => {
      const [x, y] = fromS(...local(ev)), dx = (x - start[0]) / W, dy = (y - start[1]) / H;
      D.quad = orig.map(([qx, qy]) => [clamp(qx + dx, 0, 1), clamp(qy + dy, 0, 1)]);
      draw();
    }, () => analyze());
  }
  function squareUp() {
    const q = D.quad, l = (q[0][0] + q[3][0]) / 2, r = (q[1][0] + q[2][0]) / 2, t = (q[0][1] + q[1][1]) / 2, b = (q[2][1] + q[3][1]) / 2;
    D.quad = [[l, t], [r, t], [r, b], [l, b]];
    draw(); analyze();
  }
  function paintErase(e) {
    const add = ev => {
      const [u, v] = toUnit(...local(ev));
      if (u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05) return;
      const last = D.ink.erase[D.ink.erase.length - 1];
      if (last && Math.hypot(last.u - u, last.v - v) < D.brush * 0.35) return;
      D.ink.erase.push({ u: round(u), v: round(v), r: D.brush });
      draw();
    };
    add(e);
    track(e, add, () => analyze());
  }
  function trace(e) {
    const pt = ev => { const [u, vd] = toUnit(...local(ev)); return [clamp(u, 0, 1), clamp(1 - vd, 0, 1)]; };
    D.trace = [pt(e)];
    track(e, ev => { D.trace.push(pt(ev)); draw(); }, () => {
      const pts = Vision.polyToLine(D.trace);
      D.trace = null;
      if (pts.length < 3) { draw(); return; }
      const n = D.lines.length + 1;
      D.lines.push({ id: uid('l'), name: `Line ${n}`, key: `Line ${n}`, color: PALETTE[(n - 1) % PALETTE.length], visible: true, pts, adj: { dy: 0, sy: 1, smooth: 0 }, manual: true, cands: [] });
      renderSide(); draw();
      toast('Traced line added. Trace again to add another.', '', 2000);
    });
  }
  function pick(sx, sy) {
    if (!D.res) return;
    const [u, v] = toUnit(sx, sy), { w, h } = D.res.rect, labels = D.res.labels;
    const cx0 = Math.round(u * w), cy0 = Math.round(v * h);
    let found = -1;
    for (let r = 0; r <= 8 && found < 0; r++)
      for (let dy = -r; dy <= r && found < 0; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = cx0 + dx, y = cy0 + dy;
        if (x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] >= 0) { found = labels[y * w + x]; break; }
      }
    if (found < 0) return toast('No ink there — click right on a stroke.');
    toggleCluster(found);
  }
  function toggleCluster(i) {
    const d = D.ink.disabled, k = d.indexOf(i);
    k >= 0 ? d.splice(k, 1) : d.push(i);
    toast(k >= 0 ? 'Colour included again.' : 'Colour ignored.', '', 1400);
    analyze();
  }

  /* ---------- fragments ---------- */
  function reassign(fid, target) {
    const res = D.res, affected = new Set();
    for (const ln of D.lines) if (ln.cands?.includes(fid)) { ln.cands = ln.cands.filter(c => c !== fid); affected.add(ln); }
    if (target === 'new') {
      const n = D.lines.length + 1, f = res.cands.find(c => c.id === fid);
      const ln = { id: uid('l'), name: `Line ${n}`, key: `Line ${n}`, color: vivid(f.color) || PALETTE[(n - 1) % PALETTE.length], ink: f.color, visible: true, pts: [], cands: [fid], adj: { dy: 0, sy: 1, smooth: 0 } };
      D.lines.push(ln); affected.add(ln);
    } else if (target !== 'none') {
      const ln = D.lines.find(l => l.id === target);
      if (ln) { ln.cands = [...(ln.cands || []), fid]; affected.add(ln); }
    }
    for (const ln of affected) {
      const cs = (ln.cands || []).map(id => res.cands.find(c => c.id === id)).filter(Boolean);
      if (cs.length) { ln.pts = Vision.buildLine(cs); ln.manual = false; }
      else if (!ln.manual) ln.pts = [];
    }
    D.lines = D.lines.filter(l => l.pts.length > 1 || l.manual);
    renderSide(); draw();
  }

  /* ---------- side panel ---------- */
  function step(n, title, kids, open = true) {
    return el('details', { class: 'dz-step', open }, el('summary', {}, el('span', { class: 'num' }, n), title), el('div', { class: 'dz-step-b' }, kids));
  }
  function renderSide() {
    if (!D) return;
    const st = side.scrollTop;
    side.innerHTML = '';
    const ink = D.ink, res = D.res;

    side.append(step(1, 'Frame the plot', [
      UI.hint('Drag the four handles onto the axes: top of the Y axis, the origin, the end of the X axis. Perspective is corrected, so tilted phone photos work. Drag inside the frame to move it.'),
      el('div', { class: 'btn-grid' },
        UI.btn('Auto-detect axes', 'wand', () => { D.quad = Vision.detectFrame(D.px); draw(); analyze(); }),
        UI.btn('Whole image', 'fit', () => { D.quad = [[0.03, 0.03], [0.97, 0.03], [0.97, 0.97], [0.03, 0.97]]; draw(); analyze(); })),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: D.rectLock, onchange: e => { D.rectLock = e.target.checked; if (D.rectLock) squareUp(); } }), el('span', {}, 'Keep it a rectangle (flat scans)')),
    ]));

    side.append(step(2, 'Name the axes', [
      ...Inspector.axesForm(D.axes, () => drawSoon(), false),
      UI.btn('Use template axes', 'template', () => { if (S.template?.axes) { D.axes = clone(S.template.axes); renderSide(); draw(); } else toast('No template yet — it is created from the first map you save.'); }, 'ghost'),
    ], false));

    const clusterChips = res ? res.clusters.map((c, i) => el('button', {
      type: 'button', class: 'ink-chip' + (ink.disabled.includes(i) ? ' off' : ''), title: 'Click to ignore / include this ink colour', onclick: () => toggleCluster(i),
    }, el('i', { style: { background: c.hex } }), pct(c.share))) : [];
    side.append(step(3, 'Read the ink', [
      UI.field('Sensitivity (higher = only strong ink)', UI.range(ink.sens, 8, 60, 1, x => { ink.sens = x; ink.disabled = []; reanalyze(); }, x => x)),
      UI.field('Ignore strip along the frame edge', UI.range(ink.guard, 0, 0.08, 0.005, x => { ink.guard = x; reanalyze(); }, pct)),
      UI.field('Minimum line length', UI.range(ink.minSpan ?? 0.2, 0.05, 0.6, 0.01, x => { ink.minSpan = x; reanalyze(); }, pct)),
      UI.field('Number of ink colours', UI.select(ink.k, [['auto', 'Auto'], ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => [String(n), String(n)])], x => { ink.k = x === 'auto' ? 'auto' : +x; ink.disabled = []; analyze(); })),
      clusterChips.length > 0 && el('div', { class: 'field' }, el('span', { class: 'f-l' }, 'Ink colours found — click to ignore'), el('div', { class: 'ink-chips' }, clusterChips)),
      ink.erase.length > 0 && UI.btn(`Clear ${ink.erase.length} erase marks`, 'eraser', () => { ink.erase = []; analyze(); }, 'ghost'),
      UI.hint('Use “Erase noise” to brush away handwriting, numbers or stains, and “Pick colour” to toggle an ink by clicking it. “Ink map” view shows how every pixel was classified.'),
    ], true));

    const lineRow = (ln, i) => {
      let lastName = ln.name;
      return el('div', { class: 'ln' + (ln.visible === false ? ' off' : '') },
        el('div', { class: 'ln-row' },
          el('input', { type: 'color', value: ln.color, oninput: e => { ln.color = e.target.value; drawSoon(); } }),
          el('input', { type: 'text', class: 'ln-name', value: ln.name, oninput: e => { if (ln.key === lastName) ln.key = e.target.value; ln.name = lastName = e.target.value; drawSoon(); } }),
          UI.spark(ln.pts || [], ln.color),
          iconBtn(ln.visible === false ? 'eye-off' : 'eye', 'Show / hide', ln.visible !== false, () => { ln.visible = ln.visible === false; renderSide(); draw(); }),
          iconBtn('trash', 'Delete line', false, () => { D.lines.splice(i, 1); renderSide(); draw(); })),
        el('small', { class: 'ln-meta' }, ln.manual ? 'traced by hand' : `${(ln.cands || []).length} fragment${(ln.cands || []).length === 1 ? '' : 's'}`, ln.pts?.length ? ` · X ${pct(ln.pts[0][0])}–${pct(ln.pts[ln.pts.length - 1][0])}` : ''));
    };
    const frag = res && res.cands.length ? el('details', { class: 'frags' },
      el('summary', {}, `Fragments (${res.cands.length}) — reassign pieces between lines`),
      res.cands.map(f => {
        const owner = D.lines.find(l => l.cands?.includes(f.id));
        const row = el('div', { class: 'frag' },
          el('i', { style: { background: f.color } }),
          el('span', {}, `${pct(f.u0)}–${pct(f.u1)}`),
          el('select', { value: owner?.id || 'none', onchange: e => reassign(f.id, e.target.value) },
            el('option', { value: 'none' }, 'Ignore'), D.lines.map(l => el('option', { value: l.id }, '→ ' + l.name)), el('option', { value: 'new' }, '+ New line')));
        row.addEventListener('mouseenter', () => { D.hl = f.id; draw(); });
        row.addEventListener('mouseleave', () => { D.hl = null; draw(); });
        return row;
      })) : null;
    side.append(step(4, `Lines (${D.lines.length})`, [
      !D.live && el('div', { class: 'notice' }, 'Editing an existing map: frame and ink changes only refresh the fragments, so your edits are safe. ',
        UI.btn('Re-detect lines now', 'wand', () => { D.live = true; analyze(true); }, 'ghost')),
      D.lines.map(lineRow),
      !D.lines.length && UI.hint('No lines found. Lower the sensitivity, check the frame, or trace by hand.'),
      el('div', { class: 'btn-grid' },
        UI.btn('Trace by hand', 'trace', () => setTool('trace'), 'ghost'),
        D.lines.length > 0 && UI.btn('Clear all', 'x', () => { D.lines = []; renderSide(); draw(); }, 'ghost danger'),
        D.lines.length > 0 && UI.btn('Set as template lines', 'template', () => {
          S.template = { ...(S.template || { axes: clone(D.axes), ink: {} }), lines: identities(D.lines) };
          toast('Template line identities saved — future sheets match lines by ink colour.', 'good', 4000);
        }, 'ghost')),
      frag,
      UI.hint('Line names become “compare keys”: lines with the same name are averaged together across maps. New sheets match lines to the template by ink colour.'),
    ]));

    const m = D.meta;
    side.append(step(5, 'Who & when', [
      UI.field('Title', el('input', { type: 'text', value: m.title, oninput: e => { m.title = e.target.value; } })),
      UI.row(UI.field('Participant', el('input', { type: 'text', value: m.participant, placeholder: 'P01', list: 'dz-dl-p', oninput: e => { m.participant = e.target.value; } })),
        UI.field('Test / session', el('input', { type: 'text', value: m.session, placeholder: '1', oninput: e => { m.session = e.target.value; } }))),
      UI.row(UI.field('Condition', el('input', { type: 'text', value: m.condition, placeholder: 'e.g. blindfold', oninput: e => { m.condition = e.target.value; } })),
        UI.field('Date', el('input', { type: 'date', value: m.date, oninput: e => { m.date = e.target.value; } }))),
      UI.field('Tags', UI.tags(m.tags, t => { m.tags = t; })),
      el('datalist', { id: 'dz-dl-p' }, [...new Set(itemsOf('map').map(x => x.meta.participant).filter(Boolean))].map(v => el('option', { value: v }))),
    ]));
    side.scrollTop = st;
  }

  function save() {
    if (!D) return;
    const lines = D.lines.filter(l => l.pts?.length > 1).map(l => ({
      id: l.id, name: l.name, key: l.key || l.name, color: l.color, ink: l.ink, inks: l.inks, visible: l.visible !== false,
      pts: l.pts, adj: l.adj || { dy: 0, sy: 1, smooth: 0 }, manual: !!l.manual,
    }));
    const ink = { sens: D.ink.sens, guard: D.ink.guard, k: D.ink.k, minSpan: D.ink.minSpan, erase: D.ink.erase, disabled: D.ink.disabled };
    let map = D.mapId && getItem(D.mapId);
    if (map) {
      Object.assign(map, { quad: D.quad, axes: D.axes, meta: D.meta, lines, ink, auto: false });
      Board.refresh(map.id);
    } else {
      map = App.createMap({ asset: D.assetId, source: D.scanId, quad: D.quad, axes: D.axes, meta: D.meta, lines, ink }, D.scanId && getItem(D.scanId));
    }
    const id = map.id;
    if (!S.template) {
      S.template = { axes: clone(D.axes), ink: { sens: D.ink.sens, guard: D.ink.guard, k: D.ink.k, minSpan: D.ink.minSpan }, lines: identities(D.lines) };
      const blank = JSON.stringify(defaultAxes());
      const others = itemsOf('map').filter(m => m.id !== id && JSON.stringify(m.axes) === blank);
      others.forEach(m => { m.axes = clone(D.axes); Board.refresh(m.id); });
      toast(`These axes are now the template for future imports${others.length ? ` — also applied to ${others.length} other map${others.length > 1 ? 's' : ''}` : ''}.`, 'good', 5000);
    }
    commit(); close();
    Board.select([id]);
    Library.render();
  }

  return { init, open, close, get active() { return !!D; } };
})();
