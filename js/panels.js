'use strict';
/* =====================================================================
   Tracefield · panels
   form helpers, inspector (right), library (left), template + help
   ===================================================================== */

const UI = {
  secs: new Map(), open: new Set(),
  field(label, ...kids) { return el('label', { class: 'field' }, el('span', { class: 'f-l' }, label), ...kids); },
  text(val, on, attrs = {}) { return el('input', { type: 'text', value: val ?? '', ...attrs, oninput: e => on(e.target.value), onchange: () => commit() }); },
  num(val, on, attrs = {}) { return el('input', { type: 'number', value: val ?? 0, step: 'any', ...attrs, oninput: e => { if (e.target.value !== '') on(+e.target.value); }, onchange: () => commit() }); },
  area(val, on, attrs = {}) { return el('textarea', { value: val ?? '', ...attrs, oninput: e => on(e.target.value), onchange: () => commit() }); },
  range(val, min, max, step, on, fmt = v => v) {
    const out = el('output', {}, fmt(val));
    return el('div', { class: 'range' },
      el('input', { type: 'range', min, max, step, value: val, oninput: e => { const v = +e.target.value; out.textContent = fmt(v); on(v); }, onchange: () => commit() }), out);
  },
  select(val, opts, on) { return el('select', { value: String(val), onchange: e => { on(e.target.value); commit(); } }, opts.map(([v, l]) => el('option', { value: v }, l))); },
  seg(val, opts, on) {
    const w = el('div', { class: 'seg' });
    for (const [v, l, t] of opts) w.append(el('button', { class: v === val ? 'on' : '', title: t || '', type: 'button', onclick: e => { $$('button', w).forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); on(v); commit(); } }, l));
    return w;
  },
  check(val, label, on) { return el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: val, onchange: e => { on(e.target.checked); commit(); } }), el('span', {}, label)); },
  color(val, on) { return el('input', { type: 'color', value: val || '#888888', oninput: e => on(e.target.value), onchange: () => commit() }); },
  section(title, kids, open = true) {
    const key = title.replace(/\s*\(.*\)$/, '');
    const d = el('details', { class: 'sec', open: UI.secs.has(key) ? UI.secs.get(key) : open }, el('summary', {}, title), el('div', { class: 'sec-b' }, kids));
    d.addEventListener('toggle', () => UI.secs.set(key, d.open));
    return d;
  },
  btn(label, icon, on, cls = '') { return el('button', { class: 'btn ' + cls, type: 'button', onclick: on, html: (icon ? ic(icon) : '') + `<span>${esc(label)}</span>` }); },
  row(...kids) { return el('div', { class: 'row' }, ...kids); },
  hint(t) { return el('p', { class: 'hint' }, t); },
  swatches(val, colors, on) {
    return el('div', { class: 'swatches' }, colors.map(c => el('button', { type: 'button', class: c === val ? 'on' : '', style: { background: c }, title: c, onclick: e => { $$('button', e.currentTarget.parentNode).forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); on(c); } })),
      el('input', { type: 'color', value: val || '#888888', title: 'Custom', oninput: e => on(e.target.value), onchange: () => commit() }));
  },
  tags(list, onChange) {
    const tags = [...(list || [])];
    const box = el('div', { class: 'tags-input' });
    const input = el('input', { type: 'text', placeholder: tags.length ? '' : 'add tag, press Enter', list: 'dl-tags' });
    const draw = () => {
      box.innerHTML = '';
      tags.forEach((t, i) => box.append(el('span', { class: 'tag-chip', style: { '--tc': colorFor('tag', t) } }, '#' + t, el('button', { type: 'button', title: 'Remove', onclick: () => { tags.splice(i, 1); onChange([...tags]); draw(); } }, '×'))));
      box.append(input);
    };
    const addTag = () => {
      const v = input.value.trim().replace(/^#/, '').replace(/,+$/, '');
      if (v && !tags.includes(v)) { tags.push(v); onChange([...tags]); }
      input.value = ''; draw(); input.focus();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); }
      else if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); onChange([...tags]); draw(); input.focus(); }
    });
    input.addEventListener('change', () => { if (input.value.trim()) addTag(); });
    draw();
    return box;
  },
  spark(pts, color, w = 64, h = 20) {
    const s = sv('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, class: 'spark' });
    if (pts.length > 1) s.append(sv('polyline', { points: pts.filter((_, i) => i % 3 === 0 || i === pts.length - 1).map(([u, v]) => `${(u * w).toFixed(1)},${((1 - v) * (h - 2) + 1).toFixed(1)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
    return s;
  },
};

const COLOR_BY = [['line', 'Line (key)'], ['participant', 'Participant'], ['session', 'Test / session'], ['condition', 'Condition'], ['map', 'Map'], ['tag', 'First tag'], ['ink', 'Line’s own colour'], ['single', 'Single colour']];
const GROUP_BY = [['line', 'Line (key)'], ['all', 'Everything'], ['participant', 'Participant'], ['session', 'Test / session'], ['condition', 'Condition'], ['tag', 'First tag'], ['map', 'Map']];
const CURVES = [['smooth', 'Smooth'], ['linear', 'Linear'], ['step', 'Step'], ['points', 'Dots'], ['ink', 'Ink']];
const QY = [['0', 'Off'], ['3', '3 levels'], ['4', '4 levels'], ['5', '5 (Likert)'], ['7', '7 levels'], ['10', '10 levels'], ['11', '11 (0–10)']];
const pct = v => Math.round(v * 100) + '%';

function datalists() {
  const maps = itemsOf('map'), uniq = f => [...new Set(maps.map(f).filter(Boolean))];
  const dl = (id, vals) => el('datalist', { id }, vals.map(v => el('option', { value: v })));
  return el('div', { hidden: true },
    dl('dl-participants', uniq(m => m.meta.participant)), dl('dl-conditions', uniq(m => m.meta.condition)),
    dl('dl-tags', allTags().map(t => t[0])), dl('dl-keys', [...new Set(maps.flatMap(m => m.lines.map(l => l.key)))]));
}

/* =====================================================================
   Inspector
   ===================================================================== */
const Inspector = (() => {
  let root;
  function init() { root = $('#insp-body'); }

  function show() {
    if (!root) return;
    const st = root.scrollTop, ids = Board.selection();
    root.innerHTML = '';
    let kids;
    if (Atlas.active) kids = Atlas.form();
    else if (!ids.length) kids = overview();
    else if (ids.length > 1) kids = multi(ids.map(getItem).filter(Boolean));
    else { const it = getItem(ids[0]); kids = it ? (forms[it.type]?.(it) || []) : []; }
    root.append(datalists(), ...kids.filter(Boolean));
    root.scrollTop = st;
  }

  function head(color, kind, title, sub) {
    return el('div', { class: 'insp-head' }, el('span', { class: 'swatch big', style: { background: color } }),
      el('div', {}, el('small', {}, kind), el('h3', {}, title), sub && el('p', {}, sub)));
  }

  function axesForm(a, up, withActions) {
    const t = (k, ph) => UI.text(a[k], x => { a[k] = x; up(); }, { placeholder: ph });
    const n = k => UI.num(a[k], x => { a[k] = x; up(); });
    return [
      el('div', { class: 'axes-grid' },
        el('div', {}, el('h5', {}, 'Y axis ↑'), UI.field('Top label', t('yHigh', 'Loud')), UI.field('Bottom label', t('yLow', 'Subtle')), UI.field('Title', t('yTitle', 'Intensity')),
          UI.row(UI.field('Min', n('yMin')), UI.field('Max', n('yMax'))), UI.field('Unit', t('yUnit', '%'))),
        el('div', {}, el('h5', {}, 'X axis →'), UI.field('Start label', t('xStart', 'Blindfold on')), UI.field('End label', t('xEnd', 'Blindfold off')), UI.field('Title', t('xTitle', 'Time')),
          UI.row(UI.field('Min', n('xMin')), UI.field('Max', n('xMax'))), UI.field('Unit', t('xUnit', 'min')))),
      withActions && UI.row(
        UI.btn('Save as template', 'template', () => { S.template = { ...(S.template || {}), axes: clone(a) }; commit(); toast('Template axes saved — new imports use them.'); }, 'ghost'),
        UI.btn('Apply to all maps', 'copy', () => { for (const m of itemsOf('map')) { m.axes = clone(a); Board.refresh(m.id, false); } itemsOf('lens').forEach(l => Board.refresh(l.id, false)); commit(); toast('Axes applied to every map.'); }, 'ghost')),
    ];
  }

  /* ---------- map ---------- */
  function linesEditor(it) {
    const up = () => Board.refreshSoon(it.id);
    const rows = it.lines.map((ln, i) => {
      const adj = ln.adj || (ln.adj = { dy: 0, sy: 1, smooth: 0 });
      const sp = UI.spark(Plot.effective(ln), ln.color);
      const updSpark = () => { const n = UI.spark(Plot.effective(ln), ln.color); sp.replaceWith(n); };
      let lastName = ln.name;
      const more = el('div', { class: 'ln-more', hidden: !UI.open.has(ln.id) },
        UI.field('Compare key — lines with the same key are averaged together', UI.text(ln.key, x => { ln.key = x; up(); }, { placeholder: 'e.g. Line 1 / Sound', list: 'dl-keys' })),
        UI.field('Shift', UI.range(adj.dy, -0.5, 0.5, 0.01, x => { adj.dy = x; up(); }, x => (x > 0 ? '+' : '') + Math.round(x * 100) + '%')),
        UI.field('Scale', UI.range(adj.sy, 0, 2, 0.01, x => { adj.sy = x; up(); }, x => '×' + x.toFixed(2))),
        UI.field('Smooth', UI.range(adj.smooth, 0, 24, 1, x => { adj.smooth = x; up(); }, x => (x ? x + ' pts' : 'off'))),
        UI.row(
          UI.btn('Bake', 'check', () => { ln.pts = Plot.effective(ln).map(p => [round(p[0]), round(p[1])]); ln.adj = { dy: 0, sy: 1, smooth: 0 }; Board.refresh(it.id); commit(); show(); }, 'ghost'),
          UI.btn('Redraw', 'sculpt', () => Board.setEdit({ id: it.id, mode: 'redraw', r: 0.09, line: ln.id }), 'ghost'),
          UI.btn('Delete', 'trash', () => { it.lines.splice(i, 1); Board.refresh(it.id); commit(); show(); }, 'ghost danger')));
      return el('div', { class: 'ln' + (ln.visible ? '' : ' off') },
        el('div', { class: 'ln-row' },
          UI.color(ln.color, c => { ln.color = c; up(); updSpark(); }),
          el('input', { type: 'text', class: 'ln-name', value: ln.name, oninput: e => { if (ln.key === lastName) ln.key = e.target.value; ln.name = lastName = e.target.value; up(); }, onchange: () => commit() }),
          sp,
          iconBtn(ln.visible ? 'eye' : 'eye-off', 'Show / hide', ln.visible, () => { ln.visible = !ln.visible; Board.refresh(it.id); commit(); show(); }),
          iconBtn('sliders', 'Key, shift, scale, smooth…', UI.open.has(ln.id), e => { UI.open.has(ln.id) ? UI.open.delete(ln.id) : UI.open.add(ln.id); more.hidden = !more.hidden; e.currentTarget.classList.toggle('on'); })),
        more);
    });
    return [
      ...rows,
      !it.lines.length && UI.hint('No lines. Draw one by hand, or re-digitize the scan.'),
      UI.row(
        UI.btn('Draw new line', 'plus', () => Board.setEdit({ id: it.id, mode: 'new', r: 0.09 }), 'ghost'),
        it.lines.length > 0 && UI.btn('Copy names & colours to all maps', 'copy', () => {
          for (const m of itemsOf('map')) if (m !== it) m.lines.forEach((l, i) => { const src = it.lines[i]; if (src) { l.name = src.name; l.key = src.key; l.color = src.color; } });
          S.items.forEach(m => (m.type === 'map' || m.type === 'lens') && Board.refresh(m.id, false));
          commit(); toast('Line names, keys and colours copied by position.');
        }, 'ghost')),
    ];
  }

  function readings(it) {
    const a = it.axes;
    const rows = it.lines.filter(l => l.visible).map(ln => {
      const s = Plot.stats(Plot.effective(ln));
      if (!s) return null;
      const d = s.end - s.start;
      return el('tr', {},
        el('td', {}, el('i', { class: 'dot', style: { background: ln.color } }), ln.name),
        el('td', {}, fmtNum(Plot.toY(a, s.mean))),
        el('td', {}, `${fmtNum(Plot.toY(a, s.max))} @ ${fmtNum(Plot.toX(a, s.maxU))}`),
        el('td', {}, fmtNum(Plot.toY(a, s.min))),
        el('td', {}, s.peaks),
        el('td', { class: d >= 0 ? 'up' : 'down' }, (d >= 0 ? '▲ ' : '▼ ') + fmtNum(Math.abs(d) * (a.yMax - a.yMin))));
    });
    return [
      el('table', { class: 'stats' }, el('thead', {}, el('tr', {}, ['Line', 'Mean', 'Peak @ X', 'Low', 'Peaks', 'Start→end'].map(h => el('th', {}, h)))), el('tbody', {}, rows)),
      UI.hint('Values are in your axis units. “Peaks” counts rises of more than 8% of the Y range.'),
    ];
  }

  function mapForm(it) {
    const m = it.meta, v = it.view;
    const up = () => Board.refreshSoon(it.id), upLib = () => { up(); Library.render(); };
    return [
      head(it.color, 'Map', m.title || 'Untitled map', it.asset ? 'Digitized from a scan' : 'Drawn by hand'),
      UI.section('Identity', [
        UI.field('Title', UI.text(m.title, x => { m.title = x; upLib(); })),
        UI.row(UI.field('Participant', UI.text(m.participant, x => { m.participant = x; upLib(); }, { placeholder: 'P01', list: 'dl-participants' })),
          UI.field('Test / session', UI.text(m.session, x => { m.session = x; upLib(); }, { placeholder: '1' }))),
        UI.row(UI.field('Condition', UI.text(m.condition, x => { m.condition = x; upLib(); }, { placeholder: 'e.g. blindfold', list: 'dl-conditions' })),
          UI.field('Date', el('input', { type: 'date', value: m.date || '', oninput: e => { m.date = e.target.value; }, onchange: () => commit() }))),
        UI.field('Tags', UI.tags(m.tags, t => { m.tags = t; upLib(); commit(); })),
        UI.field('Notes', UI.area(m.notes, x => { m.notes = x; }, { rows: 3, placeholder: 'Observations, quotes, context…' })),
        UI.field('Card colour', UI.swatches(it.color, PALETTE, c => { it.color = c; up(); Library.render(); commit(); })),
      ]),
      UI.section(`Lines (${it.lines.length})`, linesEditor(it)),
      UI.section('Display', [
        UI.field('Curve', UI.seg(v.curve, CURVES, x => { v.curve = x; up(); })),
        UI.field('Quantize X — average into steps', UI.range(v.qx, 0, 48, 1, x => { v.qx = x; up(); }, x => (x ? `${x} steps` : 'off (raw)'))),
        UI.field('Quantize Y — snap to levels', UI.select(v.qy, QY, x => { v.qy = +x; up(); })),
        UI.field('Stroke', UI.range(v.width, 1, 8, 0.2, x => { v.width = x; up(); }, x => x.toFixed(1))),
        it.asset && UI.field('Scan ghost underneath', UI.range(v.ghost, 0, 1, 0.01, x => { v.ghost = x; up(); }, pct)),
        UI.row(UI.check(v.points, 'Points', x => { v.points = x; up(); }), UI.check(v.grid, 'Grid', x => { v.grid = x; up(); }), UI.check(v.ticks, 'Values', x => { v.ticks = x; up(); })),
      ]),
      UI.section('Sound', soundForm(it, v), false),
      UI.section('Axes & calibration', axesForm(it.axes, up, true), false),
      UI.section('Readings', readings(it)),
      UI.section('Actions', [el('div', { class: 'btn-grid' },
        it.asset && UI.btn('Re-digitize', 'wand', () => Digitizer.open({ mapId: it.id })),
        UI.btn('Edit lines', 'sculpt', () => Board.setEdit({ id: it.id, mode: 'sculpt', r: 0.09 })),
        UI.btn('Compare in lens', 'lens', () => App.compare([it.id])),
        UI.btn('Export CSV', 'download', () => App.exportCSV([it])),
        UI.btn('Export PNG', 'download', () => App.exportPNG(it.id)),
        UI.btn('Duplicate', 'copy', () => Board.duplicate([it.id])),
        UI.btn('Delete', 'trash', () => Board.remove([it.id]), 'danger'))]),
    ];
  }

  /** Sonify toggle + sweep for this graph, then the effect sliders, which every graph shares. */
  function soundForm(it, o) {
    return [
      UI.check(o.sound, 'Sonify — hear each line as a pitch', x => { o.sound = x; x ? Sound.ensure() : Sound.silence(); Board.refresh(it.id, false); }),
      UI.field('Playhead sweep', UI.range(o.dur, 2, 40, 1, x => { o.dur = x; }, x => x + ' s')),
      ...soundFx(),
    ];
  }
  function soundFx() {
    const fx = S.settings.soundFx;
    return [
      UI.hint('Effects for every graph’s sound.'),
      SOUND_FX.map(([k, label]) => UI.field(label, UI.range(fx[k] || 0, 0, 1, 0.01, x => { fx[k] = x; Sound.applyFx(); }, x => (x ? (x === 1 ? 'Intense' : pct(x)) : 'Off')))),
    ];
  }

  /* ---------- lens ---------- */
  function legend(it, D) {
    const o = it.opts;
    if (o.colorBy === 'ink' || o.colorBy === 'single') return null;
    const seen = new Map();
    for (const s of D.series) if (!seen.has(s.cval)) seen.set(s.cval, s);
    if (!seen.size) return null;
    return el('div', { class: 'legend' }, el('span', { class: 'f-l' }, 'Colour codes — click a name to hide it'), [...seen.entries()].map(([v, s]) => {
      const mk = o.colorBy + ':' + v, muted = !!it.mute?.[mk];
      const col = o.colorBy === 'map' ? s.map.color : colorFor(o.colorBy, v);
      return el('div', { class: 'lg' + (muted ? ' off' : '') },
        UI.color(col, c => {
          if (o.colorBy === 'map') { s.map.color = c; Board.refreshSoon(s.map.id); } else S.colorRules[o.colorBy][v] = c;
          itemsOf('lens').forEach(l => Board.refreshSoon(l.id));
          if (o.colorBy === 'participant') { itemsOf('map').forEach(m => Board.fill(m)); Library.render(); }
        }),
        el('button', { type: 'button', class: 'lg-l', onclick: () => { it.mute = it.mute || {}; muted ? delete it.mute[mk] : (it.mute[mk] = true); Board.refresh(it.id, false); commit(); show(); } }, v));
    }));
  }
  /** Colour + dash per average line, kept on this lens. */
  function avgStyles(it, D) {
    const o = it.opts;
    if (!o.avg || !D.agg.size) return null;
    const set = (k, g, v) => { (o[k] = o[k] || {})[g] = v; Board.refreshSoon(it.id); };
    return el('div', { class: 'legend' }, el('span', { class: 'f-l' }, 'Average lines'), [...D.agg].map(([g, a]) => el('div', { class: 'lg' },
      UI.color(a.color, c => set('avgColor', g, c)),
      el('span', { class: 'lg-l' }, g),
      el('select', { class: 'mini-select', value: String(a.dash % Plot.DASH_NAMES.length), onchange: e => { set('avgDash', g, +e.target.value); commit(); } }, Plot.DASH_NAMES.map((n, i) => el('option', { value: i }, n))))));
  }

  function insights(it, D) {
    const a = Plot.lensMaps(it)[0]?.axes || defaultAxes();
    if (!D.agg.size) return [UI.hint('Add maps to see group statistics.')];
    const rows = [], notes = [];
    let tight = null, loose = null;
    for (const [g, ag] of D.agg) {
      const st = Plot.stats(ag.mean);
      if (!st) continue;
      const spread = ag.rows.reduce((s, r) => s + r.sd, 0) / ag.rows.length;
      if (ag.n > 1) { if (!tight || spread < tight[1]) tight = [g, spread]; if (!loose || spread > loose[1]) loose = [g, spread]; }
      rows.push(el('tr', {}, el('td', {}, el('i', { class: 'dot', style: { background: ag.color } }), g), el('td', {}, ag.n), el('td', {}, fmtNum(Plot.toY(a, st.mean))),
        el('td', {}, `${fmtNum(Plot.toY(a, st.max))} @ ${fmtNum(Plot.toX(a, st.maxU))}`), el('td', {}, ag.n > 1 ? '±' + fmtNum(spread * (a.yMax - a.yMin)) : '–')));
    }
    // series that stray furthest from their group's average
    const dev = [];
    for (const s of D.series) {
      if (!s.on) continue;
      const ag = D.agg.get(s.group);
      if (!ag || ag.n < 3) continue;
      const sim = Plot.similarity(s.pts, ag.mean);
      if (sim) dev.push([s, sim.mae]);
    }
    dev.sort((x, y) => y[1] - x[1]);
    if (tight && loose && tight[0] !== loose[0]) notes.push(`Strongest agreement: <b>${esc(tight[0])}</b> (spread ±${fmtNum(tight[1] * (a.yMax - a.yMin))}). Least: <b>${esc(loose[0])}</b> (±${fmtNum(loose[1] * (a.yMax - a.yMin))}).`);
    for (const [s, mae] of dev.slice(0, 3)) notes.push(`<b>${esc(Plot.seriesLabel(s))}</b> strays ${fmtNum(mae * (a.yMax - a.yMin))} from its group on average.`);
    return [
      el('table', { class: 'stats' }, el('thead', {}, el('tr', {}, ['Group', 'n', 'Mean', 'Peak @ X', 'Spread'].map(h => el('th', {}, h)))), el('tbody', {}, rows)),
      notes.length && el('ul', { class: 'insights' }, notes.map(n => el('li', { html: n }))),
      dev.length > 0 && UI.btn('Spotlight the biggest outlier', 'sparkle', () => { it.focus = dev[0][0].key; Board.redrawPlot(it.id); }, 'ghost'),
    ];
  }

  function matrix(it, D) {
    const o = it.opts;
    const useGroups = o.matrix === 'groups';
    const items = useGroups
      ? [...D.agg.entries()].map(([g, a]) => ({ key: g, label: g, color: a.color, pts: a.mean }))
      : D.series.filter(s => s.on).slice(0, 28).map(s => ({ key: s.key, label: Plot.seriesLabel(s), color: s.color, pts: s.pts }));
    const n = items.length;
    const toggle = UI.seg(o.matrix || 'series', [['series', 'Each line'], ['groups', 'Group averages']], x => { o.matrix = x; show(); });
    if (n < 2) return [toggle, UI.hint('Needs at least two lines.')];
    const grid = el('div', { class: 'matrix', style: { gridTemplateColumns: `minmax(70px, 120px) repeat(${n}, 1fr)` } });
    grid.append(el('span'));
    items.forEach((x, i) => grid.append(el('span', { class: 'mx-h', title: x.label, style: { color: x.color } }, String(i + 1))));
    const T = Theme.t();
    items.forEach((a, i) => {
      grid.append(el('span', { class: 'mx-l', title: a.label }, el('i', { class: 'dot', style: { background: a.color } }), `${i + 1}. ${a.label}`));
      items.forEach((b, j) => {
        if (i === j) { grid.append(el('span', { class: 'mx-c self' })); return; }
        const s = Plot.similarity(a.pts, b.pts);
        const k = s ? clamp((s.sim - 0.6) / 0.4, 0, 1) : 0;
        grid.append(el('button', {
          type: 'button', class: 'mx-c', style: { background: s ? rgba(T.accent, 0.08 + k * 0.85) : 'transparent' },
          title: s ? `${a.label} ↔ ${b.label}\nsimilarity ${pct(s.sim)} · r = ${s.r.toFixed(2)} · overlap ${pct(s.overlap)}` : `${a.label} ↔ ${b.label}\ntoo little overlap`,
          onclick: () => { it.focus = useGroups ? a.key : a.key; Board.redrawPlot(it.id); },
        }));
      });
    });
    return [toggle, grid, UI.hint('Brighter = more alike (1 − mean absolute difference over the shared X range). Hover a cell for Pearson r.')];
  }

  function sortLens(it, by) {
    if (!by) return;
    const key = m => {
      const st = () => { const all = m.lines.filter(l => l.visible).map(l => Plot.stats(Plot.effective(l))).filter(Boolean); return all; };
      switch (by) {
        case 'mean': return -(st().reduce((s, x) => s + x.mean, 0) / (st().length || 1));
        case 'peak': return -Math.max(0, ...st().map(x => x.max));
        default: return String(m.meta[by] || '').padStart(by === 'session' ? 6 : 0, '0').toLowerCase();
      }
    };
    it.maps.sort((a, b) => { const ka = key(getItem(a)), kb = key(getItem(b)); return ka < kb ? -1 : ka > kb ? 1 : 0; });
    Board.refresh(it.id, false); commit(); show();
  }

  function lensForm(it) {
    const o = it.opts, up = () => Board.refreshSoon(it.id), upx = () => { up(); show(); };
    const D = Plot.lensData(it);
    const tags = allTags();
    const tf = it.tagFilter || (it.tagFilter = []);
    return [
      head(Theme.t().accent, 'Lens', it.title || 'Lens', `${D.maps.length} maps · ${D.series.length} lines`),
      UI.field('Title', UI.text(it.title, x => { it.title = x; up(); })),
      UI.section('View', [
        UI.field('Mode', UI.seg(o.mode, [['overlay', 'Overlay'], ['ridge', 'Ridge'], ['heat', 'Heat'], ['dev', 'Deviation']], x => { o.mode = x; upx(); })),
        UI.field('Colour by', UI.select(o.colorBy, COLOR_BY, x => { o.colorBy = x; upx(); })),
        legend(it, D),
        UI.field('Curve', UI.seg(o.curve, CURVES, x => { o.curve = x; up(); })),
        UI.field('Stroke', UI.range(o.width, 0.6, 6, 0.1, x => { o.width = x; up(); }, x => x.toFixed(1))),
        UI.field('Line opacity', UI.range(o.opacity, 0.05, 1, 0.01, x => { o.opacity = x; up(); }, pct)),
        UI.row(UI.check(o.grid, 'Grid', x => { o.grid = x; up(); }), UI.check(o.ticks, 'Values', x => { o.ticks = x; up(); })),
      ]),
      UI.section('Sound', soundForm(it, o), false),
      UI.section('Merge & compare', [
        UI.row(UI.check(o.avg, 'Average line', x => { o.avg = x; up(); }), UI.check(o.showLines, 'Individual lines', x => { o.showLines = x; up(); })),
        UI.field('Average per', UI.select(o.groupBy, GROUP_BY, x => { o.groupBy = x; upx(); })),
        avgStyles(it, D),
        UI.field('Spread band', UI.seg(o.band, [['none', 'None'], ['sd', '±1 SD'], ['minmax', 'Min–max']], x => { o.band = x; up(); })),
        UI.field('Consensus pull — morph lines into their average', UI.range(o.pull, 0, 1, 0.01, x => { o.pull = x; Board.redrawPlot(it.id); }, pct)),
        UI.field('Normalise', UI.select(o.normalize, [['none', 'None (raw)'], ['minmax', 'Stretch each line 0–1'], ['center', 'Centre on own mean'], ['start', 'Align starting values']], x => { o.normalize = x; upx(); })),
        UI.field('Quantize X', UI.range(o.qx, 0, 48, 1, x => { o.qx = x; up(); }, x => (x ? `${x} steps` : 'off (raw)'))),
        UI.field('Quantize Y', UI.select(o.qy, QY, x => { o.qy = +x; up(); })),
      ]),
      UI.section('Scan stack', [
        UI.field('Scan opacity', UI.range(o.under, 0, 1, 0.01, x => { o.under = x; up(); }, x => (x ? pct(x) : 'hidden'))),
        UI.field('Blend', UI.select(o.blend, [['normal', 'Normal'], ['multiply', 'Multiply (ink adds up)'], ['screen', 'Screen'], ['difference', 'Difference (show changes)'], ['exclusion', 'Exclusion'], ['luminosity', 'Luminosity']], x => { o.blend = x; up(); })),
        UI.hint('Each scan is perspective-corrected into the plot box, so different photos line up. Toggle individual scans with the image icon in the layers drawer.'),
      ], false),
      UI.section(`Layers (${it.maps.length})`, [
        UI.field('Order by', UI.select('', [['', 'Manual (drag in drawer)'], ['participant', 'Participant'], ['session', 'Test / session'], ['condition', 'Condition'], ['title', 'Title'], ['date', 'Date'], ['mean', 'Mean level (high→low)'], ['peak', 'Peak level (high→low)']], x => sortLens(it, x))),
        tags.length > 0 && el('div', { class: 'field' }, el('span', { class: 'f-l' }, 'Only maps tagged'), el('div', { class: 'tag-cloud' }, tags.map(([t, c]) =>
          el('button', { type: 'button', class: 'tag-chip' + (tf.includes(t) ? ' on' : ''), style: { '--tc': colorFor('tag', t) }, onclick: () => { const i = tf.indexOf(t); i >= 0 ? tf.splice(i, 1) : tf.push(t); Board.refresh(it.id, false); commit(); show(); } }, `#${t} `, el('small', {}, c))))),
        D.maps.length > 1 && UI.field('Axis labels from', UI.select(it.axesFrom || '', [['', 'First map'], ...D.maps.map(m => [m.id, m.meta.title || m.id])], x => { it.axesFrom = x || null; up(); })),
        el('div', { class: 'btn-grid' },
          UI.btn('Add selected maps', 'plus', () => Board.addToLens(it, Board.selection())),
          UI.btn('Add all maps', 'plus', () => Board.addToLens(it, itemsOf('map').map(m => m.id))),
          it.maps.length > 0 && UI.btn('Remove all', 'x', () => { it.maps = []; it.hidden = {}; Board.refresh(it.id, false); commit(); show(); }, 'danger')),
      ]),
      UI.section('Insights', insights(it, D)),
      UI.section('Similarity matrix', matrix(it, D), false),
      UI.section('Export', [el('div', { class: 'btn-grid' },
        UI.btn('PNG', 'download', () => App.exportPNG(it.id)),
        UI.btn('SVG', 'download', () => App.exportSVG(it.id)),
        UI.btn('CSV + averages', 'download', () => App.exportLensCSV(it)),
        UI.btn('Duplicate', 'copy', () => Board.duplicate([it.id])),
        UI.btn('Delete lens', 'trash', () => Board.remove([it.id]), 'danger'))]),
    ];
  }

  /* ---------- scan / note / text ---------- */
  function scanForm(it) {
    const a = ASSETS.get(it.asset), up = () => Board.refreshSoon(it.id);
    const maps = itemsOf('map').filter(m => m.source === it.id || m.asset === it.asset);
    return [
      head('#e9e4d8', 'Scan', it.name || 'Scan', a ? `${a.w} × ${a.h}px` : 'image missing'),
      el('div', { class: 'btn-grid' }, UI.btn('Digitize', 'wand', () => Digitizer.open({ scanId: it.id }), 'primary'),
        maps.length > 0 && UI.btn(`Go to map${maps.length > 1 ? 's' : ''}`, 'fit', () => { Board.select(maps.map(m => m.id)); Board.fit(maps.map(m => m.id)); })),
      UI.field('Name', UI.text(it.name, x => { it.name = x; up(); })),
      UI.field('Opacity', UI.range(it.opacity ?? 1, 0.05, 1, 0.01, x => { it.opacity = x; up(); }, pct)),
      UI.field('Blend with what’s underneath', UI.select(it.blend || 'normal', [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['difference', 'Difference'], ['darken', 'Darken'], ['luminosity', 'Luminosity']], x => { it.blend = x; up(); })),
      UI.hint('Stack scans on top of each other (select several → right-click → Stack) and lower the opacity or use Difference to compare raw sheets. Pen marks draw on top of everything.'),
      el('div', { class: 'btn-grid' },
        UI.btn('Original aspect', 'fit', () => { if (a) { it.h = Math.round(it.w * a.h / a.w); Board.refresh(it.id); commit(); } }),
        UI.btn('Duplicate', 'copy', () => Board.duplicate([it.id])),
        UI.btn('Delete', 'trash', () => Board.remove([it.id]), 'danger')),
    ];
  }
  function noteForm(it) {
    const up = () => Board.refreshSoon(it.id);
    return [
      head(it.color || 'var(--text)', it.type === 'note' ? 'Note' : 'Text', (it.text || '').slice(0, 40) || 'Empty', it.type === 'note' ? 'Text fits itself to the box · a big note frames what is under it' : 'Double-click on the board to edit the text'),
      UI.field('Text', UI.area(it.text, x => { it.text = x; up(); }, { rows: 4 })),
      UI.field(it.type === 'note' ? 'Colour — border and tint' : 'Colour', UI.swatches(it.color, it.type === 'note' ? NOTE_COLORS : [...PALETTE.slice(0, 6), '#f4f1ea'], c => { it.color = c; up(); commit(); })),
      el('div', { class: 'btn-grid' }, UI.btn('Duplicate', 'copy', () => Board.duplicate([it.id])), UI.btn('Delete', 'trash', () => Board.remove([it.id]), 'danger')),
    ];
  }

  function groupForm(it) {
    const up = () => Board.refreshSoon(it.id), inner = Board.contents(it);
    return [
      head(it.color || NOTE_COLORS[0], 'Frame', it.title || 'Untitled group', `${inner.length} item${inner.length === 1 ? '' : 's'} inside · they move with the frame`),
      UI.field('Title', UI.text(it.title, x => { it.title = x; up(); })),
      UI.field('Tint', UI.swatches(it.color, NOTE_COLORS, c => { it.color = c; up(); commit(); })),
      el('div', { class: 'btn-grid' },
        UI.btn('Fit to contents', 'fit', () => Board.fitGroup(it), 'primary'),
        UI.btn('Select contents', 'select', () => Board.select(inner.map(i => i.id))),
        UI.btn('Ungroup', 'x', () => Board.remove([it.id]), 'danger')),
    ];
  }

  /* ---------- multi-select ---------- */
  function arrange(list) {
    const key = m => [m.type, m.meta?.participant || '', String(m.meta?.session || '').padStart(6, '0'), m.meta?.title || m.name || ''].join('|');
    list = [...list].sort((a, b) => key(a) < key(b) ? -1 : 1);
    const x0 = Math.min(...list.map(i => i.x)), y0 = Math.min(...list.map(i => i.y));
    const cols = Math.ceil(Math.sqrt(list.length)), cw = Math.max(...list.map(i => i.w)) + 36;
    let y = y0;
    for (let r = 0; r * cols < list.length; r++) {
      const row = list.slice(r * cols, (r + 1) * cols);
      row.forEach((it, c) => { it.x = x0 + c * cw; it.y = y; Board.place(it); });
      y += Math.max(...row.map(i => i.h)) + 36;
    }
    Board.drawLinks(); commit();
  }
  function multi(list) {
    const maps = list.filter(i => i.type === 'map'), scans = list.filter(i => i.type === 'scan');
    const counts = Object.entries(list.reduce((m, i) => (m[i.type] = (m[i.type] || 0) + 1, m), {})).map(([t, n]) => `${n} ${t}${n > 1 ? 's' : ''}`).join(' · ');
    const bulk = { participant: '', session: '', condition: '', tag: '' };
    return [
      head(Theme.t().accent, 'Selection', `${list.length} items`, counts),
      el('div', { class: 'btn-grid' },
        maps.length > 0 && UI.btn(`Compare ${maps.length} map${maps.length > 1 ? 's' : ''}`, 'lens', () => App.compare(maps.map(m => m.id)), 'primary'),
        UI.btn('Group in frame', 'frame', () => Board.group(list.map(i => i.id))),
        scans.length > 1 && UI.btn(`Stack ${scans.length} scans`, 'layers', () => App.stackScans(scans)),
        UI.btn('Arrange in grid', 'grid', () => arrange(list)),
        UI.btn('Zoom to', 'fit', () => Board.fit(list.map(i => i.id))),
        UI.btn('Duplicate', 'copy', () => Board.duplicate(list.map(i => i.id))),
        UI.btn('Delete all', 'trash', () => Board.remove(list.map(i => i.id)), 'danger')),
      maps.length > 0 && UI.section(`Bulk label ${maps.length} map${maps.length > 1 ? 's' : ''}`, [
        UI.row(UI.field('Participant', el('input', { type: 'text', placeholder: 'keep', list: 'dl-participants', oninput: e => { bulk.participant = e.target.value; } })),
          UI.field('Test / session', el('input', { type: 'text', placeholder: 'keep', oninput: e => { bulk.session = e.target.value; } }))),
        UI.row(UI.field('Condition', el('input', { type: 'text', placeholder: 'keep', list: 'dl-conditions', oninput: e => { bulk.condition = e.target.value; } })),
          UI.field('Add tag', el('input', { type: 'text', placeholder: 'tag', list: 'dl-tags', oninput: e => { bulk.tag = e.target.value.trim().replace(/^#/, ''); } }))),
        UI.btn('Apply to selected maps', 'check', () => {
          for (const m of maps) {
            for (const k of ['participant', 'session', 'condition']) if (bulk[k]) m.meta[k] = bulk[k];
            if (bulk.tag && !m.meta.tags.includes(bulk.tag)) m.meta.tags.push(bulk.tag);
            Board.refresh(m.id);
          }
          commit(); show(); toast(`Labelled ${maps.length} maps.`);
        }, 'primary'),
      ]),
    ];
  }

  /* ---------- nothing selected ---------- */
  function overview() {
    const c = t => itemsOf(t).length, tags = allTags(), st = S.settings;
    return [
      el('div', { class: 'insp-head' }, el('span', { class: 'logo-mini', html: ic('logo') }), el('div', {}, el('small', {}, 'Board'), el('h3', {}, 'Tracefield'), el('p', {}, 'Select something to inspect it.'))),
      el('div', { class: 'kpis' }, [['Scans', c('scan')], ['Maps', c('map')], ['Lenses', c('lens')], ['Lines', itemsOf('map').reduce((s, m) => s + m.lines.length, 0)]].map(([l, n]) => el('div', { class: 'kpi' }, el('b', {}, n), el('small', {}, l)))),
      el('div', { class: 'btn-grid' },
        UI.btn('Import scans', 'upload', () => App.pickFiles(), 'primary'),
        UI.btn('New lens', 'lens', () => App.newLens()),
        c('map') > 1 && UI.btn('Compare all maps', 'layers', () => App.compare(itemsOf('map').map(m => m.id))),
        UI.btn('Template', 'template', () => Template.open())),
      tags.length > 0 && UI.section('Tags', [el('div', { class: 'tag-cloud' }, tags.map(([t, n]) => el('button', { type: 'button', class: 'tag-chip', style: { '--tc': colorFor('tag', t) }, onclick: () => Library.filterTag(t) }, `#${t} `, el('small', {}, n))))]),
      UI.section('Settings', [
        UI.check(st.autoDigitize, 'Auto-digitize scans on import', x => { st.autoDigitize = x; }),
        UI.check(st.snap, 'Snap cards to grid', x => { st.snap = x; }),
        UI.field('Theme', UI.seg(st.theme, [['dark', 'Night'], ['light', 'Paper']], x => App.setTheme(x))),
      ]),
      UI.section('Graph sound', soundFx(), false),
      UI.section('Moves', [el('ul', { class: 'keys' },
        [['Middle-drag / Space-drag', 'pan the board'], ['Wheel', 'zoom at cursor'], ['Drag map → lens', 'add it to the comparison'], ['G', 'frame the selection'], ['Shift G', 'compare selected maps'], ['Double-click scan', 'digitize'], ['Double-click board', 'note'], ['P / C', 'pen · string between cards'], ['?', 'all shortcuts']]
          .map(([k, d]) => el('li', {}, el('kbd', {}, k), el('span', {}, d))))], false),
    ];
  }

  const forms = { map: mapForm, lens: lensForm, scan: scanForm, note: noteForm, text: noteForm, group: groupForm };
  return { init, show, axesForm };
})();

/* =====================================================================
   Library (left panel)
   ===================================================================== */
const Library = (() => {
  let q = '', group = 'participant', tag = null, root;
  function init() {
    root = $('#lib-list');
    $('#lib-search').addEventListener('input', e => { q = e.target.value.toLowerCase(); render(); });
    $('#lib-search').addEventListener('keydown', e => e.stopPropagation());
    $('#lib-group').addEventListener('change', e => { group = e.target.value; render(); });
  }
  function filterTag(t) { tag = tag === t ? null : t; render(); applyDim(); }
  function applyDim() {
    if (!tag) return Board.highlight(null);
    Board.highlight(new Set(itemsOf('map').filter(m => (m.meta.tags || []).includes(tag)).map(m => m.id)));
  }
  const render = debounce(() => {
    if (!root) return;
    const maps = itemsOf('map').filter(m => {
      const md = m.meta;
      if (tag && !(md.tags || []).includes(tag)) return false;
      if (!q) return true;
      return [md.title, md.participant, md.session && 'test ' + md.session, md.condition, md.notes, ...(md.tags || []), ...m.lines.map(l => l.name)].join(' ').toLowerCase().includes(q);
    });
    const tags = allTags();
    $('#lib-tags').innerHTML = '';
    $('#lib-tags').append(...tags.map(([t, n]) => el('button', { type: 'button', class: 'tag-chip' + (tag === t ? ' on' : ''), style: { '--tc': colorFor('tag', t) }, onclick: () => filterTag(t) }, '#' + t, el('small', {}, n))));
    root.innerHTML = '';
    const groups = new Map();
    for (const m of maps) {
      const g = group === 'none' ? '' : group === 'tag' ? ((m.meta.tags || [])[0] || 'untagged') : group === 'session' ? (sessionLabel(m.meta.session, 'Test ') || 'No test #') : (m.meta[group] || `No ${group}`);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(m);
    }
    const sorted = [...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
    for (const [g, list] of sorted) {
      if (g) root.append(el('div', { class: 'lib-g' }, el('span', {}, group === 'participant' && el('i', { class: 'p-dot', style: { background: participantColor(list[0]) } }), g), el('small', {}, list.length)));
      list.sort((a, b) => String(a.meta.session).localeCompare(String(b.meta.session), undefined, { numeric: true }));
      for (const m of list) {
        const row = el('div', { class: 'lib-row' + (Board.selection().includes(m.id) ? ' on' : ''), draggable: 'true', title: Atlas.active ? 'Click to pin at the map centre · drag onto the map or a point' : 'Click to find · drag onto a lens' },
          el('span', { class: 'swatch', style: { background: m.color } }),
          el('div', { class: 'lib-t' }, el('b', {}, m.meta.title || 'Untitled'), el('small', {}, [m.meta.participant, sessionLabel(m.meta.session, 'Test '), m.meta.condition].filter(Boolean).join(' · ') || '—')),
          el('span', { class: 'lib-lines' }, m.lines.map(l => el('i', { style: { background: l.color }, title: l.name }))));
        row.addEventListener('click', () => { if (Atlas.active) return Atlas.focusItem(m.id); Board.select([m.id]); Board.fit([m.id]); });
        row.addEventListener('dblclick', () => m.asset && Digitizer.open({ mapId: m.id }));
        row.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-tf-map', m.id); e.dataTransfer.effectAllowed = 'copy'; });
        row.addEventListener('mouseenter', () => Board.node(m.id)?.classList.add('hl'));
        row.addEventListener('mouseleave', () => Board.node(m.id)?.classList.remove('hl'));
        root.append(row);
      }
    }
    if (Atlas.active && itemsOf('lens').length) {
      root.append(el('div', { class: 'lib-g' }, 'Lenses', el('small', {}, itemsOf('lens').length)));
      for (const l of itemsOf('lens')) {
        const row = el('div', { class: 'lib-row', draggable: 'true', title: 'Click to pin at the map centre · drag onto the map or a point' },
          el('span', { class: 'lens-ic', html: ic('lens') }), el('div', { class: 'lib-t' }, el('b', {}, l.title || 'Lens'), el('small', {}, `${l.maps.length} maps`)));
        row.addEventListener('click', () => Atlas.focusItem(l.id));
        row.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-tf-map', l.id); e.dataTransfer.effectAllowed = 'copy'; });
        root.append(row);
      }
    }
    if (!maps.length) root.append(el('p', { class: 'muted small pad' }, itemsOf('map').length ? 'Nothing matches.' : 'Digitized maps appear here. Import a scan to begin.'));
    $('#lib-count').textContent = `${maps.length} / ${itemsOf('map').length} maps`;
    applyDim();
  }, 50);
  return { init, render, filterTag };
})();

/* =====================================================================
   Template + Help dialogs
   ===================================================================== */
const Template = {
  open() {
    const t = S.template || (S.template = { axes: defaultAxes(), ink: {} });
    t.axes = t.axes || defaultAxes(); t.ink = t.ink || {};
    const body = $('#template-body');
    body.innerHTML = '';
    body.append(...[
      UI.hint('The template is applied to every new scan: these axis labels and ranges, and these ink settings. Calibrate one sheet in the digitizer and press “Save as template” to fill this in automatically.'),
      ...Inspector.axesForm(t.axes, () => {}, false),
      el('h5', {}, 'Line identities'),
      t.lines?.length
        ? el('div', { class: 'tpl-lines' }, t.lines.map(l => el('div', { class: 'tpl-line' },
            el('i', { style: { background: l.color } }), el('b', {}, l.name),
            el('span', {}, 'ink'), (l.inks || (l.ink ? [[l.ink, 1]] : [])).map(([h]) => el('i', { class: 'ink', style: { background: h }, title: h })))),
          UI.btn('Forget line identities', 'x', () => { delete t.lines; this.open(); }, 'ghost'))
        : UI.hint('None yet. Save a digitized map (or press “Set as template lines” in the digitizer) and new sheets will match their lines to these by ink colour, so names and colours carry over.'),
      el('h5', {}, 'Ink detection defaults'),
      UI.field('Sensitivity', UI.range(t.ink.sens ?? 26, 8, 60, 1, x => { t.ink.sens = x; }, x => x)),
      UI.field('Ignore edge strip', UI.range(t.ink.guard ?? 0.015, 0, 0.08, 0.005, x => { t.ink.guard = x; }, pct)),
      UI.field('Minimum line length', UI.range(t.ink.minSpan ?? 0.2, 0.05, 0.6, 0.01, x => { t.ink.minSpan = x; }, pct)),
      UI.check(S.settings.autoDigitize, 'Auto-digitize scans on import', x => { S.settings.autoDigitize = x; }),
      el('div', { class: 'btn-grid' },
        UI.btn('Apply axes to all maps', 'copy', () => { for (const m of itemsOf('map')) { m.axes = clone(t.axes); Board.refresh(m.id, false); } itemsOf('lens').forEach(l => Board.refresh(l.id, false)); commit(); toast('Template axes applied to every map.'); }),
        UI.btn('Reset template', 'x', () => { S.template = null; commit(); this.open(); }, 'danger')),
    ].flat().filter(Boolean));
    $('#template').hidden = false;
  },
  close() { $('#template').hidden = true; commit(); Inspector.show(); },
};

const Help = {
  open() { $('#help').hidden = false; },
  close() { $('#help').hidden = true; },
};
