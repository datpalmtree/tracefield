'use strict';
/* =====================================================================
   Tracefield · plot
   line maths (adjust, normalise, quantise, aggregate, stats) and
   SVG rendering for map cards and lens (comparison) cards
   ===================================================================== */

const Plot = (() => {

  /* ---------- line maths ---------- */

  function effective(line) {
    const a = line.adj || {};
    let pts = line.pts || [];
    if (!pts.length) return pts;
    const r = Math.round(a.smooth || 0);
    if (r > 0) {
      pts = pts.map((p, i) => {
        let s = 0, n = 0;
        for (let j = Math.max(0, i - r); j <= Math.min(pts.length - 1, i + r); j++) { s += pts[j][1]; n++; }
        return [p[0], s / n];
      });
    }
    const sy = a.sy ?? 1, dy = a.dy || 0, dx = a.dx || 0;
    if (sy !== 1 || dy || dx) pts = pts.map(([u, v]) => [clamp(u + dx, 0, 1), clamp(v * sy + dy, 0, 1)]);
    return pts;
  }

  function normalize(pts, mode) {
    if (!mode || mode === 'none' || pts.length < 2) return pts;
    let mn = Infinity, mx = -Infinity, sum = 0;
    for (const p of pts) { mn = Math.min(mn, p[1]); mx = Math.max(mx, p[1]); sum += p[1]; }
    const mean = sum / pts.length;
    if (mode === 'minmax') { const r = mx - mn || 1; return pts.map(([u, v]) => [u, (v - mn) / r]); }
    if (mode === 'center') return pts.map(([u, v]) => [u, clamp(v - mean + 0.5, 0, 1)]);
    if (mode === 'start') return pts.map(([u, v]) => [u, clamp(v - pts[0][1] + 0.5, 0, 1)]);
    return pts;
  }

  /** Bin into qx columns (mean per bin) and snap to qy levels. 0 = off. */
  function quantize(pts, qx, qy) {
    if (!pts.length) return pts;
    let out;
    if (!qx) out = pts;
    else {
      out = [];
      const u0 = pts[0][0], u1 = pts[pts.length - 1][0];
      for (let i = 0; i < qx; i++) {
        const a = i / qx, b = (i + 1) / qx, lo = Math.max(a, u0), hi = Math.min(b, u1);
        if (hi - lo < (b - a) * 0.35) continue;
        let s = 0, n = 0;
        for (let k = 0; k <= 8; k++) { const v = sampleAt(pts, lo + (hi - lo) * k / 8); if (v != null) { s += v; n++; } }
        if (n) out.push([(a + b) / 2, s / n]);
      }
    }
    if (qy > 1) out = out.map(([u, v]) => [u, Math.round(v * (qy - 1)) / (qy - 1)]);
    return out;
  }

  /** Value at u; for quantised series, the value of the bin under u. */
  function valueAt(pts, u, qx) {
    if (!pts.length) return null;
    if (!qx) return sampleAt(pts, u);
    const half = 0.5 / qx;
    let best = null, bd = Infinity;
    for (const p of pts) { const d = Math.abs(p[0] - u); if (d < bd) { bd = d; best = p; } }
    return bd <= half + 1e-9 ? best[1] : null;
  }

  /** Mean / spread across several lines, sampled at K points. */
  function aggregate(list, K = 120) {
    let rows = [];
    const need = Math.max(1, Math.ceil(list.length * 0.5));
    for (let i = 0; i <= K; i++) {
      const u = i / K, vals = [];
      for (const p of list) { const v = sampleAt(p, u); if (v != null) vals.push(v); }
      if (vals.length < need) continue;
      const n = vals.length, m = vals.reduce((a, b) => a + b, 0) / n;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / n);
      rows.push({ u, m, sd, mn: Math.min(...vals), mx: Math.max(...vals), n });
    }
    // light smoothing so the mean doesn't jump where lines start / stop
    if (list.length > 1) rows = rows.map((r, i) => {
      const nb = rows.slice(Math.max(0, i - 2), i + 3).filter(q => Math.abs(q.u - r.u) < 2.5 / K);
      const avg = k => nb.reduce((s, q) => s + q[k], 0) / nb.length;
      return { ...r, m: avg('m'), sd: avg('sd'), mn: avg('mn'), mx: avg('mx') };
    });
    return { rows, mean: rows.map(r => [r.u, r.m]) };
  }

  function stats(pts) {
    if (!pts || pts.length < 2) return null;
    const u0 = pts[0][0], u1 = pts[pts.length - 1][0], K = 100, vs = [];
    for (let i = 0; i <= K; i++) vs.push([u0 + (u1 - u0) * i / K, sampleAt(pts, u0 + (u1 - u0) * i / K)]);
    let mx = vs[0], mn = vs[0], sum = 0;
    for (const p of vs) { if (p[1] > mx[1]) mx = p; if (p[1] < mn[1]) mn = p; sum += p[1]; }
    const mean = sum / vs.length;
    const sd = Math.sqrt(vs.reduce((a, p) => a + (p[1] - mean) ** 2, 0) / vs.length);
    // peaks: local maxima with ≥ 0.08 prominence on both sides
    let peaks = 0;
    for (let i = 1; i < vs.length - 1; i++) {
      if (!(vs[i][1] >= vs[i - 1][1] && vs[i][1] > vs[i + 1][1])) continue;
      let l = vs[i][1], r = vs[i][1];
      for (let j = i - 1; j >= 0 && vs[j][1] <= vs[i][1]; j--) l = Math.min(l, vs[j][1]);
      for (let j = i + 1; j < vs.length && vs[j][1] <= vs[i][1]; j++) r = Math.min(r, vs[j][1]);
      if (vs[i][1] - Math.max(l, r) >= 0.08) peaks++;
    }
    return { mean, sd, max: mx[1], maxU: mx[0], min: mn[1], minU: mn[0], start: vs[0][1], end: vs[vs.length - 1][1], u0, u1, peaks };
  }

  /** Similarity over the shared X range: 1 − mean absolute difference, plus Pearson r. */
  function similarity(a, b) {
    const lo = Math.max(a[0]?.[0] ?? 1, b[0]?.[0] ?? 1), hi = Math.min(a[a.length - 1]?.[0] ?? 0, b[b.length - 1]?.[0] ?? 0);
    if (hi - lo < 0.15) return null;
    const N = 60, xs = [], ys = [];
    for (let i = 0; i <= N; i++) { const u = lo + (hi - lo) * i / N; xs.push(sampleAt(a, u)); ys.push(sampleAt(b, u)); }
    const n = xs.length, mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
    let mae = 0, cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) { mae += Math.abs(xs[i] - ys[i]); cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
    mae /= n;
    return { mae, sim: 1 - mae, r: vx && vy ? cov / Math.sqrt(vx * vy) : 0, overlap: hi - lo };
  }

  const toX = (axes, u) => +axes.xMin + u * (axes.xMax - axes.xMin);
  const toY = (axes, v) => +axes.yMin + v * (axes.yMax - axes.yMin);
  const fmtX = (axes, u) => fmtNum(toX(axes, u)) + (axes.xUnit ? ' ' + axes.xUnit : '');
  const fmtY = (axes, v) => fmtNum(toY(axes, v)) + (axes.yUnit ? ' ' + axes.yUnit : '');

  /* ---------- svg paths ---------- */

  function segments(P, gap) {
    const out = [];
    let cur = [];
    for (let i = 0; i < P.length; i++) {
      if (i && P[i][0] - P[i - 1][0] > gap) { out.push(cur); cur = []; }
      cur.push(P[i]);
    }
    if (cur.length) out.push(cur);
    return out;
  }
  const f1 = n => Math.round(n * 10) / 10;
  const linD = s => s.map((p, i) => (i ? 'L' : 'M') + f1(p[0]) + ' ' + f1(p[1])).join('');
  function smoothD(s) {
    const n = s.length;
    if (n < 3) return linD(s);
    const dx = [], m = [], t = new Array(n);
    for (let i = 0; i < n - 1; i++) { dx[i] = s[i + 1][0] - s[i][0] || 1e-6; m[i] = (s[i + 1][1] - s[i][1]) / dx[i]; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (!m[i]) { t[i] = t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
      if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    let d = `M${f1(s[0][0])} ${f1(s[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += `C${f1(s[i][0] + h)} ${f1(s[i][1] + t[i] * h)} ${f1(s[i + 1][0] - h)} ${f1(s[i + 1][1] - t[i + 1] * h)} ${f1(s[i + 1][0])} ${f1(s[i + 1][1])}`;
    }
    return d;
  }
  function stepD(s, half) {
    let d = '';
    s.forEach((p, i) => {
      const x0 = p[0] - half, x1 = p[0] + half;
      d += (i ? `L${f1(x0)} ${f1(p[1])}` : `M${f1(x0)} ${f1(p[1])}`) + `L${f1(x1)} ${f1(p[1])}`;
    });
    return d;
  }
  /** Data points → path in frame F. */
  function pathFor(P, F, curve, qx) {
    const gap = qx ? 1.6 / qx : 0.035;
    const half = qx ? F.pw / qx / 2 : 0;
    return segments(P, gap).map(seg => {
      const s = seg.map(([u, v]) => [F.X(u), F.Y(v)]);
      if (curve === 'step') return qx ? stepD(s, half) : linD(s);
      if (curve === 'linear') return linD(s);
      return smoothD(s);
    }).join('');
  }
  function areaD(rowsLo, rowsHi, F) {
    if (!rowsLo.length) return '';
    let d = rowsHi.map((p, i) => (i ? 'L' : 'M') + f1(F.X(p[0])) + ' ' + f1(F.Y(p[1]))).join('');
    for (let i = rowsLo.length - 1; i >= 0; i--) d += 'L' + f1(F.X(rowsLo[i][0])) + ' ' + f1(F.Y(rowsLo[i][1]));
    return d + 'Z';
  }

  /* ---------- frame + axes ---------- */

  function frame(w, h, axes, o = {}) {
    const lab = Math.max(String(axes.yHigh || '').length, String(axes.yLow || '').length);
    const pl = o.padL ?? clamp(14 + lab * 6.8 + (axes.yTitle ? 18 : 0), 30, 150);
    const pr = 18, pt = 16, pb = 30 + (axes.xTitle ? 16 : 0);
    const pw = Math.max(20, w - pl - pr), ph = Math.max(20, h - pt - pb);
    return { w, h, pl, pt, pw, ph, X: u => pl + u * pw, Y: v => pt + (1 - v) * ph, U: x => (x - pl) / pw, V: y => 1 - (y - pt) / ph };
  }

  function defs(pid) {
    return sv('defs', {},
      sv('marker', { id: pid + 'ar', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        sv('path', { d: 'M1 1L9 5L1 9', fill: 'none', stroke: Theme.t().axis, 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })),
      sv('filter', { id: pid + 'ink', x: '-5%', y: '-20%', width: '110%', height: '140%' },
        sv('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.035', numOctaves: 2, seed: 4, result: 'n' }),
        sv('feDisplacementMap', { in: 'SourceGraphic', in2: 'n', scale: 5, xChannelSelector: 'R', yChannelSelector: 'G' })),
      sv('filter', { id: pid + 'glow', x: '-10%', y: '-30%', width: '120%', height: '160%' },
        sv('feGaussianBlur', { stdDeviation: 3.5, result: 'b' }),
        sv('feMerge', {}, sv('feMergeNode', { in: 'b' }), sv('feMergeNode', { in: 'SourceGraphic' }))));
  }

  function txt(x, y, s, a = {}) { return sv('text', { x, y, ...a, text: s }); }

  function drawAxes(svg, F, axes, o) {
    const T = Theme.t(), g = sv('g', { class: 'axes' });
    if (o.grid) {
      const nx = o.qx || 10, ny = o.qy > 1 ? o.qy - 1 : 4;
      for (let i = 1; i < nx; i++) g.append(sv('line', { x1: F.X(i / nx), x2: F.X(i / nx), y1: F.pt, y2: F.pt + F.ph, stroke: T.grid, 'stroke-width': 1 }));
      for (let j = 1; j <= ny; j++) g.append(sv('line', { x1: F.pl, x2: F.pl + F.pw, y1: F.Y(j / ny), y2: F.Y(j / ny), stroke: T.grid, 'stroke-width': 1, 'stroke-dasharray': o.qy > 1 ? '' : '2 4' }));
    }
    if (!o.noY) g.append(sv('path', { d: `M${F.X(0)} ${F.Y(1) - 6}L${F.X(0)} ${F.Y(0)}`, stroke: T.axis, 'stroke-width': 1.6, fill: 'none', 'marker-start': `url(#${o.pid}ar)` }));
    g.append(sv('path', { d: `M${F.X(0)} ${F.Y(0)}L${F.X(1) + 6} ${F.Y(0)}`, stroke: T.axis, 'stroke-width': 1.6, fill: 'none', 'marker-end': `url(#${o.pid}ar)` }));
    const lab = { fill: T.muted, 'font-size': 12, 'font-family': 'Space Grotesk, system-ui, sans-serif' };
    if (!o.noY) {
      g.append(txt(F.pl - 9, F.Y(1) + 9, axes.yHigh || '', { ...lab, 'text-anchor': 'end', fill: T.text, 'font-weight': 600 }));
      g.append(txt(F.pl - 9, F.Y(0), axes.yLow || '', { ...lab, 'text-anchor': 'end', fill: T.text, 'font-weight': 600 }));
      if (axes.yTitle) g.append(txt(12, F.pt + F.ph / 2, axes.yTitle, { ...lab, 'text-anchor': 'middle', transform: `rotate(-90 12 ${F.pt + F.ph / 2})` }));
    }
    g.append(txt(F.X(0), F.Y(0) + 19, axes.xStart || '', { ...lab, fill: T.text, 'font-weight': 600 }));
    g.append(txt(F.X(1), F.Y(0) + 19, axes.xEnd || '', { ...lab, 'text-anchor': 'end', fill: T.text, 'font-weight': 600 }));
    if (axes.xTitle) g.append(txt(F.X(0.5), F.Y(0) + 34, axes.xTitle, { ...lab, 'text-anchor': 'middle' }));
    if (o.ticks) {
      const tl = { fill: T.faint, 'font-size': 10, 'font-family': 'JetBrains Mono, monospace' };
      for (const t of [0.25, 0.5, 0.75]) {
        g.append(txt(F.X(t), F.Y(0) + 19, fmtNum(toX(axes, t)), { ...tl, 'text-anchor': 'middle' }));
        if (!o.noY) g.append(txt(F.pl + 4, F.Y(t) - 3, fmtNum(toY(axes, t)), tl));
      }
    }
    svg.append(g);
  }

  function drawSeries(g, P, F, st) {
    const T = Theme.t();
    if (!P.length) return;
    const common = { 'data-key': st.key, class: 'series' + (st.cls ? ' ' + st.cls : ''), opacity: st.opacity ?? 1 };
    if (st.curve !== 'points') {
      const d = pathFor(P, F, st.curve === 'ink' ? 'smooth' : st.curve, st.qx);
      if (st.halo) g.append(sv('path', { d, fill: 'none', stroke: T.card, 'stroke-width': st.width + 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.9, 'pointer-events': 'none' }));
      g.append(sv('path', {
        ...common, d, fill: 'none', stroke: st.color, 'stroke-width': st.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'stroke-dasharray': st.dash || null, filter: st.curve === 'ink' ? `url(#${st.pid}ink)` : st.glow ? `url(#${st.pid}glow)` : null,
      }));
      g.append(sv('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(10, st.width + 8), 'data-key': st.key, class: 'hit' }));
    }
    if (st.points || st.curve === 'points') {
      const r = st.curve === 'points' ? st.width * 1.5 + 1 : st.width * 1.15 + 0.6;
      const pts = st.qx || P.length < 60 ? P : P.filter((_, i) => i % Math.ceil(P.length / 60) === 0);
      for (const [u, v] of pts) g.append(sv('circle', { ...common, cx: f1(F.X(u)), cy: f1(F.Y(v)), r, fill: st.color, stroke: T.card, 'stroke-width': 1 }));
    }
  }

  /** Perspective-correct scan(s) stretched into the plot rectangle via CSS matrix3d. */
  function underlay(F, list, blend) {
    const box = el('div', { class: 'underlay', style: { left: F.pl + 'px', top: F.pt + 'px', width: F.pw + 'px', height: F.ph + 'px' } });
    for (const u of list) {
      const a = ASSETS.get(u.asset);
      if (!a || !u.quad) continue;
      const q = u.quad.map(([x, y]) => [x * a.w, y * a.h]);
      const H = homography(q, [[0, 0], [F.pw, 0], [F.pw, F.ph], [0, F.ph]]);
      box.append(el('img', { src: a.src, draggable: 'false', alt: '', style: { width: a.w + 'px', height: a.h + 'px', transform: hCss(H), opacity: u.opacity, mixBlendMode: blend || 'normal' } }));
    }
    return box;
  }

  function svgRoot(w, h) {
    return sv('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, class: 'plot-svg', xmlns: SVGNS });
  }

  /* ---------- map card ---------- */

  function renderMap(host, it, w, h) {
    host.innerHTML = '';
    const o = it.view, axes = it.axes, pid = uid('p'), T = Theme.t();
    const F = frame(w, h, axes);
    if (o.ghost > 0 && it.asset && ASSETS.has(it.asset)) host.append(underlay(F, [{ asset: it.asset, quad: it.quad, opacity: o.ghost }]));
    const svg = svgRoot(w, h);
    svg.append(defs(pid));
    drawAxes(svg, F, axes, { grid: o.grid, qx: o.qx, qy: o.qy, ticks: o.ticks, pid });
    const gl = sv('g', { class: 'lines' });
    const series = [];
    for (const ln of it.lines) {
      if (!ln.visible) continue;
      const P = quantize(effective(ln), o.qx, o.qy);
      const s = { key: ln.id, label: ln.name, color: ln.color, pts: P, qx: o.qx };
      s.y = u => { const v = valueAt(P, u, o.qx); return v == null ? null : F.Y(v); };
      s.val = u => valueAt(P, u, o.qx);
      series.push(s);
      drawSeries(gl, P, F, { color: ln.color, width: o.width, curve: o.curve, points: o.points || (o.qx > 0 && o.curve !== 'step'), key: ln.id, qx: o.qx, pid, halo: true });
    }
    if (!it.lines.length) svg.append(txt(F.X(0.5), F.Y(0.5), 'No lines yet — edit to draw one', { fill: T.faint, 'text-anchor': 'middle', 'font-size': 13 }));
    svg.append(gl);
    const hov = sv('g', { class: 'hover', 'pointer-events': 'none' }), play = sv('g', { class: 'playhead', 'pointer-events': 'none' });
    svg.append(hov, play);
    host.append(svg);
    host._ctx = { F, series, axes, svg, hov, play, pid, kind: 'map', id: it.id };
    return host._ctx;
  }

  /* ---------- lens (comparison) card ---------- */

  function fieldValue(s, field) {
    const m = s.map.meta || {};
    switch (field) {
      case 'line': return s.line.key || s.line.name || '—';
      case 'map': return m.title || s.map.id;
      case 'participant': return m.participant || '—';
      case 'session': return sessionLabel(m.session, 'Session ') || '—';
      case 'condition': return m.condition || '—';
      case 'tag': return (m.tags || [])[0] || '—';
      case 'all': return 'All';
      default: return '—';
    }
  }
  function seriesColor(s, by) {
    if (by === 'ink') return s.line.color;
    if (by === 'single') return Theme.t().accent;
    if (by === 'map') return s.map.color || colorFor('map', s.map.id);
    return colorFor(by, fieldValue(s, by));
  }
  function lensMaps(lens) {
    const f = lens.tagFilter || [];
    return lens.maps.map(getItem).filter(m => m && m.type === 'map' && (!f.length || (m.meta.tags || []).some(t => f.includes(t))));
  }
  function lensAxes(lens, maps) {
    const src = (lens.axesFrom && getItem(lens.axesFrom)) || maps[0];
    return src ? src.axes : (S.template?.axes || defaultAxes());
  }

  /** Everything a lens draws: series (with colour/group), aggregates, consensus pull applied. */
  function lensData(lens) {
    const o = lens.opts, maps = lensMaps(lens), series = [];
    maps.forEach((m, mi) => m.lines.forEach(ln => {
      if (!ln.visible) return;
      const key = m.id + ':' + ln.id;
      series.push({ key, map: m, line: ln, mi, pts: normalize(effective(ln), o.normalize), hidden: !!lens.hidden[key] });
    }));
    for (const s of series) {
      s.group = fieldValue(s, o.groupBy);
      s.cval = o.colorBy === 'ink' || o.colorBy === 'single' ? null : fieldValue(s, o.colorBy === 'map' ? 'map' : o.colorBy);
      s.color = seriesColor(s, o.colorBy);
      s.muted = s.cval != null && !!lens.mute?.[o.colorBy + ':' + s.cval];
      s.on = !s.hidden && !s.muted;
    }
    const groups = new Map();
    for (const s of series) { if (!s.on) continue; if (!groups.has(s.group)) groups.set(s.group, []); groups.get(s.group).push(s); }
    const agg = new Map();
    for (const [g, list] of groups) {
      const a = aggregate(list.map(s => s.pts));
      if (!a.rows.length) continue;
      // colour and dash can be set per average in the inspector; by default each average gets the next dash style
      a.color = o.avgColor?.[g] || (o.groupBy === o.colorBy || (o.groupBy === 'line' && o.colorBy === 'ink') ? list[0].color
        : o.groupBy === 'all' ? Theme.t().text : colorFor(o.groupBy, g));
      a.dash = o.avgDash?.[g] ?? agg.size;
      a.n = list.length;
      agg.set(g, a);
    }
    if (o.pull > 0) for (const s of series) {
      const a = agg.get(s.group);
      if (!a) continue;
      s.pts = s.pts.map(([u, v]) => { const m = sampleAt(a.mean, u); return [u, m == null ? v : lerp(v, m, o.pull)]; });
    }
    for (const s of series) s.q = quantize(s.pts, o.qx, o.qy);
    return { maps, series, agg };
  }
  const DASHES = [null, [4, 2.5], [1, 2.2], [6, 2, 1, 2], [2.5, 2.5], [8, 3]];
  const DASH_NAMES = ['Solid', 'Dashed', 'Dotted', 'Dash-dot', 'Short dash', 'Long dash'];
  /** Dash pattern i, scaled to the stroke width. */
  function dashFor(i, w) { const d = DASHES[i % DASHES.length]; return d ? d.map(x => round(x * Math.max(1.5, w), 1)).join(' ') : null; }

  function heatImage(list, W = 220, H = 130) {
    const acc = new Float32Array(W * H);
    const K = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) K.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / 2.2)]);
    for (const P of list) {
      let py = null;
      for (let i = 0; i <= W; i++) {
        const u = i / W, v = sampleAt(P, u);
        if (v == null) { py = null; continue; }
        const x = Math.min(W - 1, i), y = clamp(Math.round((1 - v) * (H - 1)), 0, H - 1);
        const ys = py == null ? [y] : Array.from({ length: Math.abs(y - py) + 1 }, (_, k) => py + Math.sign(y - py) * k);
        for (const yy of ys) for (const [dx, dy, w] of K) {
          const X = x + dx, Y = yy + dy;
          if (X >= 0 && Y >= 0 && X < W && Y < H) acc[Y * W + X] += w / ys.length;
        }
        py = y;
      }
    }
    let mx = 0;
    for (const v of acc) mx = Math.max(mx, v);
    const stops = [[0, [20, 10, 50, 0]], [0.12, [60, 16, 110, 140]], [0.35, [150, 40, 190, 210]], [0.6, [255, 79, 163, 235]], [0.82, [255, 176, 32, 250]], [1, [255, 248, 200, 255]]];
    const ramp = t => {
      for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
        const [a, ca] = stops[i - 1], [b, cb] = stops[i], k = (t - a) / (b - a);
        return ca.map((c, j) => c + (cb[j] - c) * k);
      }
      return stops[stops.length - 1][1];
    };
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const cx = c.getContext('2d'), img = cx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) { const [r, g, b, a] = ramp(mx ? Math.sqrt(acc[i] / mx) : 0); img.data.set([r, g, b, a], i * 4); }
    cx.putImageData(img, 0, 0);
    return c.toDataURL();
  }

  function renderLens(host, lens, w, h) {
    host.innerHTML = '';
    const o = lens.opts, T = Theme.t(), pid = uid('p');
    const D = lensData(lens);
    const axes = lensAxes(lens, D.maps);
    const mode = o.mode;
    const ax = mode === 'dev' ? { ...axes, yHigh: '▲ above', yLow: '▼ below' } : axes;
    const F = frame(w, h, ax, mode === 'ridge' ? { padL: 120 } : {});
    const svg = svgRoot(w, h);
    svg.append(defs(pid));
    const ctx = { F, series: [], axes, svg, pid, kind: 'lens', id: lens.id, D };
    host._ctx = ctx;

    if (!D.maps.length) {
      drawAxes(svg, F, axes, { grid: true, pid });
      svg.append(txt(F.X(0.5), F.Y(0.55), lens.maps.length ? 'No maps match the tag filter' : 'Drag map cards onto this lens', { fill: T.muted, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 600 }));
      svg.append(txt(F.X(0.5), F.Y(0.55) + 22, 'or select maps and press G', { fill: T.faint, 'text-anchor': 'middle', 'font-size': 12 }));
      host.append(svg);
      return ctx;
    }

    if (o.under > 0 && (mode === 'overlay' || mode === 'dev')) {
      const list = D.maps.filter(m => m.asset && !lens.underOff?.[m.id]).map(m => ({ asset: m.asset, quad: m.quad, opacity: o.under }));
      if (list.length) host.append(underlay(F, list, o.blend));
    }

    const vis = D.series.filter(s => s.on);
    const focus = lens.focus;
    const dimmed = s => focus && s.key !== focus && s.group !== focus;
    const lineW = o.width, op = o.opacity;

    if (mode === 'ridge') {
      drawAxes(svg, F, axes, { grid: false, pid, noY: true, ticks: o.ticks });
      const rows = D.maps.length, rowH = F.ph / (rows + 0.6), amp = rowH * 1.65;
      const g = sv('g');
      D.maps.forEach((m, i) => {
        const base = F.pt + rowH * (i + 1.25);
        g.append(sv('line', { x1: F.pl, x2: F.pl + F.pw, y1: base, y2: base, stroke: T.grid }));
        const lab = [m.meta.participant, sessionLabel(m.meta.session, 'S')].filter(Boolean).join(' · ') || m.meta.title;
        g.append(txt(F.pl - 10, base - 3, lab.slice(0, 18), { fill: T.text, 'font-size': 11.5, 'text-anchor': 'end', 'font-weight': 600 }));
        if (m.meta.condition) g.append(txt(F.pl - 10, base + 10, m.meta.condition.slice(0, 18), { fill: T.faint, 'font-size': 10, 'text-anchor': 'end' }));
        const Fr = { ...F, Y: v => base - v * amp };
        for (const s of vis.filter(s => s.map === m)) {
          const P = s.q;
          if (!P.length) continue;
          const d = pathFor(P, Fr, o.curve === 'ink' ? 'smooth' : o.curve === 'points' ? 'linear' : o.curve, o.qx);
          const area = d + `L${f1(Fr.X(P[P.length - 1][0]))} ${base}L${f1(Fr.X(P[0][0]))} ${base}Z`;
          g.append(sv('path', { d: area, fill: T.card, opacity: 0.85 }));
          g.append(sv('path', { d: area, fill: s.color, opacity: dimmed(s) ? 0.03 : 0.16 }));
          g.append(sv('path', { d, fill: 'none', stroke: s.color, 'stroke-width': lineW, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: dimmed(s) ? 0.15 : 1, class: 'series', 'data-key': s.key }));
          g.append(sv('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 10, class: 'hit', 'data-key': s.key }));
          ctx.series.push({ key: s.key, label: seriesLabel(s), color: s.color, val: u => valueAt(P, u, o.qx), y: u => { const v = valueAt(P, u, o.qx); return v == null ? null : Fr.Y(v); } });
        }
      });
      svg.append(g);
    } else if (mode === 'heat') {
      drawAxes(svg, F, axes, { grid: false, pid, ticks: o.ticks });
      svg.append(sv('image', { href: heatImage(vis.map(s => s.pts)), x: F.pl, y: F.pt, width: F.pw, height: F.ph, preserveAspectRatio: 'none', opacity: 0.95 }));
      const g = sv('g');
      if (o.avg) for (const [k, a] of D.agg) drawSeries(g, quantize(a.mean, o.qx, o.qy), F, { color: '#ffffff', width: lineW + 1, curve: o.curve, qx: o.qx, pid, key: k, dash: '6 5', opacity: 0.9 });
      svg.append(g);
      for (const s of vis) ctx.series.push({ key: s.key, label: seriesLabel(s), color: s.color, val: u => valueAt(s.q, u, o.qx), y: u => { const v = valueAt(s.q, u, o.qx); return v == null ? null : F.Y(v); } });
    } else {
      drawAxes(svg, F, ax, { grid: o.grid, qx: o.qx, qy: mode === 'dev' ? 0 : o.qy, ticks: o.ticks && mode !== 'dev', pid });
      const g = sv('g', { class: 'lines' });
      if (mode === 'dev') {
        g.append(sv('line', { x1: F.pl, x2: F.pl + F.pw, y1: F.Y(0.5), y2: F.Y(0.5), stroke: T.axis, 'stroke-dasharray': '5 5', opacity: 0.7 }));
        g.append(txt(F.pl + F.pw - 4, F.Y(0.5) - 6, 'group average', { fill: T.faint, 'font-size': 10, 'text-anchor': 'end' }));
      }
      const devPts = s => {
        const a = D.agg.get(s.group);
        if (!a) return [];
        return s.q.map(([u, v]) => { const m = sampleAt(a.mean, u); return m == null ? null : [u, clamp(0.5 + (v - m) * 1.25, 0, 1)]; }).filter(Boolean);
      };
      if (mode === 'overlay' && o.band !== 'none') {
        for (const [, a] of D.agg) {
          if (a.n < 2) continue;
          const lo = a.rows.map(r => [r.u, o.band === 'minmax' ? r.mn : clamp(r.m - r.sd, 0, 1)]);
          const hi = a.rows.map(r => [r.u, o.band === 'minmax' ? r.mx : clamp(r.m + r.sd, 0, 1)]);
          g.append(sv('path', { d: areaD(lo, hi, F), fill: a.color, opacity: 0.13, 'pointer-events': 'none' }));
        }
      }
      if (o.showLines || mode === 'dev') {
        for (const s of vis) {
          const P = mode === 'dev' ? devPts(s) : s.q;
          drawSeries(g, P, F, { color: s.color, width: lineW, curve: o.curve, qx: o.qx, pid, key: s.key, opacity: dimmed(s) ? 0.1 : focus ? 1 : op, points: o.qx > 0 && o.curve !== 'step', glow: focus === s.key });
          ctx.series.push({ key: s.key, label: seriesLabel(s), color: s.color, val: u => valueAt(s.q, u, o.qx), y: u => { const v = valueAt(P, u, o.qx); return v == null ? null : F.Y(v); } });
        }
      }
      if (o.avg && mode === 'overlay') {
        for (const [k, a] of D.agg) {
          const P = quantize(a.mean, o.qx, o.qy);
          drawSeries(g, P, F, { color: a.color, width: lineW * 1.9 + 1.5, dash: dashFor(a.dash, lineW * 1.9 + 1.5), curve: o.curve === 'ink' ? 'smooth' : o.curve, qx: o.qx, pid, key: 'avg:' + k, halo: true, opacity: focus && focus !== k ? 0.25 : 1 });
          const end = P[P.length - 1];
          const right = end && F.X(end[0]) > F.pl + F.pw - 90;
          if (end && D.agg.size <= 8) g.append(txt(F.X(end[0]) + (right ? -4 : 6), F.Y(end[1]) + (right ? -9 : 4), `${k === 'All' ? 'mean' : k} · n${a.n}`, { fill: a.color, 'font-size': 11, 'font-weight': 700, 'pointer-events': 'none', 'paint-order': 'stroke', stroke: T.card, 'stroke-width': 3, 'text-anchor': right ? 'end' : 'start' }));
          ctx.series.push({ key: 'avg:' + k, label: `⌀ ${k}`, color: a.color, avg: true, val: u => valueAt(P, u, o.qx), y: u => { const v = valueAt(P, u, o.qx); return v == null ? null : F.Y(v); } });
        }
      }
      svg.append(g);
    }
    const hov = sv('g', { class: 'hover', 'pointer-events': 'none' }), play = sv('g', { class: 'playhead', 'pointer-events': 'none' });
    svg.append(hov, play);
    Object.assign(ctx, { hov, play });
    host.append(svg);
    return ctx;
  }

  function seriesLabel(s) {
    const m = s.map.meta;
    return [m.participant || m.title, sessionLabel(m.session, 'S'), s.line.name].filter(Boolean).join(' · ');
  }

  /* ---------- hover / playhead overlays ---------- */

  function cursor(ctx, g, u, opts = {}) {
    const T = Theme.t(), F = ctx.F;
    g.innerHTML = '';
    if (u == null || u < 0 || u > 1) return [];
    const x = F.X(u);
    g.append(sv('line', { x1: x, x2: x, y1: F.pt, y2: F.pt + F.ph, stroke: opts.color || T.text, 'stroke-width': opts.width || 1, opacity: opts.opacity ?? 0.45, 'stroke-dasharray': opts.dash || '' }));
    const vals = [];
    for (const s of ctx.series) {
      const y = s.y(u), v = s.val(u);
      if (y == null || v == null) continue;
      vals.push({ s, v, y });
      g.append(sv('circle', { cx: x, cy: y, r: opts.r || (s.avg ? 5 : 3.6), fill: s.color, stroke: T.card, 'stroke-width': 1.5 }));
    }
    if (opts.labels) {
      for (const { s, v, y } of vals) g.append(txt(x + 8, y - 6, fmtY(ctx.axes, v), { fill: s.color, 'font-size': 11, 'font-weight': 700, 'paint-order': 'stroke', stroke: T.card, 'stroke-width': 3, 'font-family': 'JetBrains Mono, monospace' }));
    }
    g.append(txt(x, F.pt + F.ph - 5, fmtX(ctx.axes, u), { fill: T.muted, 'font-size': 10, 'text-anchor': x > F.pl + F.pw - 40 ? 'end' : 'middle', 'font-family': 'JetBrains Mono, monospace', 'paint-order': 'stroke', stroke: T.card, 'stroke-width': 3 }));
    return vals;
  }

  return {
    effective, normalize, quantize, valueAt, aggregate, stats, similarity, toX, toY, fmtX, fmtY,
    frame, renderMap, renderLens, lensData, lensMaps, fieldValue, seriesLabel, cursor, pathFor, dashFor, DASH_NAMES,
  };
})();

/* =====================================================================
   Sound — each visible line becomes a voice (pitch = value)
   ===================================================================== */
/** Effect sliders for graph sound, 0 = off … 1 = intense; one setting for every graph. */
const SOUND_FX = [['gain', 'Emphasis'], ['bright', 'Brightness'], ['space', 'Space'], ['delay', 'Delay']];
const Sound = {
  ctx: null, master: null, fx: null, voices: [], shaped: null,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      const c = this.ctx = new AC();
      this.master = c.createGain(); this.master.gain.value = 0.55;
      const comp = c.createDynamicsCompressor();
      this.master.connect(comp); comp.connect(c.destination);
      // voices → emphasis → brightness (saturation adds overtones) → dry + reverb + delay
      const emph = c.createGain(), shape = c.createWaveShaper(), send = c.createGain(), verb = c.createConvolver();
      const echoIn = c.createGain(), echo = c.createDelay(1), echoTone = c.createBiquadFilter(), echoBack = c.createGain();
      shape.oversample = '2x'; send.gain.value = 0; echoIn.gain.value = 0; echo.delayTime.value = 0.32; echoBack.gain.value = 0;
      echoTone.type = 'lowpass'; echoTone.frequency.value = 3500;
      const len = Math.round(c.sampleRate * 2.6), ir = c.createBuffer(2, len, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3; }
      verb.buffer = ir;
      emph.connect(shape); shape.connect(this.master); shape.connect(send); send.connect(verb); verb.connect(this.master);
      shape.connect(echoIn); echoIn.connect(echo); echo.connect(echoTone); echoTone.connect(echoBack); echoBack.connect(echo); echo.connect(this.master);
      this.fx = { emph, shape, send, echoIn, echoBack };
      this.applyFx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  },
  /** Set the effects from the sliders (S.settings.soundFx). */
  applyFx() {
    if (!this.fx) return;
    const v = { gain: 0, bright: 0, space: 0, delay: 0, ...S.settings.soundFx }, t = this.ctx.currentTime, f = this.fx;
    f.emph.gain.setTargetAtTime(10 ** (v.gain * 9 / 20), t, 0.05);
    if (this.shaped !== v.bright) {
      this.shaped = v.bright;
      const k = v.bright * 12, n = 1024, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; curve[i] = k ? Math.tanh(x * (1 + k)) / Math.tanh(1 + k) : x; }
      f.shape.curve = curve;
    }
    f.send.gain.setTargetAtTime(v.space * 0.9, t, 0.05);
    f.echoIn.gain.setTargetAtTime(v.delay * 0.7, t, 0.05);
    f.echoBack.gain.setTargetAtTime(v.delay * 0.62, t, 0.05);
  },
  voicesFor(n) {
    const c = this.ctx;
    while (this.voices.length < n) {
      const o = c.createOscillator(), g = c.createGain(), p = c.createStereoPanner ? c.createStereoPanner() : null;
      o.type = 'triangle'; g.gain.value = 0;
      o.connect(g); (p ? (g.connect(p), p.connect(this.fx.emph)) : g.connect(this.fx.emph));
      o.start();
      this.voices.push({ o, g, p });
    }
    while (this.voices.length > n) { const v = this.voices.pop(); v.g.gain.setTargetAtTime(0, c.currentTime, 0.03); v.o.stop(c.currentTime + 0.2); }
  },
  /** vals: array of values 0..1 or null */
  play(vals) {
    if (!this.ensure()) return;
    const list = vals.slice(0, 8);
    this.voicesFor(list.length);
    const t = this.ctx.currentTime, gain = 0.16 / Math.sqrt(Math.max(1, list.length));
    list.forEach((v, i) => {
      const vc = this.voices[i];
      if (v == null) { vc.g.gain.setTargetAtTime(0, t, 0.04); return; }
      vc.o.frequency.setTargetAtTime(150 * Math.pow(2, v * 2.6), t, 0.025);
      vc.g.gain.setTargetAtTime(gain, t, 0.04);
      if (vc.p) vc.p.pan.setTargetAtTime(list.length > 1 ? -0.8 + 1.6 * i / (list.length - 1) : 0, t, 0.05);
    });
  },
  silence() { if (!this.ctx) return; for (const v of this.voices) v.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); },
  stop() { if (!this.ctx) return; this.voicesFor(0); },
};

/* =====================================================================
   Player — animated playhead sweeping a map or lens
   ===================================================================== */
const Player = {
  cur: null,
  toggle(id) { if (this.cur?.id === id) this.stop(); else this.start(id); },
  start(id) {
    this.stop();
    const it = getItem(id);
    if (!it) return;
    this.cur = { id, t0: performance.now() };
    if (this.opts(it).sound) Sound.ensure();
    Board.node(id)?.classList.add('playing');
    const step = () => {
      const c = this.cur;
      if (!c || c.id !== id) return;
      const item = getItem(id), host = Board.node(id)?.querySelector('.plot');
      const ctx = host?._ctx;
      if (!item || !ctx) return this.stop();
      const o = this.opts(item);
      let u = (performance.now() - c.t0) / ((o.dur || 8) * 1000);
      if (u > 1) { c.t0 = performance.now(); u = 0; }
      const vals = Plot.cursor(ctx, ctx.play, u, { color: Theme.t().accent, width: 2, opacity: 0.9, r: 5.5, labels: ctx.kind === 'map' });
      if (o.sound) {
        const pick = ctx.series.some(s => s.avg) && ctx.series.length > 8 ? ctx.series.filter(s => s.avg) : ctx.series;
        Sound.play(pick.slice(0, 8).map(s => s.val(u)));
      }
      ctx._playU = u;
      Board.onPlay?.(ctx, vals);
      c.raf = requestAnimationFrame(step);
    };
    this.cur.raf = requestAnimationFrame(step);
  },
  opts(it) { return it.type === 'lens' ? it.opts : it.view; },
  stop() {
    if (!this.cur) return;
    cancelAnimationFrame(this.cur.raf);
    const n = Board.node(this.cur.id);
    n?.classList.remove('playing');
    const ctx = n?.querySelector('.plot')?._ctx;
    if (ctx?.play) ctx.play.innerHTML = '';
    this.cur = null;
    Sound.silence();
  },
};
