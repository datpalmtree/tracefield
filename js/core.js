'use strict';
/* =====================================================================
   Tracefield · core
   helpers, state, persistence, undo history, colour + geometry maths
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const round = (v, d = 4) => { const k = 10 ** d; return Math.round(v * k) / k; };
const uid = (p = '') => p + Math.random().toString(36).slice(2, 8) + (Date.now() % 1679616).toString(36);
const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SVGNS = 'http://www.w3.org/2000/svg';
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const today = () => new Date().toISOString().slice(0, 10);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  let val;
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') {
      if (typeof v === 'string') n.style.cssText = v;
      else for (const p in v) p.startsWith('--') ? n.style.setProperty(p, v[p]) : (n.style[p] = v[p]);
    }
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'value') val = v;
    else if (k === 'checked') n.checked = !!v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  if (val !== undefined) n.value = val;
  return n;
}

function sv(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

const ic = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function rafThrottle(fn) {
  let queued = false, args;
  return (...a) => { args = a; if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(...args); }); };
}

/** Follow a pointer until release, using window listeners (works across elements). */
function track(e, move, up) {
  const id = e.pointerId;
  const mv = ev => { if (ev.pointerId === id) move && move(ev); };
  const done = ev => {
    if (ev.pointerId !== id) return;
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', done);
    window.removeEventListener('pointercancel', done);
    up && up(ev);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', done);
  window.addEventListener('pointercancel', done);
}

function download(name, data, type = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

function toast(msg, kind = '', ms = 3200) {
  const host = $('#toasts');
  const t = el('div', { class: `toast ${kind}` }, msg);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, ms);
}

function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function fmtNum(v) {
  if (v == null || !isFinite(v)) return '–';
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/* ---------- line sampling (shared by vision + plot) ---------- */

/** Linear interpolation of v at u along an ascending [[u,v]] list; null when outside. */
function sampleAt(pts, u) {
  const n = pts.length;
  if (!n) return null;
  if (u < pts[0][0] - 1e-9 || u > pts[n - 1][0] + 1e-9) return null;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= u) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  if (b[0] === a[0]) return a[1];
  return a[1] + (b[1] - a[1]) * clamp((u - a[0]) / (b[0] - a[0]), 0, 1);
}

/* ---------- colour ---------- */

const PALETTE = ['#4cc9f0', '#ff4fa3', '#c6ff3d', '#ffb020', '#9d7cff', '#2ee6a6', '#ff6b4a', '#5aa9ff', '#ffd84f', '#ff9ecd', '#00d1c1', '#c77dff'];
const NOTE_COLORS = ['#ffe873', '#ffb4c8', '#a8f0d0', '#a9d4ff', '#d9c3ff', '#ffcf99'];
const PEN_COLORS = ['#ff4f5e', '#ffb020', '#c6ff3d', '#4cc9f0', '#9d7cff', '#f4f1ea', '#1b1c23'];

function hexToRgb(h) {
  h = String(h || '#000').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };

const _lin = new Float32Array(256).map((_, i) => { const c = i / 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; });
function rgbToLab(r, g, b) {
  const R = _lin[r | 0], G = _lin[g | 0], B = _lin[b | 0];
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function labToRgb(L, a, b) {
  let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200;
  const g = t => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
  x = 0.95047 * g(x); y = g(y); z = 1.08883 * g(z);
  const R = x * 3.2406 - y * 1.5372 - z * 0.4986, G = -x * 0.9689 + y * 1.8758 + z * 0.0415, B = x * 0.0557 - y * 0.2040 + z * 1.0570;
  const f = c => c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c;
  return [f(R), f(G), f(B)].map(c => clamp(Math.round(c * 255), 0, 255));
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h, s, l) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
/** Make an ink colour readable as a display colour; null when the ink is grey/black. */
function vivid(hex) {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  if (s < 0.16 || l < 0.12) return null;
  return rgbToHex(...hslToRgb(h, Math.max(s, 0.72), clamp(l, 0.56, 0.66)));
}

/** Persistent value → colour mapping per field (editable “colour codes”). */
function colorFor(field, value) {
  const r = S.colorRules[field] || (S.colorRules[field] = {});
  if (!r[value]) r[value] = PALETTE[Object.keys(r).length % PALETTE.length];
  return r[value];
}

const Theme = {
  cache: null,
  read() {
    const cs = getComputedStyle(document.documentElement), g = n => cs.getPropertyValue(n).trim();
    this.cache = { text: g('--text'), muted: g('--muted'), faint: g('--faint'), axis: g('--plot-axis'), grid: g('--plot-grid'), card: g('--card'), accent: g('--accent'), accent2: g('--accent-2') };
    return this.cache;
  },
  t() { return this.cache || this.read(); },
};

/* ---------- projective geometry ---------- */

function solveLinear(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}
/** Homography (3x3, row-major array of 9) mapping 4 src points onto 4 dst points. */
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return [...solveLinear(A, b), 1];
}
function hApply(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}
const hCss = H => `matrix3d(${H[0]},${H[3]},0,${H[6]},${H[1]},${H[4]},0,${H[7]},0,0,1,0,${H[2]},${H[5]},0,${H[8]})`;
const UNIT = [[0, 0], [1, 0], [1, 1], [0, 1]]; // TL TR BR BL (y down)

/* ---------- state ---------- */

function freshState() {
  return {
    v: 1,
    view: { x: 0, y: 0, z: 1 },
    items: [], links: [], strokes: [],
    colorRules: {},
    template: null,
    settings: { autoDigitize: true, theme: 'dark', snap: false },
    z: 10,
  };
}
let S = freshState();
const ASSETS = new Map(); // id → { src, w, h, name }

const getItem = id => S.items.find(i => i.id === id);
const itemsOf = type => S.items.filter(i => i.type === type);

function defaultAxes() {
  return { yHigh: 'High', yLow: 'Low', yTitle: '', yMin: 0, yMax: 100, yUnit: '', xStart: 'Start', xEnd: 'End', xTitle: '', xMin: 0, xMax: 100, xUnit: '' };
}
function defaultMapView() { return { curve: 'smooth', qx: 0, qy: 0, width: 2.6, points: false, grid: true, ticks: false, ghost: 0, sound: false, dur: 8 }; }
function defaultLensOpts() {
  return {
    mode: 'overlay', colorBy: 'line', groupBy: 'line', avg: true, band: 'sd', showLines: true, pull: 0,
    normalize: 'none', qx: 0, qy: 0, curve: 'smooth', width: 2, opacity: 0.8, ticks: false, grid: true,
    under: 0, blend: 'normal', drawer: true, sound: false, dur: 10, matrix: 'series',
  };
}
function parseName(name = '') {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '');
  const p = base.match(/(?:^|[^a-z])(?:p|pp|part|participant|subj|subject|id)[\s_-]*0*(\d+)/i);
  const s = base.match(/(?:^|[^a-z])(?:t|test|ses|session|trial|run|wk|week)[\s_-]*0*(\d+)/i);
  return { title: base, participant: p ? 'P' + p[1].padStart(2, '0') : '', session: s ? s[1] : '', condition: '', date: today(), tags: [], notes: '' };
}
function allTags() {
  const m = new Map();
  for (const it of itemsOf('map')) for (const t of it.meta.tags || []) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/* ---------- persistence (IndexedDB) ---------- */

const Store = {
  db: null,
  open() {
    return new Promise(res => {
      try {
        const r = indexedDB.open('tracefield', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('assets'); };
        r.onsuccess = () => { this.db = r.result; res(true); };
        r.onerror = () => res(false);
      } catch { res(false); }
    });
  },
  _tx(store, mode, fn) {
    if (!this.db) return Promise.resolve(null);
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  get(store, key) { return this._tx(store, 'readonly', s => s.get(key)); },
  put(store, key, val) { return this._tx(store, 'readwrite', s => s.put(val, key)).catch(e => toast('Could not save: ' + e.message, 'bad')); },
  del(store, key) { return this._tx(store, 'readwrite', s => s.delete(key)); },
  keys(store) { return this._tx(store, 'readonly', s => s.getAllKeys()); },
  clear(store) { return this._tx(store, 'readwrite', s => s.clear()); },
};

function saveNow() {
  const { view, ...rest } = S;
  Store.put('kv', 'project', JSON.stringify({ ...rest, view }));
}
const saveSoon = debounce(saveNow, 600);

function registerAsset(a) {
  const id = uid('a');
  ASSETS.set(id, a);
  Store.put('assets', id, a);
  return id;
}

/* ---------- undo history ---------- */

const Hist = {
  past: [], future: [], last: null,
  snap() { return JSON.stringify({ items: S.items, links: S.links, strokes: S.strokes, colorRules: S.colorRules, template: S.template }); },
  reset() { this.past = []; this.future = []; this.last = this.snap(); this.ui(); },
  commit() {
    const s = this.snap();
    if (s === this.last) return;
    this.past.push(this.last);
    if (this.past.length > 120) this.past.shift();
    this.last = s; this.future = []; this.ui();
  },
  undo() { if (!this.past.length) return; this.future.push(this.last); this.last = this.past.pop(); this.restore(); },
  redo() { if (!this.future.length) return; this.past.push(this.last); this.last = this.future.pop(); this.restore(); },
  restore() { Object.assign(S, JSON.parse(this.last)); App.afterRestore(); saveSoon(); this.ui(); },
  ui() {
    const u = $('#btn-undo'), r = $('#btn-redo');
    if (u) u.disabled = !this.past.length;
    if (r) r.disabled = !this.future.length;
  },
};

/** Record an undo step, persist, and refresh dependent panels. */
function commit() { Hist.commit(); saveSoon(); App.changed(); }
