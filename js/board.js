'use strict';
/* =====================================================================
   Tracefield · board
   infinite pin-board: pan (middle mouse / space / hand), zoom, drag,
   resize, marquee, pen + highlighter, string links, minimap, menus
   ===================================================================== */

const Menu = {
  node: null,
  show(x, y, items) {
    const n = this.node || (this.node = $('#menu'));
    n.innerHTML = '';
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { n.append(el('div', { class: 'm-sep' })); continue; }
      if (it.custom) { n.append(it.custom); continue; }
      if (it.header) { n.append(el('div', { class: 'm-head' }, it.header)); continue; }
      n.append(el('button', {
        class: 'm-item' + (it.danger ? ' danger' : ''), disabled: it.disabled,
        onclick: () => { this.hide(); it.action(); },
      }, el('span', { class: 'm-ic', html: it.icon ? ic(it.icon) : '' }), el('span', { class: 'm-l' }, it.label), it.kbd && el('kbd', {}, it.kbd)));
    }
    n.hidden = false;
    const r = n.getBoundingClientRect();
    n.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    n.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  },
  hide() { if (this.node) this.node.hidden = true; },
};
window.addEventListener('pointerdown', e => { if (!e.target.closest('#menu')) Menu.hide(); }, true);

const Welcome = {
  update() { const w = $('#welcome'); if (w) w.hidden = S.items.length > 0; },
};

const Minimap = (() => {
  let cv, cx, map = null;
  function init() {
    cv = $('#minimap canvas'); cx = cv.getContext('2d');
    const nav = e => {
      if (!map) return;
      const r = cv.getBoundingClientRect(), B = $('#board');
      const wx = map.x + (e.clientX - r.left) / map.s, wy = map.y + (e.clientY - r.top) / map.s;
      S.view.x = B.clientWidth / 2 - wx * S.view.z; S.view.y = B.clientHeight / 2 - wy * S.view.z;
      Board.applyView(); saveSoon();
    };
    cv.addEventListener('pointerdown', e => { e.preventDefault(); nav(e); track(e, nav); });
  }
  const draw = rafThrottle(() => {
    if (!cv) return;
    const B = $('#board'), W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, W, H);
    const v = S.view, vx = -v.x / v.z, vy = -v.y / v.z, vw = B.clientWidth / v.z, vh = B.clientHeight / v.z;
    let x0 = vx, y0 = vy, x1 = vx + vw, y1 = vy + vh;
    for (const it of S.items) { x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); x1 = Math.max(x1, it.x + it.w); y1 = Math.max(y1, it.y + it.h); }
    const pad = 40; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const s = Math.min(W / (x1 - x0), H / (y1 - y0));
    const ox = x0 - (W / s - (x1 - x0)) / 2, oy = y0 - (H / s - (y1 - y0)) / 2;
    map = { x: ox, y: oy, s };
    const T = Theme.t();
    const sel = new Set(Board.selection());
    for (const it of [...S.items].sort((a, b) => a.z - b.z)) {
      cx.fillStyle = it.type === 'note' ? (it.color || NOTE_COLORS[0]) : it.type === 'scan' ? '#e9e4d8' : it.type === 'lens' ? rgba(T.accent, 0.5) : it.type === 'map' ? rgba(it.color || T.accent, 0.55) : T.muted;
      cx.fillRect((it.x - ox) * s, (it.y - oy) * s, Math.max(2, it.w * s), Math.max(2, it.h * s));
      if (sel.has(it.id)) { cx.strokeStyle = T.accent; cx.lineWidth = 1.5; cx.strokeRect((it.x - ox) * s, (it.y - oy) * s, it.w * s, it.h * s); }
    }
    cx.strokeStyle = T.text; cx.globalAlpha = 0.8; cx.lineWidth = 1.2;
    cx.strokeRect((vx - ox) * s, (vy - oy) * s, vw * s, vh * s);
    cx.globalAlpha = 1;
  });
  return { init, draw };
})();

const Board = (() => {
  let B, cardsEl, gStrokes, gLinks, gTemp, marq;
  const nodes = new Map(), sel = new Set();
  let tool = 'select', space = false, edit = null, selLink = null;
  const pen = { color: PEN_COLORS[0], w: 3, hi: false };

  function init() {
    B = $('#board'); cardsEl = $('#cards'); marq = $('#marquee');
    gLinks = sv('g', { class: 'links' }); gStrokes = sv('g', { class: 'strokes' }); gTemp = sv('g', { class: 'temp' });
    $('#links').append(gLinks);
    $('#ink').append(gStrokes, gTemp);
    B.addEventListener('pointerdown', onDown);
    B.addEventListener('wheel', onWheel, { passive: false });
    B.addEventListener('dblclick', onDbl);
    B.addEventListener('contextmenu', onCtx);
    B.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    B.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', e => { if (e.key === ' ') { space = false; B.classList.remove('space'); } });
    window.addEventListener('blur', () => { space = false; B.classList.remove('space'); });
    window.addEventListener('resize', () => { applyView(); });
    Minimap.init();
  }

  /* ---------- view ---------- */
  function applyView() {
    const v = S.view;
    $('#world').style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    const g = 24 * v.z;
    B.style.backgroundSize = `${g}px ${g}px`;
    B.style.backgroundPosition = `${v.x}px ${v.y}px`;
    B.style.setProperty('--iz', 1 / v.z);
    const zl = $('#zoom-label'); if (zl) zl.textContent = Math.round(v.z * 100) + '%';
    Minimap.draw();
  }
  function toWorld(cx, cy) { const r = B.getBoundingClientRect(), v = S.view; return [(cx - r.left - v.x) / v.z, (cy - r.top - v.y) / v.z]; }
  function centerWorld() { const r = B.getBoundingClientRect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); }
  function zoomAt(cx, cy, k) {
    const r = B.getBoundingClientRect(), v = S.view, z = clamp(v.z * k, 0.06, 5);
    const px = cx - r.left, py = cy - r.top;
    v.x = px - (px - v.x) * (z / v.z); v.y = py - (py - v.y) * (z / v.z); v.z = z;
    applyView(); saveSoon();
  }
  function zoomBy(k) { const r = B.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, k); }
  function animateTo(target, ms = 450) {
    const from = { ...S.view }, t0 = performance.now();
    const step = now => {
      const t = Math.min(1, (now - t0) / ms), e = 1 - (1 - t) ** 3;
      S.view.x = lerp(from.x, target.x, e); S.view.y = lerp(from.y, target.y, e); S.view.z = lerp(from.z, target.z, e);
      applyView();
      if (t < 1) requestAnimationFrame(step); else saveSoon();
    };
    requestAnimationFrame(step);
  }
  function safeArea() {
    const r = B.getBoundingClientRect();
    const libOpen = !$('#library').classList.contains('collapsed'), insOpen = !$('#inspector').classList.contains('collapsed');
    return { l: libOpen ? 290 : 30, r: insOpen ? 360 : 30, t: 80, b: 40, w: r.width, h: r.height };
  }
  function fit(ids) {
    const list = ids && ids.length ? ids.map(getItem).filter(Boolean) : S.items;
    const a = safeArea();
    if (!list.length) return animateTo({ x: a.w / 2, y: a.h / 2, z: 1 });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of list) { x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); x1 = Math.max(x1, it.x + it.w); y1 = Math.max(y1, it.y + it.h); }
    const aw = a.w - a.l - a.r, ah = a.h - a.t - a.b;
    const z = clamp(Math.min(aw / (x1 - x0), ah / (y1 - y0)), 0.08, 1.4);
    animateTo({ x: a.l + (aw - (x1 - x0) * z) / 2 - x0 * z, y: a.t + (ah - (y1 - y0) * z) / 2 - y0 * z, z });
  }
  function zoomTo100() { const a = safeArea(), [cx, cy] = centerWorld(); animateTo({ x: a.w / 2 - cx, y: a.h / 2 - cy, z: 1 }); }

  /* ---------- items ---------- */
  function build(it) {
    const n = el('div', { class: `card card-${it.type}`, dataset: { id: it.id } });
    nodes.set(it.id, n);
    cardsEl.append(n);
    place(it); fill(it);
    return n;
  }
  function place(it) {
    const n = nodes.get(it.id);
    if (!n) return;
    n.style.left = it.x + 'px'; n.style.top = it.y + 'px'; n.style.width = it.w + 'px'; n.style.height = it.h + 'px';
    n.style.zIndex = it.z;
    n.classList.toggle('selected', sel.has(it.id));
    n.classList.toggle('locked', !!it.locked);
  }
  function fill(it) { const n = nodes.get(it.id); if (n) Cards[it.type]?.render(n, it); }
  function refresh(id, deep = true) {
    const it = getItem(id);
    if (!it) return;
    place(it); fill(it);
    if (deep && it.type === 'map') for (const l of itemsOf('lens')) if (l.maps.includes(id)) fill(l);
    drawLinks(); Minimap.draw();
  }
  const pending = new Set();
  let queued = false;
  function refreshSoon(id) {
    pending.add(id);
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; const ids = [...pending]; pending.clear(); ids.forEach(i => refresh(i)); });
  }
  function redrawPlot(id) { const it = getItem(id), n = nodes.get(id); if (it && n) Cards[it.type]?.plot?.(n, it); }
  function rebuildAll() {
    cardsEl.innerHTML = ''; nodes.clear();
    for (const id of [...sel]) if (!getItem(id)) sel.delete(id);
    if (edit && !getItem(edit.id)) edit = null;
    S.items.forEach(build);
    drawInk(); applyView(); Welcome.update(); Inspector.show();
  }
  function add(it) {
    it.id = it.id || uid(it.type[0]);
    it.z = ++S.z;
    S.items.push(it);
    build(it);
    Welcome.update(); Minimap.draw();
    return it;
  }
  function remove(ids) {
    const set = new Set(ids);
    if (!set.size) return;
    if (Player.cur && set.has(Player.cur.id)) Player.stop();
    if (edit && set.has(edit.id)) edit = null;
    S.items = S.items.filter(i => !set.has(i.id));
    S.links = S.links.filter(l => !set.has(l.a) && !set.has(l.b));
    for (const id of set) { nodes.get(id)?.remove(); nodes.delete(id); sel.delete(id); }
    for (const l of itemsOf('lens')) { const n = l.maps.length; l.maps = l.maps.filter(m => !set.has(m)); if (n !== l.maps.length) fill(l); }
    drawInk(); syncSel(); commit(); Welcome.update();
  }
  function duplicate(ids) {
    const out = [];
    for (const id of ids) {
      const it = getItem(id);
      if (!it) continue;
      const c = clone(it);
      c.id = uid(c.type[0]); c.x += 36; c.y += 36;
      if (c.type === 'map') { c.meta.title = (c.meta.title || 'Map') + ' copy'; c.lines.forEach(l => { l.id = uid('l'); }); }
      if (c.type === 'lens') c.title = (c.title || 'Lens') + ' copy';
      add(c); out.push(c.id);
    }
    if (out.length) { select(out); commit(); }
  }
  function zOrder(ids, front) {
    const list = ids.map(getItem).filter(Boolean);
    if (front) list.forEach(i => { i.z = ++S.z; place(i); });
    else { const mn = Math.min(...S.items.map(i => i.z)); list.forEach((i, k) => { i.z = mn - list.length + k; place(i); }); }
    commit();
  }
  function addToLens(lens, ids) {
    if (!lens) return;
    let added = 0;
    for (const id of ids) if (!lens.maps.includes(id) && getItem(id)?.type === 'map') { lens.maps.push(id); added++; }
    fill(lens);
    const n = nodes.get(lens.id);
    if (n) { n.classList.remove('pulse'); void n.offsetWidth; n.classList.add('pulse'); }
    toast(added ? `Added ${added} map${added > 1 ? 's' : ''} to “${lens.title || 'Lens'}”` : 'Already in this lens');
    commit(); Inspector.show();
  }
  function animateItem(it, x, y) {
    const n = nodes.get(it.id);
    n?.classList.add('glide');
    it.x = x; it.y = y; place(it);
    setTimeout(() => { n?.classList.remove('glide'); drawLinks(); }, 420);
  }

  /* ---------- selection / modes ---------- */
  function select(ids, addTo = false) { if (!addTo) sel.clear(); for (const i of ids) sel.add(i); selLink = null; syncSel(); }
  function syncSel() {
    for (const [id, n] of nodes) n.classList.toggle('selected', sel.has(id));
    drawLinks(); Inspector.show(); Minimap.draw();
  }
  function setTool(t) {
    tool = t;
    B.dataset.tool = t;
    $$('#tools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    $('#pen-opts').hidden = !(t === 'pen' || t === 'connect');
  }
  function setEdit(e) {
    const prev = edit;
    edit = e;
    if (prev && getItem(prev.id)) refresh(prev.id, false);
    if (e) { refresh(e.id, false); toast('Editing lines — drag on the plot. Esc or “Done” to finish.', '', 2400); }
    else if (prev) refresh(prev.id);
  }

  /* ---------- input ---------- */
  function onWheel(e) {
    if (e.target.closest('.modal')) return;
    const sc = e.target.closest('.scroll');
    if (sc && sc.scrollHeight > sc.clientHeight + 2 && !e.ctrlKey) return;
    e.preventDefault();
    if (e.shiftKey && !e.ctrlKey) { S.view.x -= e.deltaY || e.deltaX; applyView(); saveSoon(); return; }
    const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    zoomAt(e.clientX, e.clientY, Math.exp(-d * (e.ctrlKey ? 0.006 : 0.0016)));
  }

  function onDown(e) {
    Tip.hide();
    if (e.button === 1) { e.preventDefault(); return startPan(e); }
    if (e.button !== 0) return;
    const t = e.target;
    const card = t.closest('.card');
    if (t.closest('input,textarea,select,button,label,[contenteditable="true"],.no-drag,.scroll')) {
      if (card && !sel.has(card.dataset.id) && !t.closest('.editing')) { sel.clear(); sel.add(card.dataset.id); syncSel(); }
      return;
    }
    if (t.closest('.link-hit')) return;
    if (space || tool === 'hand') return startPan(e);
    if (tool === 'pen') return startStroke(e);
    if (tool === 'eraser') return startErase(e);
    if (tool === 'note' || tool === 'text') {
      const [x, y] = toWorld(e.clientX, e.clientY);
      const it = tool === 'note' ? newNote(x - 110, y - 20) : newText(x, y - 30);
      setTool('select'); select([it.id]); commit();
      setTimeout(() => Cards.note.edit(nodes.get(it.id)), 30);
      return;
    }
    if (tool === 'connect') { if (card) startConnect(e, card.dataset.id); else startPan(e); return; }
    if (t.closest('.resize') && card) return startResize(e, card.dataset.id);
    if (card) return startDrag(e, card.dataset.id);
    startMarquee(e);
  }

  function startPan(e) {
    const sx = e.clientX, sy = e.clientY, vx = S.view.x, vy = S.view.y;
    B.classList.add('panning');
    track(e, ev => { S.view.x = vx + ev.clientX - sx; S.view.y = vy + ev.clientY - sy; applyView(); },
      () => { B.classList.remove('panning'); saveSoon(); });
  }

  function lensAt(x, y, exclude) {
    let best = null;
    for (const it of S.items) if (it.type === 'lens' && !exclude.has(it.id) && x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h && (!best || it.z > best.z)) best = it;
    return best;
  }

  function startDrag(e, id) {
    const it = getItem(id);
    if (e.shiftKey) {
      if (sel.has(id)) { sel.delete(id); syncSel(); return; }
      sel.add(id); syncSel();
    } else if (!sel.has(id)) { sel.clear(); sel.add(id); syncSel(); }
    const [sx, sy] = toWorld(e.clientX, e.clientY);
    const moving = [...sel].map(getItem).filter(i => i && !i.locked);
    const orig = moving.map(i => [i, i.x, i.y]);
    moving.forEach(i => { i.z = ++S.z; place(i); });
    const hasMaps = moving.some(i => i.type === 'map');
    let moved = false, drop = null;
    track(e, ev => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      moved = true;
      B.classList.add('dragging-cards');
      const [wx, wy] = toWorld(ev.clientX, ev.clientY), dx = wx - sx, dy = wy - sy;
      for (const [i, ox, oy] of orig) {
        i.x = ox + dx; i.y = oy + dy;
        if (S.settings.snap) { i.x = Math.round(i.x / 24) * 24; i.y = Math.round(i.y / 24) * 24; }
        place(i);
      }
      drawLinks();
      if (hasMaps) {
        const l = lensAt(wx, wy, sel);
        if (l !== drop) { if (drop) nodes.get(drop.id)?.classList.remove('drop-target'); drop = l; if (l) nodes.get(l.id)?.classList.add('drop-target'); }
      }
      Minimap.draw();
    }, () => {
      B.classList.remove('dragging-cards');
      if (!moved) { Cards[it.type]?.click?.(e, it); return; }
      if (drop) {
        nodes.get(drop.id)?.classList.remove('drop-target');
        const ids = moving.filter(i => i.type === 'map').map(i => i.id);
        for (const [i, ox, oy] of orig) if (i.type === 'map') animateItem(i, ox, oy);
        addToLens(drop, ids);
      } else commit();
    });
  }

  function startResize(e, id) {
    const it = getItem(id);
    if (!it || it.locked) return;
    const [sx, sy] = toWorld(e.clientX, e.clientY), ow = it.w, oh = it.h, ratio = ow / oh;
    const min = { map: [340, 250], lens: [520, 340], scan: [80, 60], note: [120, 90], text: [80, 40] }[it.type] || [80, 60];
    track(e, ev => {
      const [wx, wy] = toWorld(ev.clientX, ev.clientY);
      let w = Math.max(min[0], ow + wx - sx), h = Math.max(min[1], oh + wy - sy);
      if (it.type === 'scan' && !ev.shiftKey) h = w / ratio;
      it.w = Math.round(w); it.h = Math.round(h);
      place(it);
      if (it.type === 'map' || it.type === 'lens') refreshSoon(id);
      drawLinks();
    }, () => { refresh(id); commit(); });
  }

  function startMarquee(e) {
    const r = B.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
    const base = e.shiftKey ? new Set(sel) : new Set();
    if (!e.shiftKey && (sel.size || selLink)) { sel.clear(); selLink = null; syncSel(); }
    if (edit) setEdit(null);
    track(e, ev => {
      const x = Math.min(sx, ev.clientX), y = Math.min(sy, ev.clientY), w = Math.abs(ev.clientX - sx), h = Math.abs(ev.clientY - sy);
      if (w + h < 4) return;
      marq.style.cssText = `display:block;left:${x - r.left}px;top:${y - r.top}px;width:${w}px;height:${h}px`;
      const [ax, ay] = toWorld(x, y), [bx, by] = toWorld(x + w, y + h);
      sel.clear(); base.forEach(i => sel.add(i));
      for (const it of S.items) if (it.x < bx && it.x + it.w > ax && it.y < by && it.y + it.h > ay) sel.add(it.id);
      for (const [id, n] of nodes) n.classList.toggle('selected', sel.has(id));
    }, () => { if (marq.style.display === 'block') { marq.style.display = 'none'; syncSel(); } });
  }

  /* ---------- pen / eraser ---------- */
  function strokeD(p) {
    if (p.length < 3) return 'M' + p.map(q => q[0] + ' ' + q[1]).join('L');
    let d = `M${p[0][0]} ${p[0][1]}`;
    for (let i = 1; i < p.length - 1; i++) d += `Q${p[i][0]} ${p[i][1]} ${(p[i][0] + p[i + 1][0]) / 2} ${(p[i][1] + p[i + 1][1]) / 2}`;
    const l = p[p.length - 1];
    return d + `L${l[0]} ${l[1]}`;
  }
  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    let idx = 0, md = 0;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / L;
      if (d > md) { md = d; idx = i; }
    }
    if (md <= eps) return [a, b];
    return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
  }
  function startStroke(e) {
    const st = { id: uid('s'), color: pen.color, w: pen.hi ? pen.w * 5 : pen.w, op: pen.hi ? 0.38 : 1, pts: [toWorld(e.clientX, e.clientY)] };
    const path = sv('path', { stroke: st.color, 'stroke-width': st.w, opacity: st.op, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    gTemp.append(path);
    track(e, ev => {
      const p = toWorld(ev.clientX, ev.clientY), l = st.pts[st.pts.length - 1];
      if (Math.hypot(p[0] - l[0], p[1] - l[1]) < 1.5 / S.view.z) return;
      st.pts.push(p);
      path.setAttribute('d', strokeD(st.pts));
    }, () => {
      path.remove();
      if (st.pts.length < 2) return;
      st.pts = rdp(st.pts, 0.5 / S.view.z).map(p => [round(p[0], 1), round(p[1], 1)]);
      S.strokes.push(st); drawInk(); commit();
    });
  }
  function segDist(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? clamp(((px - a[0]) * dx + (py - a[1]) * dy) / L, 0, 1) : 0;
    return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
  }
  function startErase(e) {
    let changed = false;
    const hit = ev => {
      const [x, y] = toWorld(ev.clientX, ev.clientY), r = 9 / S.view.z;
      const n = S.strokes.length;
      S.strokes = S.strokes.filter(s => !s.pts.some((p, i) => i < s.pts.length - 1 ? segDist(x, y, p, s.pts[i + 1]) < r + s.w / 2 : Math.hypot(x - p[0], y - p[1]) < r + s.w / 2));
      if (S.strokes.length !== n) { changed = true; drawInk(); }
    };
    hit(e);
    track(e, hit, () => { if (changed) commit(); });
  }

  /* ---------- string links ---------- */
  const pinOf = it => [it.x + it.w / 2, it.y + 4];
  function startConnect(e, from) {
    const a = getItem(from);
    const path = sv('path', { class: 'link', stroke: pen.color, fill: 'none' });
    gTemp.append(path);
    track(e, ev => {
      const [x1, y1] = pinOf(a), [x2, y2] = toWorld(ev.clientX, ev.clientY);
      path.setAttribute('d', linkD(x1, y1, x2, y2));
    }, ev => {
      path.remove();
      const c = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.card');
      const to = c?.dataset.id;
      if (!to || to === from) return;
      if (S.links.some(l => (l.a === from && l.b === to) || (l.a === to && l.b === from))) return toast('Already connected');
      S.links.push({ id: uid('k'), a: from, b: to, color: pen.color, label: '' });
      drawLinks(); commit();
    });
  }
  function linkD(x1, y1, x2, y2) {
    const d = Math.hypot(x2 - x1, y2 - y1), sag = Math.min(180, d * 0.16 + 18);
    return `M${x1} ${y1}Q${(x1 + x2) / 2} ${(y1 + y2) / 2 + sag} ${x2} ${y2}`;
  }
  function drawLinks() {
    if (!gLinks) return;
    gLinks.innerHTML = '';
    for (const l of S.links) {
      const a = getItem(l.a), b = getItem(l.b);
      if (!a || !b) continue;
      const [x1, y1] = pinOf(a), [x2, y2] = pinOf(b);
      const d = linkD(x1, y1, x2, y2), on = selLink === l.id;
      gLinks.append(sv('path', { d, class: 'link-shadow' }));
      gLinks.append(sv('path', { d, class: 'link' + (on ? ' on' : ''), stroke: l.color }));
      const hit = sv('path', { d, class: 'link-hit' });
      hit.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.stopPropagation(); selLink = l.id; sel.clear(); syncSel(); });
      hit.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); selLink = l.id; drawLinks(); linkMenu(e, l); });
      hit.addEventListener('dblclick', e => { e.stopPropagation(); linkMenu(e, l); });
      gLinks.append(hit);
      if (l.label) {
        const d2 = Math.hypot(x2 - x1, y2 - y1), sag = Math.min(180, d2 * 0.16 + 18);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 + sag / 2;
        gLinks.append(sv('text', { x: mx, y: my + 18, class: 'link-label', 'text-anchor': 'middle', text: l.label }));
      }
    }
  }
  function linkMenu(e, l) {
    const input = el('input', { class: 'm-input', placeholder: 'Label this string…', value: l.label || '', onkeydown: ev => { ev.stopPropagation(); if (ev.key === 'Enter') { l.label = input.value; drawLinks(); commit(); Menu.hide(); } } });
    Menu.show(e.clientX, e.clientY, [
      { header: 'String' },
      { custom: input },
      { custom: el('div', { class: 'm-swatches' }, PEN_COLORS.map(c => el('button', { style: { background: c }, class: l.color === c ? 'on' : '', onclick: () => { l.color = c; drawLinks(); commit(); Menu.hide(); } }))) },
      '-',
      { label: 'Delete string', icon: 'trash', danger: true, action: () => { S.links = S.links.filter(x => x !== l); selLink = null; drawLinks(); commit(); } },
    ]);
    setTimeout(() => input.focus(), 20);
  }
  function drawInk() {
    if (!gStrokes) return;
    gStrokes.innerHTML = '';
    for (const s of S.strokes) gStrokes.append(sv('path', { d: strokeD(s.pts), stroke: s.color, 'stroke-width': s.w, opacity: s.op ?? 1, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    drawLinks();
  }

  /* ---------- creation helpers ---------- */
  function newNote(x, y, text = '') {
    return add({ type: 'note', x, y, w: 220, h: 180, text, color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)], rot: round(Math.random() * 4 - 2, 1), fs: 24 });
  }
  function newText(x, y, text = '') { return add({ type: 'text', x, y, w: 380, h: 70, text, fs: 40 }); }

  /* ---------- dbl-click / context menu ---------- */
  function onDbl(e) {
    if (e.target.closest('input,textarea,select,button,[contenteditable="true"],.no-drag')) return;
    const card = e.target.closest('.card');
    if (card) { const it = getItem(card.dataset.id); Cards[it.type]?.dbl?.(e, it, card); return; }
    if (tool !== 'select') return;
    const [x, y] = toWorld(e.clientX, e.clientY);
    const it = newNote(x - 110, y - 30);
    select([it.id]); commit();
    setTimeout(() => Cards.note.edit(nodes.get(it.id)), 30);
  }

  function onCtx(e) {
    if (e.target.closest('input,textarea,[contenteditable="true"]')) return;
    e.preventDefault();
    const card = e.target.closest('.card');
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    if (!card) {
      return Menu.show(e.clientX, e.clientY, [
        { label: 'Import scans here…', icon: 'upload', kbd: 'I', action: () => App.pickFiles([wx, wy]) },
        { label: 'New lens here', icon: 'lens', kbd: 'L', action: () => App.newLens([wx, wy]) },
        { label: 'Sticky note', icon: 'note', kbd: 'N', action: () => { const n = newNote(wx, wy); select([n.id]); commit(); setTimeout(() => Cards.note.edit(nodes.get(n.id)), 30); } },
        { label: 'Text label', icon: 'text', kbd: 'T', action: () => { const n = newText(wx, wy); select([n.id]); commit(); setTimeout(() => Cards.note.edit(nodes.get(n.id)), 30); } },
        '-',
        { label: 'Fit everything', icon: 'fit', kbd: 'F', action: () => fit() },
        { label: 'Select all', icon: 'select', kbd: 'Ctrl A', action: () => select(S.items.map(i => i.id)) },
        { label: 'Clear pen marks', icon: 'eraser', disabled: !S.strokes.length, action: () => { S.strokes = []; drawInk(); commit(); } },
      ]);
    }
    const id = card.dataset.id, it = getItem(id);
    if (!sel.has(id)) select([id]);
    const ids = [...sel], maps = ids.map(getItem).filter(i => i?.type === 'map');
    const lenses = itemsOf('lens');
    const common = [
      '-',
      { label: 'Duplicate', icon: 'copy', kbd: 'Ctrl D', action: () => duplicate(ids) },
      { label: 'Bring to front', icon: 'layers', kbd: ']', action: () => zOrder(ids, true) },
      { label: 'Send to back', icon: 'layers', kbd: '[', action: () => zOrder(ids, false) },
      { label: it.locked ? 'Unlock' : 'Lock position', icon: 'lock', action: () => { ids.forEach(i => { const x = getItem(i); x.locked = !it.locked; place(x); }); commit(); } },
      { label: 'Zoom to', icon: 'fit', kbd: 'F', action: () => fit(ids) },
      '-',
      { label: ids.length > 1 ? `Delete ${ids.length} items` : 'Delete', icon: 'trash', kbd: 'Del', danger: true, action: () => remove(ids) },
    ];
    let items = [];
    if (it.type === 'map') {
      items = [
        { header: maps.length > 1 ? `${maps.length} maps` : (it.meta.title || 'Map') },
        { label: 'Compare in a new lens', icon: 'lens', kbd: 'G', action: () => App.compare(ids) },
        ...lenses.map(l => ({ label: `Add to “${l.title || 'Lens'}”`, icon: 'plus', action: () => addToLens(l, maps.map(m => m.id)) })),
        { label: 'Edit lines', icon: 'sculpt', action: () => setEdit({ id, mode: 'sculpt', r: 0.09 }) },
        it.asset && { label: 'Re-digitize from scan', icon: 'wand', action: () => Digitizer.open({ mapId: id }) },
        { label: 'Export CSV', icon: 'download', action: () => App.exportCSV(maps) },
      ];
    } else if (it.type === 'scan') {
      const scans = ids.map(getItem).filter(i => i?.type === 'scan');
      items = [
        { header: it.name || 'Scan' },
        { label: 'Digitize…', icon: 'wand', action: () => Digitizer.open({ scanId: id }) },
        scans.length > 1 && { label: `Stack ${scans.length} scans to compare`, icon: 'layers', action: () => App.stackScans(scans) },
        { label: 'Reset to original aspect', icon: 'fit', action: () => { const a = ASSETS.get(it.asset); if (a) { it.h = Math.round(it.w * a.h / a.w); refresh(id); commit(); } } },
      ];
    } else if (it.type === 'lens') {
      items = [
        { header: it.title || 'Lens' },
        { label: 'Add all maps', icon: 'plus', action: () => addToLens(it, itemsOf('map').map(m => m.id)) },
        { label: 'Export PNG', icon: 'download', action: () => App.exportPNG(id) },
        { label: 'Export SVG', icon: 'download', action: () => App.exportSVG(id) },
        { label: 'Export CSV (incl. averages)', icon: 'download', action: () => App.exportLensCSV(it) },
      ];
    } else if (it.type === 'note') {
      items = [{ header: 'Note' }, { custom: el('div', { class: 'm-swatches' }, NOTE_COLORS.map(c => el('button', { style: { background: c }, onclick: () => { ids.forEach(i => { const x = getItem(i); if (x.type === 'note') { x.color = c; fill(x); } }); commit(); Menu.hide(); } }))) }];
    }
    Menu.show(e.clientX, e.clientY, [...items, ...common]);
  }

  /* ---------- keyboard ---------- */
  function onKey(e) {
    const typing = e.target.closest?.('input,textarea,select,[contenteditable="true"]');
    if (!$('#digitizer').hidden || !$('#help').hidden || !$('#template').hidden) return;
    if (e.key === ' ' && !typing) { if (!space) { space = true; B.classList.add('space'); } e.preventDefault(); return; }
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? Hist.redo() : Hist.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); Hist.redo(); return; }
    if (mod && k === 'd') { e.preventDefault(); duplicate([...sel]); return; }
    if (mod && k === 'a') { e.preventDefault(); select(S.items.map(i => i.id)); return; }
    if (mod && k === 's') { e.preventDefault(); App.exportProject(); return; }
    if (mod || e.altKey) return;
    const act = {
      v: () => setTool('select'), h: () => setTool('hand'), p: () => setTool('pen'), e: () => setTool('eraser'),
      n: () => setTool('note'), t: () => setTool('text'), c: () => setTool('connect'),
      l: () => App.newLens(), g: () => App.compare([...sel]), f: () => fit([...sel]), i: () => App.pickFiles(),
      0: () => zoomTo100(), '=': () => zoomBy(1.2), '+': () => zoomBy(1.2), '-': () => zoomBy(1 / 1.2),
      ']': () => zOrder([...sel], true), '[': () => zOrder([...sel], false), '?': () => Help.open(),
      delete: () => { if (selLink) { S.links = S.links.filter(l => l.id !== selLink); selLink = null; drawLinks(); commit(); } else remove([...sel]); },
      escape: () => { if (edit) setEdit(null); else if (Player.cur) { const id = Player.cur.id; Player.stop(); refresh(id, false); } else { sel.clear(); selLink = null; syncSel(); Menu.hide(); setTool('select'); } },
    };
    act.backspace = act.delete;
    const f = act[k];
    if (f) { e.preventDefault(); f(); return; }
    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k];
    if (arrows && sel.size) {
      e.preventDefault();
      const step = e.shiftKey ? 24 : 4;
      for (const id of sel) { const it = getItem(id); if (it.locked) continue; it.x += arrows[0] * step; it.y += arrows[1] * step; place(it); }
      drawLinks(); commitSoon();
    }
  }
  const commitSoon = debounce(commit, 400);

  /** Dim cards that don't match (library tag filter). null = clear. */
  function highlight(ids) {
    for (const [id, n] of nodes) n.classList.toggle('dim', !!ids && !ids.has(id));
  }

  return {
    init, applyView, toWorld, centerWorld, zoomBy, zoomTo100, fit, animateTo,
    build, place, fill, refresh, refreshSoon, redrawPlot, rebuildAll, add, remove, duplicate, addToLens,
    select, syncSel, setTool, setEdit, drawInk, drawLinks, highlight, newNote, newText,
    node: id => nodes.get(id), selection: () => [...sel],
    get edit() { return edit; }, get tool() { return tool; }, pen,
  };
})();
