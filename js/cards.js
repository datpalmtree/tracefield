'use strict';
/* =====================================================================
   Tracefield · cards
   DOM for every board item type + in-card interactions
   ===================================================================== */

const HEAD = 40, FOOT = 34, DRAWER = 232;

function iconBtn(name, title, on, onclick, cls = '') {
  return el('button', { class: `ibtn ${on ? 'on' : ''} ${cls}`, title, 'aria-label': title, html: ic(name), onclick: e => { e.stopPropagation(); onclick(e); } });
}

/* ---------- hover tooltip for lenses ---------- */
const Tip = {
  node: null,
  show(e, u, vals, ctx) {
    const n = this.node || (this.node = $('#tooltip'));
    if (!vals.length || u < 0 || u > 1) return this.hide();
    vals.sort((a, b) => b.v - a.v);
    const rows = vals.slice(0, 12).map(({ s, v }) =>
      `<div class="tt-row${s.avg ? ' avg' : ''}"><i style="background:${s.color}"></i><span>${esc(s.label)}</span><b>${esc(Plot.fmtY(ctx.axes, v))}</b></div>`).join('');
    n.innerHTML = `<div class="tt-h">${esc(Plot.fmtX(ctx.axes, u))}</div>${rows}${vals.length > 12 ? `<div class="tt-more">+${vals.length - 12} more</div>` : ''}`;
    n.hidden = false;
    const r = n.getBoundingClientRect();
    let x = e.clientX + 18, y = e.clientY + 14;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 18;
    if (y + r.height > innerHeight - 8) y = innerHeight - r.height - 8;
    n.style.transform = `translate(${x}px, ${y}px)`;
  },
  hide() { if (this.node) this.node.hidden = true; },
};

/* ---------- plot interaction shared by maps + lenses ---------- */
function plotLocal(plot, e) {
  const r = plot.getBoundingClientRect(), z = r.width / (plot.offsetWidth || 1) || 1;
  return [(e.clientX - r.left) / z, (e.clientY - r.top) / z];
}

function wirePlot(plot, it) {
  plot.addEventListener('pointermove', e => {
    const ctx = plot._ctx;
    if (!ctx || !ctx.hov) return;
    const [x, y] = plotLocal(plot, e), u = ctx.F.U(x);
    const editing = Board.edit?.id === it.id;
    const vals = Plot.cursor(ctx, ctx.hov, u, { labels: ctx.kind === 'map' && ctx.series.length <= 6 && !editing });
    if (editing) {
      const ed = Board.edit, F = ctx.F;
      ctx.hov.append(sv('ellipse', { cx: x, cy: y, rx: ed.r * F.pw, ry: Math.min(F.ph * 0.5, ed.r * F.pw * 0.6), fill: 'none', stroke: Theme.t().accent, 'stroke-dasharray': '4 4', opacity: 0.8 }));
    }
    if (ctx.kind === 'lens') Tip.show(e, u, vals, ctx);
    const o = it.type === 'lens' ? it.opts : it.view;
    if (o.sound && !Player.cur && u >= 0 && u <= 1) Sound.play(ctx.series.slice(0, 8).map(s => s.val(u)));
  });
  plot.addEventListener('pointerleave', () => {
    if (plot._ctx?.hov) plot._ctx.hov.innerHTML = '';
    Tip.hide();
    if (!Player.cur) Sound.silence();
  });
  if (Board.edit?.id === it.id) plot.addEventListener('pointerdown', e => Editor.down(e, it));
}

/* ---------- line editor (sculpt / redraw / new / erase) ---------- */
const Editor = {
  nearest(it, u, v) {
    let best = null, bd = Infinity;
    for (const ln of it.lines) {
      if (!ln.visible) continue;
      const lv = sampleAt(Plot.effective(ln), u);
      const d = lv == null ? 10 + Math.min(Math.abs(u - (ln.pts[0]?.[0] ?? 0)), Math.abs(u - (ln.pts[ln.pts.length - 1]?.[0] ?? 1))) : Math.abs(lv - v);
      if (d < bd) { bd = d; best = ln; }
    }
    return best;
  },
  down(e, it) {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const ed = Board.edit;
    const plotNow = () => Board.node(it.id)?.querySelector('.plot');
    const loc = ev => {
      const p = plotNow(), F = p._ctx.F, [x, y] = plotLocal(p, ev);
      return [clamp(F.U(x), 0, 1), clamp(F.V(y), 0, 1)];
    };
    const [u, v] = loc(e);
    const target = () => it.lines.find(l => l.id === ed.line && l.visible) || this.nearest(it, u, v);
    const inv = (ln, val) => clamp((val - (ln.adj?.dy || 0)) / (ln.adj?.sy || 1), 0, 1);
    const finish = () => { Board.refresh(it.id); commit(); Inspector.show(); };

    if (ed.mode === 'sculpt') {
      const ln = target();
      if (!ln) return toast('Draw a line first (“New line”).');
      let lv = v;
      track(e, ev => {
        const [nu, nv] = loc(ev), dv = (nv - lv) / (ln.adj?.sy || 1), r = ed.r;
        ln.pts = ln.pts.map(([pu, pv]) => [pu, clamp(pv + dv * Math.exp(-(((pu - nu) / r) ** 2) * 2.2), 0, 1)]);
        lv = nv;
        Board.refreshSoon(it.id);
      }, finish);
    } else if (ed.mode === 'redraw' || ed.mode === 'new') {
      let ln = ed.mode === 'new' ? null : target();
      const base = ln ? ln.pts.slice() : null;
      if (!ln) {
        let n = it.lines.length + 1;
        while (it.lines.some(l => l.name === `Line ${n}`)) n++;
        ln = { id: uid('l'), name: `Line ${n}`, key: `Line ${n}`, color: PALETTE[(n - 1) % PALETTE.length], visible: true, pts: [], adj: { dy: 0, sy: 1, smooth: 0 }, manual: true };
        it.lines.push(ln);
      }
      const poly = [[u, v]];
      track(e, ev => {
        poly.push(loc(ev));
        const seg = Vision.polyToLine(poly).map(([pu, pv]) => [pu, inv(ln, pv)]);
        if (!seg.length) return;
        const a = seg[0][0], b = seg[seg.length - 1][0];
        ln.pts = base ? [...base.filter(p => p[0] < a), ...seg, ...base.filter(p => p[0] > b)] : seg;
        Board.refreshSoon(it.id);
      }, () => {
        if (ln.pts.length < 2) it.lines = it.lines.filter(l => l !== ln);
        else if (ed.mode === 'new') { ed.mode = 'redraw'; ed.line = ln.id; ed.naming = true; }
        finish();
      });
    } else if (ed.mode === 'erase') {
      const ln = target();
      if (!ln) return;
      const cut = ev => { const [nu] = loc(ev); ln.pts = ln.pts.filter(p => Math.abs(p[0] - nu) > ed.r / 3); Board.refreshSoon(it.id); };
      cut(e);
      track(e, cut, () => { if (ln.pts.length < 2) it.lines = it.lines.filter(l => l !== ln); finish(); });
    }
  },
  bar(it) {
    const ed = Board.edit;
    const modes = [['sculpt', 'Sculpt', 'Push a line up/down with a soft brush'], ['redraw', 'Redraw', 'Draw over a stretch of line to replace it'], ['new', '+ Line', 'Draw a brand-new line'], ['erase', 'Cut', 'Erase a stretch of a line']];
    const cur = it.lines.find(l => l.id === ed.line);
    const name = cur && lineNameInput(cur, () => Inspector.show());
    if (name && ed.naming) {
      ed.naming = false;
      requestAnimationFrame(() => { name.focus(); name.select(); });
    }
    return el('div', { class: 'edit-bar no-drag' },
      el('div', { class: 'seg mini' }, modes.map(([k, l, t]) => el('button', { class: ed.mode === k ? 'on' : '', title: t, onclick: e => { e.stopPropagation(); Board.setEdit({ ...ed, mode: k }); } }, l))),
      el('select', { class: 'mini-select', title: 'Line to edit', value: ed.line || '', onchange: e => { ed.line = e.target.value || null; Board.refresh(it.id, false); } },
        el('option', { value: '' }, 'Nearest line'), it.lines.map(l => el('option', { value: l.id }, l.name))),
      name,
      el('label', { class: 'mini-range', title: 'Brush width' }, 'Brush',
        el('input', { type: 'range', min: 0.02, max: 0.35, step: 0.01, value: ed.r, oninput: e => { ed.r = +e.target.value; } })),
      el('button', { class: 'done', onclick: e => { e.stopPropagation(); Board.setEdit(null); } }, 'Done'));
  },
};

/* ---------- card types ---------- */
const Cards = {
  scan: {
    render(n, it) {
      const a = ASSETS.get(it.asset);
      if (!n._img) {
        n._img = el('img', { draggable: 'false', alt: '' });
        n._name = el('span', { class: 'scan-name' });
        n._head = el('div', { class: 'scan-head' }, el('span', { html: ic('scan') }), n._name,
          iconBtn('wand', 'Digitize this scan', false, () => Digitizer.open({ scanId: it.id })));
        n.append(el('div', { class: 'pin' }), n._head, n._img, el('div', { class: 'resize' }));
      }
      if (a && n._img.getAttribute('src') !== a.src) n._img.src = a.src;
      if (!a) n._img.alt = 'Missing image';
      n._name.textContent = it.name || 'Scan';
      n._img.style.opacity = it.opacity ?? 1;
      n.style.mixBlendMode = it.blend || 'normal';
      n.classList.toggle('framed', !!it.frame);
    },
    dbl(e, it) { Digitizer.open({ scanId: it.id }); },
  },

  map: {
    render(n, it) {
      n.innerHTML = '';
      n.style.setProperty('--c', it.color);
      const m = it.meta, v = it.view;
      const sub = [m.participant, m.session && 'Test ' + m.session, m.condition].filter(Boolean).join(' · ');
      const editing = Board.edit?.id === it.id, playing = Player.cur?.id === it.id;
      const head = el('div', { class: 'card-head' },
        el('span', { class: 'swatch' }),
        el('div', { class: 'titles' }, el('b', {}, m.title || 'Untitled map'), el('small', {}, sub || 'No participant / test yet')),
        el('div', { class: 'acts' },
          it.asset && iconBtn('scan', 'Show the scan underneath', v.ghost > 0, () => { v.ghost = v.ghost > 0 ? 0 : 0.5; Board.refresh(it.id, false); commit(); }),
          iconBtn(playing ? 'pause' : 'play', 'Play — sweep a playhead along X', playing, () => { Player.toggle(it.id); Board.refresh(it.id, false); }),
          iconBtn(v.sound ? 'sound' : 'mute', 'Sonify: hear the lines as pitch', v.sound, () => { v.sound = !v.sound; v.sound ? Sound.ensure() : Sound.silence(); Board.refresh(it.id, false); saveSoon(); }),
          iconBtn('sculpt', 'Edit lines (sculpt, redraw, add)', editing, () => Board.setEdit(editing ? null : { id: it.id, mode: 'sculpt', r: 0.09, line: null })),
          it.asset && iconBtn('wand', 'Re-digitize from the scan', false, () => Digitizer.open({ mapId: it.id }))));
      const plot = el('div', { class: 'plot' + (editing ? ' no-drag editing' : '') });
      const body = el('div', { class: 'card-body' }, plot, editing && Editor.bar(it));
      const foot = el('div', { class: 'card-foot' },
        it.lines.map(ln => el('button', {
          class: 'chip line-chip' + (ln.visible ? '' : ' off'), title: 'Show / hide this line', style: { '--lc': ln.color },
          onclick: e => { e.stopPropagation(); ln.visible = !ln.visible; Board.refresh(it.id); commit(); },
        }, el('i'), ln.name)),
        el('span', { class: 'grow' }),
        (m.tags || []).slice(0, 3).map(t => el('span', { class: 'tag' }, '#' + t)));
      n.append(el('div', { class: 'pin' }), head, body, foot, el('div', { class: 'resize' }));
      Plot.renderMap(plot, it, it.w, it.h - HEAD - FOOT);
      wirePlot(plot, it);
    },
    plot(n, it) { const p = n.querySelector('.plot'); if (p) { Plot.renderMap(p, it, it.w, it.h - HEAD - FOOT); } },
    dbl(e, it) { if (it.asset) Digitizer.open({ mapId: it.id }); else Board.setEdit({ id: it.id, mode: 'sculpt', r: 0.09 }); },
  },

  lens: {
    render(n, it) {
      n.innerHTML = '';
      const o = it.opts, playing = Player.cur?.id === it.id;
      const plot = el('div', { class: 'plot' });
      const plotW = it.w - (o.drawer ? DRAWER : 0), plotH = it.h - HEAD - FOOT;
      const ctx = Plot.renderLens(plot, it, plotW, plotH);
      const D = ctx.D, nLines = D.series.length;
      const modes = [['overlay', 'Overlay'], ['ridge', 'Ridge'], ['heat', 'Heat'], ['dev', 'Δ Dev']];
      const head = el('div', { class: 'card-head' },
        el('span', { class: 'lens-ic', html: ic('lens') }),
        el('div', { class: 'titles' }, el('b', {}, it.title || 'Lens'), el('small', {}, `${D.maps.length} map${D.maps.length === 1 ? '' : 's'} · ${nLines} line${nLines === 1 ? '' : 's'}${it.tagFilter?.length ? ' · filtered' : ''}`)),
        el('div', { class: 'seg mini' }, modes.map(([k, l]) => el('button', { class: o.mode === k ? 'on' : '', onclick: e => { e.stopPropagation(); o.mode = k; Board.refresh(it.id, false); commit(); Inspector.show(); } }, l))),
        el('div', { class: 'acts' },
          iconBtn(playing ? 'pause' : 'play', 'Play — sweep a playhead along X', playing, () => { Player.toggle(it.id); Board.refresh(it.id, false); }),
          iconBtn(o.sound ? 'sound' : 'mute', 'Sonify: hear each line (or each average) as a voice', o.sound, () => { o.sound = !o.sound; o.sound ? Sound.ensure() : Sound.silence(); Board.refresh(it.id, false); saveSoon(); }),
          iconBtn('panel-right', 'Layers drawer', o.drawer, () => { o.drawer = !o.drawer; Board.refresh(it.id, false); saveSoon(); })));
      const body = el('div', { class: 'card-body' }, plot, o.drawer && this.drawer(it, D));
      const bands = [['none', 'No band'], ['sd', '±1 SD'], ['minmax', 'Min–max']];
      const colorBys = [['line', 'Colour: line'], ['participant', 'Colour: participant'], ['session', 'Colour: test'], ['condition', 'Colour: condition'], ['map', 'Colour: map'], ['tag', 'Colour: tag'], ['ink', 'Colour: ink'], ['single', 'Colour: single']];
      const pull = el('input', {
        type: 'range', min: 0, max: 1, step: 0.01, value: o.pull, title: 'Pull every line toward its group average',
        oninput: e => { o.pull = +e.target.value; pv.textContent = Math.round(o.pull * 100) + '%'; Board.redrawPlot(it.id); },
        onchange: () => commit(),
      });
      const pv = el('em', {}, Math.round(o.pull * 100) + '%');
      const foot = el('div', { class: 'card-foot' },
        el('button', { class: 'chip toggle' + (o.avg ? ' on' : ''), title: 'Average line per group', onclick: e => { e.stopPropagation(); o.avg = !o.avg; Board.refresh(it.id, false); commit(); Inspector.show(); } }, el('span', { html: ic('avg') }), 'Average'),
        el('button', { class: 'chip toggle' + (o.showLines ? ' on' : ''), title: 'Individual lines', onclick: e => { e.stopPropagation(); o.showLines = !o.showLines; Board.refresh(it.id, false); commit(); Inspector.show(); } }, 'Lines'),
        el('select', { class: 'mini-select', value: o.band, onchange: e => { o.band = e.target.value; Board.refresh(it.id, false); commit(); Inspector.show(); } }, bands.map(([k, l]) => el('option', { value: k }, l))),
        el('select', { class: 'mini-select', value: o.colorBy, onchange: e => { o.colorBy = e.target.value; Board.refresh(it.id, false); commit(); Inspector.show(); } }, colorBys.map(([k, l]) => el('option', { value: k }, l))),
        el('span', { class: 'grow' }),
        el('label', { class: 'pull no-drag' }, 'Consensus', pull, pv));
      n.append(el('div', { class: 'pin' }), head, body, foot, el('div', { class: 'resize' }));
      wirePlot(plot, it);

      if (!n._dnd) {
        n._dnd = true;
        n.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('application/x-tf-map')) { e.preventDefault(); n.classList.add('drop-target'); } });
        n.addEventListener('dragleave', e => { if (!n.contains(e.relatedTarget)) n.classList.remove('drop-target'); });
        n.addEventListener('drop', e => {
          const id = e.dataTransfer.getData('application/x-tf-map');
          n.classList.remove('drop-target');
          if (!id) return;
          e.preventDefault(); e.stopPropagation();
          Board.addToLens(getItem(n.dataset.id), [id]);
        });
      }
    },
    plot(n, it) {
      const p = n.querySelector('.plot');
      if (p) Plot.renderLens(p, it, it.w - (it.opts.drawer ? DRAWER : 0), it.h - HEAD - FOOT);
    },
    drawer(it, D) {
      const colorOf = new Map(D.series.map(s => [s.key, s.color]));
      const box = el('div', { class: 'drawer scroll no-drag' });
      box.append(el('div', { class: 'drawer-h' }, el('b', {}, 'Layers'), el('small', {}, 'drag to reorder')));
      if (!it.maps.length) box.append(el('p', { class: 'muted small pad' }, 'Drop map cards on the lens, or drag them from the library.'));
      it.maps.forEach((mid, idx) => {
        const m = getItem(mid);
        if (!m) return;
        const row = el('div', { class: 'd-row', draggable: 'true' },
          el('div', { class: 'd-top' },
            el('span', { class: 'grip', html: ic('grip') }),
            el('span', { class: 'swatch', style: { background: m.color } }),
            el('div', { class: 'd-t' }, el('b', {}, m.meta.participant || m.meta.title || 'Map'), el('small', {}, [m.meta.session && 'Test ' + m.meta.session, m.meta.condition].filter(Boolean).join(' · ') || m.meta.title || '')),
            m.asset && iconBtn('scan', 'Include this scan in the stack (set stack opacity in the inspector)', !it.underOff?.[mid], () => {
              it.underOff = it.underOff || {};
              it.underOff[mid] ? delete it.underOff[mid] : (it.underOff[mid] = true);
              if (!it.opts.under && !it.underOff[mid]) it.opts.under = 0.35;
              Board.refresh(it.id, false); commit();
            }),
            iconBtn('x', 'Remove from lens', false, () => { it.maps.splice(idx, 1); Board.refresh(it.id, false); commit(); Inspector.show(); })),
          el('div', { class: 'd-lines' }, m.lines.filter(l => l.visible).map(ln => {
            const key = mid + ':' + ln.id;
            return el('button', {
              class: 'chip line-chip' + (it.hidden[key] ? ' off' : ''), style: { '--lc': colorOf.get(key) || ln.color }, title: 'Toggle · hover to spotlight',
              onclick: e => { e.stopPropagation(); it.hidden[key] ? delete it.hidden[key] : (it.hidden[key] = true); Board.refresh(it.id, false); commit(); },
              onmouseenter: () => { it.focus = key; Board.redrawPlot(it.id); },
              onmouseleave: () => { it.focus = null; Board.redrawPlot(it.id); },
            }, el('i'), ln.name);
          })));
        row.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-tf-row', String(idx)); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('application/x-tf-row')) { e.preventDefault(); row.classList.add('over'); } });
        row.addEventListener('dragleave', () => row.classList.remove('over'));
        row.addEventListener('drop', e => {
          const from = +e.dataTransfer.getData('application/x-tf-row');
          row.classList.remove('over');
          if (isNaN(from) || from === idx) return;
          e.preventDefault(); e.stopPropagation();
          const [moved] = it.maps.splice(from, 1);
          it.maps.splice(idx, 0, moved);
          Board.refresh(it.id, false); commit(); Inspector.show();
        });
        box.append(row);
      });
      return box;
    },
    click(e, it) {
      const k = e.target.closest('[data-key]')?.dataset.key;
      const key = k ? (k.startsWith('avg:') ? k.slice(4) : k) : null;
      it.focus = key && it.focus !== key ? key : null;
      Board.redrawPlot(it.id);
    },
  },

  note: {
    render(n, it) {
      n.innerHTML = '';
      n.style.setProperty('--note', it.color || NOTE_COLORS[0]);
      n.style.setProperty('--rot', (it.rot || 0) + 'deg');
      const t = el('div', { class: 'note-text', contenteditable: 'false', spellcheck: 'false', style: { fontSize: (it.fs || 24) + 'px' } });
      t.textContent = it.text || '';
      t.addEventListener('blur', () => {
        t.contentEditable = 'false';
        n.classList.remove('typing');
        if (it.text !== t.innerText) { it.text = t.innerText; commit(); }
      });
      t.addEventListener('keydown', e => { if (e.key === 'Escape') t.blur(); e.stopPropagation(); });
      n.append(el('div', { class: 'pin' }), t, el('div', { class: 'resize' }));
    },
    dbl(e, it, n) { Cards.note.edit(n); },
    edit(n) {
      const t = n.querySelector('.note-text, .text-body');
      if (!t) return;
      t.contentEditable = 'true';
      n.classList.add('typing');
      t.focus();
      const r = document.createRange(); r.selectNodeContents(t);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    },
  },

  text: {
    render(n, it) {
      n.innerHTML = '';
      const t = el('div', { class: 'text-body', contenteditable: 'false', spellcheck: 'false', style: { fontSize: (it.fs || 40) + 'px', color: it.color || 'var(--text)' } });
      t.textContent = it.text || '';
      t.addEventListener('blur', () => {
        t.contentEditable = 'false';
        n.classList.remove('typing');
        if (it.text !== t.innerText) { it.text = t.innerText; commit(); }
      });
      t.addEventListener('keydown', e => { if (e.key === 'Escape') t.blur(); e.stopPropagation(); });
      n.append(t, el('div', { class: 'resize' }));
    },
    dbl(e, it, n) { Cards.note.edit(n); },
  },
};
