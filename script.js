'use strict';
/* =====================================================================
   Tracefield · app
   boot, import (images / PDFs / paste / drop), auto-digitize,
   lenses, exports, demo data, theme, toolbar wiring
   ===================================================================== */

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';

const App = {
  changed: debounce(() => { Library.render(); Minimap.draw(); if (!Board.selection().length) Inspector.show(); }, 60),

  afterRestore() { Board.rebuildAll(); Library.render(); Atlas.rebuild(); },

  setBusy(msg) {
    const b = $('#busy');
    if (!msg) { b.hidden = true; return; }
    b.hidden = false;
    $('#busy-text').textContent = msg;
  },

  setTheme(t) {
    S.settings.theme = t;
    document.documentElement.dataset.theme = t;
    Theme.read();
    Board.rebuildAll();
    Atlas.rebuild();
    saveSoon();
  },

  /* ---------- import ---------- */
  pickFiles(at) { this._at = at || null; $('#file-input').click(); },

  readImage(f) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onerror = () => rej(fr.error);
      fr.onload = async () => {
        try {
          const img = await Vision.loadImg(fr.result);
          let w = img.naturalWidth || 1200, h = img.naturalHeight || 900, src = fr.result;
          const MAX = 2800, needs = Math.max(w, h) > MAX || !/^data:image\/(png|jpe?g|webp)/i.test(src) || f.size > 6e6;
          if (needs) {
            const s = Math.min(1, MAX / Math.max(w, h));
            w = Math.round(w * s); h = Math.round(h * s);
            const c = el('canvas', { width: w, height: h }), cx = c.getContext('2d');
            cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); cx.drawImage(img, 0, 0, w, h);
            src = c.toDataURL('image/jpeg', 0.9);
          }
          res({ src, w, h, name: f.name.replace(/\.[a-z0-9]+$/i, '') });
        } catch { rej(new Error('the browser cannot decode this image (HEIC? convert to JPG/PNG)')); }
      };
      fr.readAsDataURL(f);
    });
  },

  async readPdf(f) {
    if (!window.pdfjsLib) throw new Error('PDF support needs pdf.js (loaded from cdnjs) — check your connection');
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
    const base = f.name.replace(/\.pdf$/i, ''), out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      this.setBusy(`Rendering ${base} — page ${p} of ${doc.numPages}`);
      const page = await doc.getPage(p);
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(3, 2400 / Math.max(vp0.width, vp0.height)) });
      const c = el('canvas', { width: Math.round(vp.width), height: Math.round(vp.height) }), cx = c.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      out.push({ src: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height, name: doc.numPages > 1 ? `${base} · page ${p}` : base });
    }
    return out;
  },

  async importFiles(list, at) {
    const files = [...list];
    if (!files.length) return;
    const [x0, y0] = at || Board.centerWorld().map((v, i) => v - (i ? 200 : 460));
    const assets = [];
    for (const f of files) {
      this.setBusy(`Reading ${f.name}…`);
      await nextFrame();
      try {
        if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) assets.push(...await this.readPdf(f));
        else if (f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(f.name)) assets.push(await this.readImage(f));
        else toast(`Skipped ${f.name} — not an image or PDF`, 'bad');
      } catch (err) { console.error(err); toast(`Could not read ${f.name}: ${err.message || err}`, 'bad', 5000); }
    }
    let y = y0, maps = 0;
    const created = [];
    for (const a of assets) {
      const id = registerAsset(a);
      const w = 420, h = Math.round(420 * a.h / a.w);
      const scan = Board.add({ type: 'scan', x: x0, y, w, h, asset: id, name: a.name, opacity: 1, blend: 'normal' });
      created.push(scan.id);
      if (S.settings.autoDigitize) {
        this.setBusy(`Digitizing ${a.name}…`);
        await nextFrame();
        try { const m = await this.autoDigitize(scan); created.push(m.id); maps++; }
        catch (err) { console.error(err); toast(`Auto-digitize failed for ${a.name} — open it with the wand.`, 'bad'); }
      }
      y += h + 80;
    }
    this.setBusy(null);
    if (!created.length) return;
    commit();
    Board.fit(created);
    const firstMap = created.map(getItem).find(i => i?.type === 'map');
    if (firstMap && !S.template) {
      setTimeout(() => Digitizer.open({ mapId: firstMap.id }), 450);
      toast('First scan: check the frame and name the axes. They become the template for every other sheet.', 'good', 6000);
      return;
    }
    toast(maps ? `Imported ${assets.length} scan${assets.length > 1 ? 's' : ''} → ${maps} digital map${maps > 1 ? 's' : ''}. Check each with the wand.` : `Imported ${assets.length} scan${assets.length > 1 ? 's' : ''}. Double-click to digitize.`, 'good', 4500);
  },

  async autoDigitize(scan) {
    const px = await Vision.pixels(scan.asset);
    const quad = Vision.detectFrame(px);
    const ink = { sens: 26, guard: 0.015, k: 'auto', minSpan: 0.2, ...(S.template?.ink || {}) };
    const res = Vision.analyzePx(px, quad, ink);
    const lines = Vision.linesFrom(res, (S.template?.lines || []).map(({ id, ...l }) => l)).map(({ cands, ...l }) => l);
    const meta = parseName(scan.name);
    if (!lines.length) meta.tags.push('needs-review');
    const m = this.createMap({ asset: scan.asset, source: scan.id, quad, axes: clone(S.template?.axes || defaultAxes()), meta, lines, ink: { ...ink, erase: [], disabled: [] } }, scan);
    m.auto = true; // not yet reviewed in the digitizer
    return m;
  },

  createMap(d, scan, pos) {
    const n = itemsOf('map').length;
    let x, y;
    if (pos) [x, y] = pos;
    else if (scan) { x = scan.x + scan.w + 56; y = scan.y; }
    else [x, y] = Board.centerWorld().map((v, i) => v - (i ? 190 : 270));
    const it = Board.add({
      type: 'map', x, y, w: 540, h: 380,
      asset: d.asset || null, source: d.source || null, quad: d.quad || null, ink: d.ink || null,
      axes: d.axes || defaultAxes(), meta: { ...parseName(''), ...d.meta, tags: [...(d.meta?.tags || [])] },
      lines: d.lines || [], view: defaultMapView(), color: PALETTE[(n * 5 + 1) % PALETTE.length],
    });
    if (scan) { S.links.push({ id: uid('k'), a: scan.id, b: it.id, color: '#ff4f5e', label: '' }); Board.drawLinks(); }
    Library.render();
    return it;
  },

  /* ---------- lenses ---------- */
  newLens(at, mapIds = []) {
    const [x, y] = at || Board.centerWorld().map((v, i) => v - (i ? 280 : 450));
    const it = Board.add({
      type: 'lens', x, y, w: 920, h: 560, title: `Lens ${itemsOf('lens').length + 1}`, maps: [...mapIds],
      opts: defaultLensOpts(), hidden: {}, mute: {}, underOff: {}, tagFilter: [], focus: null, axesFrom: null,
    });
    Board.select([it.id]); commit();
    return it;
  },
  compare(ids) {
    const maps = ids.map(getItem).filter(i => i?.type === 'map');
    if (!maps.length) return toast('Select one or more maps first — or drag maps onto a lens.');
    const x1 = Math.max(...maps.map(m => m.x + m.w)), y0 = Math.min(...maps.map(m => m.y));
    const l = this.newLens([x1 + 90, y0], maps.map(m => m.id));
    Board.fit([l.id, ...maps.map(m => m.id)]);
    return l;
  },
  stackScans(scans) {
    const base = scans[0];
    scans.forEach((s, i) => {
      const a = ASSETS.get(s.asset);
      s.x = base.x; s.y = base.y; s.w = base.w; s.h = a ? Math.round(base.w * a.h / a.w) : s.h;
      s.opacity = i === 0 ? 1 : 0.5; s.z = ++S.z;
      Board.refresh(s.id);
    });
    commit();
    toast('Stacked. Lower opacity or use the Difference blend in the inspector. For perspective-aligned stacks, use a lens’s “Scan stack”.', '', 5000);
  },

  /* ---------- export ---------- */
  stamp: () => new Date().toISOString().slice(0, 10),
  slug: s => String(s || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export',

  async exportProject() {
    const assets = {};
    for (const it of S.items) if (it.asset && ASSETS.has(it.asset)) assets[it.asset] = ASSETS.get(it.asset);
    const used = [...AudioLib.used()].filter(id => AUDIO.has(id));
    const bytes = used.reduce((s, id) => s + AUDIO.get(id).size, 0);
    // the project file is opened with one JSON.parse, which browsers cap near 512 MB of text
    if (bytes > 360e6 && !confirm(`This project holds ${Math.round(bytes / 1e6)} MB of audio, which may be too large to open again in one file. Export anyway?`)) return;
    this.setBusy('Packing project…');
    try {
      const parts = [`{"app":"tracefield","version":2,"state":${JSON.stringify(S)},"assets":${JSON.stringify(assets)},"audio":{`];
      for (let i = 0; i < used.length; i++) {
        const { blob, ...meta } = AUDIO.get(used[i]);
        parts.push(`${i ? ',' : ''}${JSON.stringify(used[i])}:${JSON.stringify({ ...meta, data: await AudioLib.toDataUrl(blob) })}`);
      }
      parts.push('}}');
      download(`tracefield-${this.stamp()}.json`, new Blob(parts, { type: 'application/json' }));
      toast(used.length ? `Project exported with ${used.length} recording${used.length > 1 ? 's' : ''}. Share it only as your consent terms allow.` : 'Project exported (images included).', 'good', 5000);
    } catch (err) { console.error(err); toast('Export failed: ' + err.message, 'bad', 6000); }
    this.setBusy(null);
  },
  async importProject(file, quiet) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'tracefield') throw new Error('not a Tracefield project file');
      if (!quiet && S.items.length && !confirm('Replace the current board with this project? (Export first if you want to keep it.)')) return;
      Scape.dropAll();
      ASSETS.clear(); await Store.clear('assets');
      AUDIO.clear(); await Store.clear('audio');
      for (const [id, a] of Object.entries(data.assets || {})) { ASSETS.set(id, a); Store.put('assets', id, a); }
      for (const [id, { data: url, ...meta }] of Object.entries(data.audio || {})) {
        const a = { ...meta, blob: AudioLib.fromDataUrl(url) };
        AUDIO.set(id, a); Store.put('audio', id, a);
      }
      const f = freshState();
      S = { ...f, ...data.state, settings: { ...f.settings, ...(data.state.settings || {}) }, atlas: { ...f.atlas, ...(data.state.atlas || {}) }, geo: { ...f.geo, ...(data.state.geo || {}) } };
      document.documentElement.dataset.theme = S.settings.theme; Theme.read();
      Board.rebuildAll(); Library.render(); Hist.reset(); saveNow();
      Atlas.rebuild();
      Board.fit();
      toast('Project loaded.', 'good');
    } catch (err) { toast('Could not open project: ' + err.message, 'bad', 5000); }
  },

  csvRow: vals => vals.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(','),
  seriesRows(m, ln, pts, qx) {
    const a = m.axes, md = m.meta, rows = [];
    const samples = qx ? pts : Array.from({ length: 101 }, (_, i) => [i / 100, sampleAt(pts, i / 100)]).filter(p => p[1] != null);
    for (const [u, v] of samples) rows.push([m.id, md.title, md.participant, md.session, md.condition, md.date, (md.tags || []).join(' '), ln.name, ln.key, round(Plot.toX(a, u), 4), round(Plot.toY(a, v), 4), round(u), round(v)]);
    return rows;
  },
  HEAD: ['map_id', 'title', 'participant', 'session', 'condition', 'date', 'tags', 'line', 'key', 'x', 'y', 'u_norm', 'v_norm'],
  exportCSV(maps) {
    const rows = [this.HEAD];
    for (const m of maps) for (const ln of m.lines) {
      if (!ln.visible) continue;
      rows.push(...this.seriesRows(m, ln, Plot.quantize(Plot.effective(ln), m.view.qx, m.view.qy), m.view.qx));
    }
    download(`tracefield-${maps.length === 1 ? this.slug(maps[0].meta.title) : 'maps'}-${this.stamp()}.csv`, rows.map(this.csvRow).join('\n'), 'text/csv');
  },
  exportLensCSV(lens) {
    const D = Plot.lensData(lens), o = lens.opts, rows = [this.HEAD];
    for (const s of D.series) if (s.on) rows.push(...this.seriesRows(s.map, s.line, s.q, o.qx));
    const a = D.maps[0]?.axes || defaultAxes();
    for (const [g, ag] of D.agg) for (const r of ag.rows) rows.push(['average', `${lens.title} ⌀ ${g}`, '', '', '', '', '', `avg:${g}`, g, round(Plot.toX(a, r.u), 4), round(Plot.toY(a, r.m), 4), round(r.u), round(r.m)]);
    download(`tracefield-${this.slug(lens.title)}-${this.stamp()}.csv`, rows.map(this.csvRow).join('\n'), 'text/csv');
  },
  plotSVG(id) {
    const it = getItem(id), svg = Board.node(id)?.querySelector('.plot-svg');
    if (!svg) return null;
    const c = svg.cloneNode(true);
    c.querySelectorAll('.hover, .playhead, .hit').forEach(n => n.remove());
    const w = +c.getAttribute('width'), h = +c.getAttribute('height'), T = Theme.t();
    const title = it.type === 'lens' ? it.title : it.meta.title;
    c.setAttribute('viewBox', `0 -34 ${w} ${h + 34}`); c.setAttribute('height', h + 34);
    c.insertBefore(sv('rect', { x: 0, y: -34, width: w, height: h + 34, fill: T.card }), c.firstChild);
    c.append(sv('text', { x: 14, y: -12, fill: T.text, 'font-size': 15, 'font-weight': 700, 'font-family': 'Space Grotesk, sans-serif', text: title || '' }));
    return { svg: new XMLSerializer().serializeToString(c), w, h: h + 34, title };
  },
  exportSVG(id) {
    const r = this.plotSVG(id);
    if (r) download(`${this.slug(r.title)}-${this.stamp()}.svg`, r.svg, 'image/svg+xml');
  },
  exportPNG(id) {
    const r = this.plotSVG(id);
    if (!r) return;
    const img = new Image();
    img.onload = () => {
      const c = el('canvas', { width: r.w * 2, height: r.h * 2 }), cx = c.getContext('2d');
      cx.scale(2, 2); cx.drawImage(img, 0, 0);
      c.toBlob(b => download(`${this.slug(r.title)}-${this.stamp()}.png`, b), 'image/png');
    };
    img.onerror = () => toast('PNG export failed — try SVG.', 'bad');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(r.svg);
  },

  /* ---------- demo ---------- */
  loadDemo() {
    const rnd = mulberry32(42);
    const noise = () => { const a = [1, 2, 3].map(() => [rnd() * 6 + 2, rnd() * 6.3, rnd() * 0.05]); return u => a.reduce((s, [f, p, amp]) => s + Math.sin(u * f + p) * amp, 0); };
    const axes = { ...defaultAxes(), yHigh: 'Loud', yLow: 'Subtle', yTitle: '', xStart: 'Blindfold on', xEnd: 'Blindfold off', xTitle: 'Time', xMin: 0, xMax: 10, xUnit: 'min', yMax: 100, yUnit: '' };
    const shapes = [
      ['Line 1', '#5aa9ff', u => 0.9 * Math.exp(-u * 2.6) + 0.02],
      ['Line 2', '#2ee6a6', u => clamp(0.55 + 0.36 * Math.abs(Math.sin(u * Math.PI * 2.6)) * (1.15 - u) - Math.max(0, u - 0.62) * 1.9, 0, 1)],
      ['Line 3', '#ff4fa3', u => 0.08 + 0.06 * Math.sin(u * 3)],
    ];
    const [cx, cy] = Board.centerWorld();
    const ids = [];
    const people = ['P01', 'P02', 'P03', 'P04'];
    people.forEach((p, pi) => [1, 2].forEach((sess, si) => {
      const lines = shapes.map(([name, color, f], li) => {
        const nz = noise(), amp = 0.75 + rnd() * 0.45, shift = (rnd() - 0.5) * 0.12, u0 = 0.03 + rnd() * 0.08, u1 = li === 2 ? 0.97 : 0.68 + rnd() * 0.28;
        const lag = si ? 0.04 : 0, pts = [];
        for (let i = 0; i <= 160; i++) { const u = u0 + (u1 - u0) * i / 160; pts.push([round(u), round(clamp(f(clamp(u - lag + shift * 0.3, 0, 1)) * amp + nz(u) + (si ? 0.05 * (li === 0) : 0), 0, 1))]); }
        return { id: uid('l'), name, key: name, color, visible: true, pts, adj: { dy: 0, sy: 1, smooth: 0 } };
      });
      const m = this.createMap({ axes: clone(axes), meta: { title: `${p} · test ${sess}`, participant: p, session: String(sess), condition: sess === 1 ? 'silence' : 'soundscape', date: today(), tags: ['demo', pi < 2 ? 'group-a' : 'group-b'], notes: '' }, lines }, null, [cx - 1200 + si * 580, cy - 900 + pi * 420]);
      ids.push(m.id);
    }));
    const l = this.newLens([cx, cy - 900], ids);
    l.title = 'All participants';
    Board.refresh(l.id);
    const l2 = this.newLens([cx, cy - 300], ids.filter((_, i) => i % 2 === 0));
    l2.title = 'Test 1 — ridge'; l2.opts.mode = 'ridge'; l2.opts.colorBy = 'line'; l2.opts.avg = false;
    Board.refresh(l2.id);
    const n = Board.newNote(cx + 960, cy - 900, 'Line 2 peaks shift later in test 2 — anticipation?');
    Board.select([]);
    commit();
    Board.fit([...ids, l.id, l2.id, n.id]);
    toast('Demo loaded: 8 maps, 2 lenses. Try the consensus slider and ▶.', 'good', 5000);
  },

  async clearBoard() {
    if (!confirm('Clear the whole board? This cannot be undone (export first to keep a copy).')) return;
    Player.stop();
    Scape.dropAll();
    const settings = S.settings, geo = S.geo;
    S = freshState(); S.settings = settings; S.geo = geo;
    ASSETS.clear(); await Store.clear('assets');
    AUDIO.clear(); await Store.clear('audio');
    Board.rebuildAll(); Library.render(); Hist.reset(); saveNow();
    Atlas.rebuild();
  },

  mainMenu(btn) {
    const r = btn.getBoundingClientRect();
    Menu.show(r.right - 230, r.bottom + 8, [
      { header: 'Project' },
      { label: 'Export project (.json)', icon: 'download', kbd: 'Ctrl S', action: () => this.exportProject() },
      { label: 'Open project…', icon: 'upload', action: () => $('#project-input').click() },
      { label: 'Load demo data', icon: 'sparkle', action: () => this.loadDemo() },
      { label: 'Load sound map demo', icon: 'earth', action: () => Atlas.loadDemo() },
      '-',
      { label: 'Template & auto-digitize…', icon: 'template', action: () => Template.open() },
      { label: S.settings.theme === 'dark' ? 'Paper theme' : 'Night theme', icon: S.settings.theme === 'dark' ? 'sun' : 'moon', action: () => this.setTheme(S.settings.theme === 'dark' ? 'light' : 'dark') },
      { label: 'Shortcuts & guide', icon: 'help', kbd: '?', action: () => Help.open() },
      '-',
      { label: 'Clear board…', icon: 'trash', danger: true, action: () => this.clearBoard() },
    ]);
  },
};

/* =====================================================================
   wiring + boot
   ===================================================================== */
function wireUI() {
  $$('#tools [data-tool]').forEach(b => b.addEventListener('click', () => Board.setTool(b.dataset.tool)));
  $('#btn-import').onclick = () => App.pickFiles();
  $('#btn-lens').onclick = () => App.newLens();
  $('#btn-undo').onclick = () => Hist.undo();
  $('#btn-redo').onclick = () => Hist.redo();
  $('#btn-menu').onclick = e => App.mainMenu(e.currentTarget);
  $('#btn-help').onclick = () => Help.open();
  $('#zoom-in').onclick = () => Atlas.active ? Atlas.zoomBy(1.6) : Board.zoomBy(1.25);
  $('#zoom-out').onclick = () => Atlas.active ? Atlas.zoomBy(0.6) : Board.zoomBy(0.8);
  $('#zoom-fit').onclick = () => Atlas.active ? Atlas.fitAll() : Board.fit();
  $('#zoom-label').onclick = () => { if (!Atlas.active) Board.zoomTo100(); };
  $('#file-input').addEventListener('change', e => { App.importFiles(e.target.files, App._at); e.target.value = ''; });
  $('#project-input').addEventListener('change', e => { if (e.target.files[0]) App.importProject(e.target.files[0]); e.target.value = ''; });
  $('#welcome-import').onclick = () => App.pickFiles();
  $('#welcome-demo').onclick = () => App.loadDemo();
  $('#welcome-map').onclick = () => Atlas.loadDemo();
  $('#hint-demo').onclick = () => Atlas.loadDemo();
  $('#welcome-help').onclick = () => Help.open();
  $$('[data-close]').forEach(b => b.addEventListener('click', () => { const m = b.closest('.modal'); if (m.id === 'template') Template.close(); else m.hidden = true; }));
  $('#lib-toggle').onclick = () => $('#library').classList.toggle('collapsed');
  $('#insp-toggle').onclick = () => $('#inspector').classList.toggle('collapsed');

  // pen options
  const po = $('#pen-colors');
  PEN_COLORS.forEach(c => po.append(el('button', { style: { background: c }, class: c === Board.pen.color ? 'on' : '', title: c, onclick: e => { Board.pen.color = c; $$('button', po).forEach(b => b.classList.toggle('on', b === e.currentTarget)); } })));
  $('#pen-width').addEventListener('input', e => { Board.pen.w = +e.target.value; });
  $('#pen-hi').addEventListener('change', e => { Board.pen.hi = e.target.checked; });

  // drop files anywhere on the board
  const dz = $('#dropzone');
  let depth = 0;
  const isFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (isFiles(e)) { depth++; dz.hidden = false; } });
  window.addEventListener('dragleave', e => { if (isFiles(e) && --depth <= 0) { depth = 0; dz.hidden = true; } });
  window.addEventListener('dragover', e => { if (isFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!isFiles(e)) return;
    e.preventDefault(); depth = 0; dz.hidden = true;
    if (!$('#digitizer').hidden) return;
    if (Atlas.active) return Atlas.dropFiles(e.dataTransfer.files, e.clientX, e.clientY);
    App.importFiles(e.dataTransfer.files, Board.toWorld(e.clientX, e.clientY));
  });
  // paste images
  window.addEventListener('paste', e => {
    if (e.target.closest?.('input,textarea,[contenteditable="true"]')) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && !Atlas.active) { e.preventDefault(); App.importFiles(files); }
  });
  window.addEventListener('beforeunload', () => saveNow());
}

(async function boot() {
  const ok = await Store.open();
  if (ok) {
    try {
      const raw = await Store.get('kv', 'project');
      if (raw) {
        const data = JSON.parse(raw), f = freshState();
        S = { ...f, ...data, settings: { ...f.settings, ...(data.settings || {}) }, atlas: { ...f.atlas, ...(data.atlas || {}) }, geo: { ...f.geo, ...(data.geo || {}) } };
      }
      await AudioLib.load();
      const used = new Set(S.items.map(i => i.asset).filter(Boolean));
      for (const k of (await Store.keys('assets')) || []) {
        if (!used.has(k)) { Store.del('assets', k); continue; }
        const a = await Store.get('assets', k);
        if (a) ASSETS.set(k, a);
      }
    } catch (err) { console.warn('Restore failed', err); toast('Could not restore the last session.', 'bad'); }
  } else toast('Storage unavailable — work is not auto-saved. Export the project to keep it.', 'bad', 6000);

  document.documentElement.dataset.theme = S.settings.theme || 'dark';
  Theme.read();
  Board.init(); Inspector.init(); Library.init(); Digitizer.init(); Atlas.init();
  wireUI();
  Board.setTool('select');
  if (!S.items.length) { const r = $('#board').getBoundingClientRect(); S.view = { x: r.width / 2, y: r.height / 2, z: 1 }; }
  Board.rebuildAll();
  Library.render();
  Hist.reset();
  Atlas.setMix(S.geo.mix ?? 1);
  document.body.classList.add('ready');

  // ?project=study.json loads a hosted project without touching this browser's saved work; ?exhibit opens it for visitors
  const q = new URLSearchParams(location.search);
  if (q.has('project')) {
    Store.db = null;
    try {
      const r = await fetch(q.get('project'));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      App.locked = q.has('exhibit');
      await App.importProject(await r.blob(), true);
    } catch (err) { toast('Could not load that project: ' + err.message, 'bad', 7000); }
  }
  if (q.has('exhibit')) { await Atlas.enter(); Atlas.exhibit(true); }
  else if (S.geo.on) Atlas.enter();
})();
