'use strict';
/* =====================================================================
   Tracefield · vision
   scan → plot frame → perspective-flattened bitmap → ink mask →
   colour clusters → continuous tracks → grouped lines
   All line data is normalised: u = 0..1 along X, v = 0..1 up the Y axis.
   ===================================================================== */

const Vision = (() => {
  const MAXDIM = 1600;  // working resolution of the source image
  const RW = 560;       // width of the flattened plot bitmap
  const GRID = 240;     // resolution of extracted lines along X

  const cache = new Map();
  const lum = (d, i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;

  function loadImg(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }

  /** Downscaled RGBA pixels of an asset (cached). */
  async function pixels(assetId) {
    if (cache.has(assetId)) return cache.get(assetId);
    const a = ASSETS.get(assetId);
    const img = await loadImg(a.src);
    const s = Math.min(1, MAXDIM / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); cx.drawImage(img, 0, 0, w, h);
    const px = { w, h, data: cx.getImageData(0, 0, w, h).data };
    cache.set(assetId, px);
    return px;
  }

  /* ---------- 1 · find the plot frame (the two axes) ---------- */

  function detectFrame(px) {
    const { w, h, data } = px;
    const N = w * h, L = new Float32Array(N);
    for (let i = 0; i < N; i++) L[i] = lum(data, i * 4);
    const samp = [];
    for (let i = 0; i < N; i += 7) samp.push(L[i]);
    samp.sort((a, b) => a - b);
    const paper = samp[Math.floor(samp.length * 0.9)] || 255, dk = paper * 0.62, br = paper * 0.78;
    const fallback = [[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]];

    // thin dark strokes with paper on both sides (ignores black backgrounds, desk edges, shadows)
    const K = Math.max(4, Math.round(Math.min(w, h) * 0.01));
    const vp = [], hp = [];
    for (let y = K; y < h - K; y++) for (let x = K; x < w - K; x++) {
      const i = y * w + x, v = L[i];
      if (v >= dk) continue;
      const wt = 0.3 + (dk - v) / dk; // favour black ink over coloured pens
      let l = false, r = false, u = false, d = false;
      for (let k = 1; k <= K && !(l && r); k++) { if (!l && L[i - k] >= br) l = true; if (!r && L[i + k] >= br) r = true; }
      if (l && r) vp.push(x, y, wt);
      for (let k = 1; k <= K && !(u && d); k++) { if (!u && L[i - k * w] >= br) u = true; if (!d && L[i + k * w] >= br) d = true; }
      if (u && d) hp.push(x, y, wt);
    }
    // small Hough transform over ±12°
    const tans = [];
    for (let a = -12; a <= 12; a += 1) tans.push(Math.tan(a * Math.PI / 180));
    const hough = (pts, vertical) => {
      const out = [];
      for (const t of tans) {
        const bins = new Map();
        for (let k = 0; k < pts.length; k += 3) {
          const c = vertical ? pts[k] - pts[k + 1] * t : pts[k + 1] - pts[k] * t, bn = Math.round(c / 2);
          bins.set(bn, (bins.get(bn) || 0) + pts[k + 2]);
        }
        for (const [bn, sc] of bins) out.push([sc + (bins.get(bn - 1) || 0) + (bins.get(bn + 1) || 0), t, bn * 2]);
      }
      return out;
    };
    const pick = (cands, pos, lo, hi, prefer) => {
      const ok = cands.filter(c => { const p = pos(c); return p >= lo && p <= hi; });
      if (!ok.length) return null;
      const top = Math.max(...ok.map(c => c[0]));
      const strong = ok.filter(c => c[0] >= top * 0.55);
      // among strong lines take the outermost (axes sit left / bottom of the data), then the best fit near it
      const edge = prefer(strong.map(pos));
      const near = strong.filter(c => Math.abs(pos(c) - edge) <= Math.max(6, K * 1.5));
      return near.sort((a, b) => b[0] - a[0])[0];
    };
    const V = pick(hough(vp, true), c => c[2] + c[1] * h / 2, w * 0.02, w * 0.6, xs => Math.min(...xs));
    const Hh = pick(hough(hp, false), c => c[2] + c[1] * w / 2, h * 0.35, h * 0.98, ys => Math.max(...ys));
    if (!V || !Hh) return fallback;
    const [, tv, cv] = V, [, th, ch] = Hh;
    const ox = (cv + ch * tv) / (1 - th * tv), oy = ch + ox * th;
    const isDark = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < w && y < h && L[y * w + x] < dk; };
    const near = (x, y, vertical) => { for (let d = 0; d <= 3; d++) if (vertical ? isDark(x - d, y) || isDark(x + d, y) : isDark(x, y - d) || isDark(x, y + d)) return true; return false; };

    let top = oy, gap = 0;
    const gy = Math.max(6, h * 0.025), gx = Math.max(6, w * 0.025);
    for (let y = Math.round(oy); y >= 0; y--) { if (near(cv + y * tv, y, true)) { top = y; gap = 0; } else if (++gap > gy) break; }
    let right = ox; gap = 0;
    for (let x = Math.round(ox); x < w; x++) { if (near(x, ch + x * th, false)) { right = x; gap = 0; } else if (++gap > gx) break; }
    if (oy - top < h * 0.12 || right - ox < w * 0.12) return fallback;

    const O = [ox, oy], T = [cv + top * tv, top], R = [right, ch + right * th], TR = [T[0] + R[0] - O[0], T[1] + R[1] - O[1]];
    return [T, TR, R, O].map(([x, y]) => [clamp(x / w, 0, 1), clamp(y / h, 0, 1)]);
  }

  /* ---------- 2 · flatten the frame (perspective correct) ---------- */

  function rectify(px, quad, W = RW) {
    const q = quad.map(([x, y]) => [x * px.w, y * px.h]);
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const aspect = ((d(q[0], q[3]) + d(q[1], q[2])) / 2) / Math.max(1, (d(q[0], q[1]) + d(q[3], q[2])) / 2);
    const H = clamp(Math.round(W * aspect), 60, 1400);
    const M = homography([[0, 0], [W, 0], [W, H], [0, H]], q);
    const out = new Uint8ClampedArray(W * H * 4), src = px.data, sw = px.w, sh = px.h;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const X = i + 0.5, Y = j + 0.5, ww = M[6] * X + M[7] * Y + M[8];
        const x = (M[0] * X + M[1] * Y + M[2]) / ww - 0.5, y = (M[3] * X + M[4] * Y + M[5]) / ww - 0.5;
        const o = (j * W + i) * 4;
        out[o + 3] = 255;
        const x0 = Math.floor(x), y0 = Math.floor(y);
        if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) { out[o] = out[o + 1] = out[o + 2] = 255; continue; }
        const fx = x - x0, fy = y - y0, a = (y0 * sw + x0) * 4, b = a + 4, c = a + sw * 4, e = c + 4;
        for (let k = 0; k < 3; k++) out[o + k] = (src[a + k] * (1 - fx) + src[b + k] * fx) * (1 - fy) + (src[c + k] * (1 - fx) + src[e + k] * fx) * fy;
      }
    }
    return { w: W, h: H, data: out };
  }

  /* ---------- 3 · separate ink from paper ---------- */

  function rasterErase(list, w, h) {
    if (!list || !list.length) return null;
    const m = new Uint8Array(w * h);
    for (const c of list) {
      const cx = c.u * w, cy = c.v * h, r = Math.max(1, c.r * w);
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++)
          if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * w + x] = 1;
    }
    return m;
  }

  function inkAnalysis(rect, opt = {}) {
    const { w, h, data } = rect;
    const sens = opt.sens ?? 26, guard = opt.guard ?? 0.015;

    // paper colour estimated per block (handles shadows / uneven phone photos)
    const B = 20, bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    const blk = new Float32Array(bw * bh * 4); // r g b lum
    const tmp = [];
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      tmp.length = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y++)
        for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x++) { const i = (y * w + x) * 4; tmp.push(Math.round(lum(data, i)) * 1e7 + i); }
      tmp.sort((p, q) => q - p);
      const n = Math.max(1, Math.floor(tmp.length * 0.3));
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < n; k++) { const i = tmp[k] % 1e7; r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      const o = (by * bw + bx) * 4;
      blk[o] = r / n; blk[o + 1] = g / n; blk[o + 2] = b / n; blk[o + 3] = (r * 0.299 + g * 0.587 + b * 0.114) / n;
    }
    // a block fully covered in ink would look like “paper”: borrow the brightest neighbour
    const plab = new Float32Array(bw * bh * 3);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let bi = (by * bw + bx) * 4, bl = blk[bi + 3];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = by + dy, xx = bx + dx;
        if (yy < 0 || xx < 0 || yy >= bh || xx >= bw) continue;
        const j = (yy * bw + xx) * 4;
        if (blk[j + 3] > bl + 12) { bl = blk[j + 3]; bi = j; }
      }
      const L = rgbToLab(blk[bi], blk[bi + 1], blk[bi + 2]);
      plab.set(L, (by * bw + bx) * 3);
    }

    const erase = rasterErase(opt.erase, w, h);
    const gx = Math.round(w * guard), gy = Math.round(h * guard);
    const mask = new Uint8Array(w * h), lab = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      const fy = clamp((y + 0.5) / B - 0.5, 0, bh - 1), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x < gx || y < gy || x >= w - gx || y >= h - gy || (erase && erase[i])) continue;
        const fx = clamp((x + 0.5) / B - 0.5, 0, bw - 1), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
        const p00 = (y0 * bw + x0) * 3, p01 = (y0 * bw + x1) * 3, p10 = (y1 * bw + x0) * 3, p11 = (y1 * bw + x1) * 3;
        const P = k => (plab[p00 + k] * (1 - tx) + plab[p01 + k] * tx) * (1 - ty) + (plab[p10 + k] * (1 - tx) + plab[p11 + k] * tx) * ty;
        const PL = P(0), PA = P(1), PB = P(2);
        const [L, A, Bv] = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
        const dE = Math.hypot(L - PL, (A - PA) * 1.2, (Bv - PB) * 1.2);
        if (dE > sens && L < PL + 4) { mask[i] = 1; lab[i * 3] = L; lab[i * 3 + 1] = A; lab[i * 3 + 2] = Bv; }
      }
    }
    // suppress ruled lines / axes that run across most of the frame
    for (let y = 0; y < h; y++) { let c = 0; for (let x = 0; x < w; x++) c += mask[y * w + x]; if (c > w * 0.55) for (let x = 0; x < w; x++) mask[y * w + x] = 0; }
    for (let x = 0; x < w; x++) { let c = 0; for (let y = 0; y < h; y++) c += mask[y * w + x]; if (c > h * 0.55) for (let y = 0; y < h; y++) mask[y * w + x] = 0; }
    let count = 0;
    for (let i = 0; i < w * h; i++) count += mask[i];
    return { w, h, mask, lab, count };
  }

  /* ---------- 4 · cluster ink colours (k-means in Lab) ---------- */

  function kmeans(F, n, k, rnd) {
    const C = new Float32Array(k * 3), D = new Float32Array(n).fill(Infinity), A = new Int32Array(n);
    const d2 = (i, c) => { const a = F[i * 3] - C[c * 3], b = F[i * 3 + 1] - C[c * 3 + 1], e = F[i * 3 + 2] - C[c * 3 + 2]; return a * a + b * b + e * e; };
    let first = Math.floor(rnd() * n);
    C.set(F.subarray(first * 3, first * 3 + 3), 0);
    for (let c = 1; c < k; c++) {
      let sum = 0;
      for (let i = 0; i < n; i++) { const d = d2(i, c - 1); if (d < D[i]) D[i] = d; sum += D[i]; }
      let r = rnd() * sum, j = 0;
      for (; j < n - 1; j++) { r -= D[j]; if (r <= 0) break; }
      C.set(F.subarray(j * 3, j * 3 + 3), c * 3);
    }
    let sse = 0;
    for (let it = 0; it < 30; it++) {
      let changed = 0; sse = 0;
      for (let i = 0; i < n; i++) {
        let bc = 0, bd = Infinity;
        for (let c = 0; c < k; c++) { const d = d2(i, c); if (d < bd) { bd = d; bc = c; } }
        if (A[i] !== bc) { A[i] = bc; changed++; }
        sse += bd;
      }
      const sum = new Float64Array(k * 3), cnt = new Int32Array(k);
      for (let i = 0; i < n; i++) { const c = A[i]; cnt[c]++; sum[c * 3] += F[i * 3]; sum[c * 3 + 1] += F[i * 3 + 1]; sum[c * 3 + 2] += F[i * 3 + 2]; }
      for (let c = 0; c < k; c++) if (cnt[c]) { C[c * 3] = sum[c * 3] / cnt[c]; C[c * 3 + 1] = sum[c * 3 + 1] / cnt[c]; C[c * 3 + 2] = sum[c * 3 + 2] / cnt[c]; }
      if (!changed && it) break;
    }
    return { C, k, sse };
  }

  function cluster(an, kOpt = 'auto') {
    const { w, h, mask, lab } = an;
    const labels = new Int16Array(w * h).fill(-1);
    const idx = [];
    for (let i = 0; i < w * h; i++) if (mask[i]) idx.push(i);
    if (!idx.length) return { clusters: [], labels, k: 0 };
    const stride = Math.max(1, Math.floor(idx.length / 9000));
    const sample = [];
    for (let s = 0; s < idx.length; s += stride) sample.push(idx[s]);
    const F = new Float32Array(sample.length * 3);
    sample.forEach((p, j) => { F[j * 3] = lab[p * 3] * 0.5; F[j * 3 + 1] = lab[p * 3 + 1]; F[j * 3 + 2] = lab[p * 3 + 2]; });

    let best;
    if (kOpt === 'auto' || !kOpt) {
      const runs = [];
      for (let k = 1; k <= 7 && k <= sample.length; k++) runs.push(kmeans(F, sample.length, k, mulberry32(11)));
      const s1 = runs[0].sse || 1;
      let pick = runs.length - 1;
      for (let k = 0; k < runs.length - 1; k++) if ((runs[k].sse - runs[k + 1].sse) / s1 < 0.035) { pick = k; break; }
      best = runs[pick];
    } else best = kmeans(F, sample.length, Math.min(+kOpt, sample.length), mulberry32(11));

    const { C, k } = best;
    const counts = new Int32Array(k), sums = new Float64Array(k * 3);
    for (const p of idx) {
      const f0 = lab[p * 3] * 0.5, f1 = lab[p * 3 + 1], f2 = lab[p * 3 + 2];
      let bc = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const d = (f0 - C[c * 3]) ** 2 + (f1 - C[c * 3 + 1]) ** 2 + (f2 - C[c * 3 + 2]) ** 2; if (d < bd) { bd = d; bc = c; } }
      labels[p] = bc; counts[bc]++;
      sums[bc * 3] += lab[p * 3]; sums[bc * 3 + 1] += f1; sums[bc * 3 + 2] += f2;
    }
    const order = [...Array(k).keys()].sort((a, b) => counts[b] - counts[a]);
    const remap = new Int16Array(k);
    order.forEach((c, i) => { remap[c] = i; });
    for (const p of idx) labels[p] = remap[labels[p]];
    const clusters = order.map((c, i) => {
      const n = counts[c] || 1, L = sums[c * 3] / n, A = sums[c * 3 + 1] / n, Bv = sums[c * 3 + 2] / n;
      // render the swatch a little darker than the anti-aliased mean, closer to the pen colour
      return { id: i, count: counts[c], share: counts[c] / idx.length, hex: rgbToHex(...labToRgb(L * 0.9, A * 1.1, Bv * 1.1)) };
    });
    return { clusters, labels, k };
  }

  /* ---------- 5 · follow strokes column by column ---------- */

  function tracks(an, labels, c) {
    const { w, h } = an;
    const maxGap = Math.max(3, Math.round(w * 0.035)), tol = Math.max(4, h * 0.07);
    const all = [], live = [];
    for (let x = 0; x < w; x++) {
      const runs = [];
      let a = -1, last = -10;
      for (let y = 0; y < h; y++) {
        if (labels[y * w + x] !== c) continue;
        if (a < 0) a = y;
        else if (y - last > 3) { runs.push([a, last]); a = y; }
        last = y;
      }
      if (a >= 0) runs.push([a, last]);

      const pairs = [];
      for (const t of live) {
        const dx = x - t.lx;
        if (dx > maxGap) continue;
        const pred = t.ly + t.s * dx, allow = tol + Math.abs(t.s) * dx;
        runs.forEach(([ra, rb], r) => {
          const d = pred < ra ? ra - pred : pred > rb ? pred - rb : 0;
          if (d <= allow) pairs.push([d + Math.abs((ra + rb) / 2 - pred) * 0.25, t, r]);
        });
      }
      pairs.sort((p, q) => p[0] - q[0]);
      const usedT = new Set(), usedR = new Set();
      for (const [, t, r] of pairs) {
        if (usedT.has(t) || usedR.has(r)) continue;
        usedT.add(t); usedR.add(r);
        const y = (runs[r][0] + runs[r][1]) / 2, dx = x - t.lx;
        t.s = clamp(t.s * 0.6 + ((y - t.ly) / dx) * 0.4, -h * 0.25, h * 0.25);
        t.pts.push([x, y]); t.lx = x; t.ly = y;
      }
      runs.forEach(([ra, rb], r) => {
        if (usedR.has(r)) return;
        const y = (ra + rb) / 2, t = { c, pts: [[x, y]], lx: x, ly: y, s: 0 };
        live.push(t); all.push(t);
      });
      for (let i = live.length - 1; i >= 0; i--) if (x - live[i].lx > maxGap) live.splice(i, 1);
    }

    let ts = all.filter(t => t.pts.length >= Math.max(4, w * 0.012));
    // chain fragments of the same ink that were interrupted (e.g. by a crossing line)
    for (;;) {
      let best = null;
      for (const A of ts) for (const B of ts) {
        if (A === B) continue;
        const ae = A.pts[A.pts.length - 1], bs = B.pts[0], gap = bs[0] - ae[0];
        if (gap < -2 || gap > w * 0.08) continue;
        const k = Math.min(8, A.pts.length - 1), ap = A.pts[A.pts.length - 1 - k];
        const sl = k ? (ae[1] - ap[1]) / ((ae[0] - ap[0]) || 1) : 0;
        const pred = ae[1] + sl * Math.max(gap, 0);
        const cost = Math.min(Math.abs(bs[1] - pred), Math.abs(bs[1] - ae[1]) * 1.4) + Math.max(gap, 0) * 0.3;
        if (cost > h * 0.1) continue;
        if (!best || cost < best[0]) best = [cost, A, B];
      }
      if (!best) break;
      const [, A, B] = best, lx = A.pts[A.pts.length - 1][0];
      A.pts = A.pts.concat(B.pts.filter(p => p[0] > lx));
      ts = ts.filter(t => t !== B);
    }
    return ts.filter(t => t.pts[t.pts.length - 1][0] - t.pts[0][0] >= w * 0.04);
  }

  function toGrid(pts) {
    const g = new Float32Array(GRID + 1).fill(NaN);
    for (let i = 0; i <= GRID; i++) { const v = sampleAt(pts, i / GRID); if (v != null) g[i] = v; }
    return g;
  }

  /** Accumulated grid → contiguous [[u,v]] with interior gaps bridged. */
  function fillGrid(acc, cnt) {
    let first = -1, last = -1;
    for (let i = 0; i <= GRID; i++) if (cnt[i]) { if (first < 0) first = i; last = i; }
    if (first < 0) return [];
    const out = [];
    let prev = first;
    for (let i = first; i <= last; i++) {
      if (cnt[i]) { out.push([i / GRID, acc[i] / cnt[i]]); prev = i; continue; }
      let nx = i + 1;
      while (nx <= last && !cnt[nx]) nx++;
      const a = acc[prev] / cnt[prev], b = acc[nx] / cnt[nx];
      out.push([i / GRID, a + (b - a) * ((i - prev) / (nx - prev))]);
    }
    return out.map(([u, v]) => [round(u), round(clamp(v, 0, 1))]);
  }

  /** Per-column median of the fragments' grids (robust to multi-pen strokes). */
  function medianGrid(cands) {
    const cur = new Float32Array(GRID + 1).fill(NaN), vals = [];
    for (let i = 0; i <= GRID; i++) {
      vals.length = 0;
      for (const c of cands) if (!isNaN(c.grid[i])) vals.push(c.grid[i]);
      if (!vals.length) continue;
      vals.sort((a, b) => a - b);
      const m = vals.length >> 1;
      cur[i] = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
    }
    return cur;
  }

  function buildLine(cands) {
    const cur = medianGrid(cands), cnt = new Uint16Array(GRID + 1), acc = new Float32Array(GRID + 1);
    for (let i = 0; i <= GRID; i++) if (!isNaN(cur[i])) { acc[i] = cur[i]; cnt[i] = 1; }
    return fillGrid(acc, cnt);
  }

  /** Free-hand polyline in (u, vUp) → function of u. */
  function polyToLine(poly) {
    const acc = new Float32Array(GRID + 1), cnt = new Uint16Array(GRID + 1);
    for (let k = 0; k < poly.length - 1; k++) {
      const [u1, v1] = poly[k], [u2, v2] = poly[k + 1];
      const g1 = Math.ceil(Math.min(u1, u2) * GRID), g2 = Math.floor(Math.max(u1, u2) * GRID);
      for (let g = Math.max(0, g1); g <= Math.min(GRID, g2); g++) {
        const t = u2 === u1 ? 0 : (g / GRID - u1) / (u2 - u1);
        acc[g] += v1 + (v2 - v1) * t; cnt[g]++;
      }
    }
    return fillGrid(acc, cnt);
  }

  /**
   * Assemble fragments into lines: longest first, each fragment joins the line it
   * agrees with (or continues), otherwise it seeds a new line. Comparing against the
   * line's running median (not fragment-to-fragment) stops chains from drifting
   * across neighbouring lines through digits or crossings.
   */
  function groupCandidates(cands, minSpan = 0.2) {
    const TOL = 0.05;
    const order = cands.map((c, i) => i).sort((a, b) => (cands[b].u1 - cands[b].u0) - (cands[a].u1 - cands[a].u0));
    const lines = [];
    const extent = cur => { let a = -1, b = -1; for (let i = 0; i <= GRID; i++) if (!isNaN(cur[i])) { if (a < 0) a = i; b = i; } return [a / GRID, b / GRID]; };
    for (const ci of order) {
      const c = cands[ci], span = (c.u1 - c.u0) * GRID;
      let best = null, bestScore = 0;
      for (const L of lines) {
        let sh = 0, ok = 0;
        for (let g = 0; g <= GRID; g++) if (!isNaN(c.grid[g]) && !isNaN(L.cur[g])) { sh++; if (Math.abs(c.grid[g] - L.cur[g]) < TOL) ok++; }
        let score = 0;
        if (sh >= Math.max(3, span * 0.2)) { if (ok / sh >= 0.75) score = ok; }
        else {
          const [l0, l1] = extent(L.cur);
          const gl = Math.round(l1 * GRID), gf = Math.round(l0 * GRID);
          if (c.u0 >= l1 - 0.04 && c.u0 - l1 < 0.04 && Math.abs(c.pts[0][1] - L.cur[gl]) < 0.05) score = 1;
          else if (c.u1 <= l0 + 0.04 && l0 - c.u1 < 0.04 && Math.abs(c.pts[c.pts.length - 1][1] - L.cur[gf]) < 0.05) score = 1;
        }
        if (score > bestScore) { bestScore = score; best = L; }
      }
      if (best) { best.ids.push(ci); best.cur = medianGrid(best.ids.map(i => cands[i])); }
      else lines.push({ ids: [ci], cur: c.grid.slice() });
    }
    // join lines that continue one another with little overlap
    for (let merged = true; merged;) {
      merged = false;
      outer: for (const A of lines) for (const B of lines) {
        if (A === B) continue;
        const [a0, a1] = extent(A.cur), [b0, b1] = extent(B.cur);
        if (!(b0 >= a0 && b0 <= a1 + 0.04 && b1 > a1 && a1 - b0 < 0.08)) continue;
        const g = Math.round(clamp((a1 + b0) / 2, b0, a1 + 0.04) * GRID);
        const va = sampleAt(curPts(A.cur), g / GRID) ?? A.cur[Math.round(a1 * GRID)];
        const vb = sampleAt(curPts(B.cur), g / GRID) ?? B.cur[Math.round(b0 * GRID)];
        if (Math.abs(va - vb) > 0.06) continue;
        A.ids.push(...B.ids); A.cur = medianGrid(A.ids.map(i => cands[i]));
        lines.splice(lines.indexOf(B), 1); merged = true; break outer;
      }
    }
    return lines.filter(L => { const [a, b] = extent(L.cur); return b - a >= minSpan; }).map(L => L.ids);
  }
  const curPts = cur => { const out = []; for (let i = 0; i <= GRID; i++) if (!isNaN(cur[i])) out.push([i / GRID, cur[i]]); return out; };

  /* ---------- pipeline ---------- */

  async function analyze(assetId, quad, ink = {}) {
    return analyzePx(await pixels(assetId), quad, ink);
  }

  function analyzePx(px, quad, ink = {}) {
    const rect = rectify(px, quad);
    const an = inkAnalysis(rect, ink);
    const cl = cluster(an, ink.k);
    const off = new Set(ink.disabled || []);
    const cands = [];
    cl.clusters.forEach((c, ci) => {
      if (off.has(ci)) return;
      for (const t of tracks(an, cl.labels, ci)) {
        const P = t.pts, r = 2;
        const pts = P.map((p, i) => {
          let s = 0, n = 0;
          for (let j = Math.max(0, i - r); j <= Math.min(P.length - 1, i + r); j++) { s += P[j][1]; n++; }
          return [p[0] / (an.w - 1), 1 - s / n / (an.h - 1)];
        });
        cands.push({ id: 'f' + cands.length, cluster: ci, color: c.hex, pts, grid: toGrid(pts), u0: pts[0][0], u1: pts[pts.length - 1][0] });
      }
    });
    const groups = groupCandidates(cands, ink.minSpan ?? 0.2);
    return { rect, an, clusters: cl.clusters, labels: cl.labels, cands, groups };
  }

  /** Distance between two weighted ink palettes ([[hex, weight]…]), average linkage in Lab. */
  function inkDistance(a, b) {
    if (!a?.length || !b?.length) return Infinity;
    let s = 0, wsum = 0;
    for (const [ha, wa] of a) for (const [hb, wb] of b) {
      const A = rgbToLab(...hexToRgb(ha)), B = rgbToLab(...hexToRgb(hb));
      s += wa * wb * Math.hypot((A[0] - B[0]) * 0.5, A[1] - B[1], A[2] - B[2]); wsum += wa * wb;
    }
    return s / wsum;
  }

  /**
   * Turn grouped fragments into map lines. `refs` (the previous lines, or the template's
   * line identities) are matched by ink colour first so names, keys and colours carry over
   * between sheets where each line is drawn with its own pen.
   */
  function linesFrom(res, refs = []) {
    const head = pts => { const k = Math.min(8, pts.length); let s = 0; for (let i = 0; i < k; i++) s += pts[i][1]; return s / k; };
    const lines = res.groups
      .map(g => g.map(i => res.cands[i]))
      .map(cs => ({ cs, pts: buildLine(cs) }))
      .filter(l => l.pts.length >= GRID * 0.06);
    lines.sort((a, b) => head(b.pts) - head(a.pts));
    for (const l of lines) {
      const span = new Map();
      for (const c of l.cs) span.set(c.color, (span.get(c.color) || 0) + (c.u1 - c.u0));
      const tot = [...span.values()].reduce((a, b) => a + b, 0) || 1;
      l.inks = [...span.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h, s]) => [h, round(s / tot, 3)]);
      l.ink = l.inks[0][0];
    }
    // match to references by ink, greedily from the closest pair
    const match = new Map(), used = new Set(), pairs = [];
    lines.forEach((l, i) => refs.forEach((r, j) => { const d = inkDistance(l.inks, r.inks || (r.ink && [[r.ink, 1]])); if (d < 42) pairs.push([d, i, j]); }));
    pairs.sort((a, b) => a[0] - b[0]);
    for (const [, i, j] of pairs) if (!match.has(i) && !used.has(j)) { match.set(i, j); used.add(j); }
    // unmatched lines fall back to unused references in order, then to fresh names
    const free = refs.map((r, j) => j).filter(j => !used.has(j) && !(refs[j].inks || refs[j].ink));
    lines.forEach((l, i) => { if (!match.has(i) && free.length) match.set(i, free.shift()); });
    const names = new Set(refs.map(r => r.name));
    let n = 0;
    const fresh = () => { do n++; while (names.has(`Line ${n}`)); names.add(`Line ${n}`); return `Line ${n}`; };
    const out = lines.map((l, i) => {
      const r = match.has(i) ? refs[match.get(i)] : null, name = r?.name || fresh();
      return {
        id: r?.id || uid('l'), name, key: r?.key || name,
        color: r?.color || vivid(l.ink) || PALETTE[i % PALETTE.length], ink: l.ink, inks: l.inks, visible: true,
        pts: l.pts, cands: l.cs.map(c => c.id), adj: r?.adj ? clone(r.adj) : { dy: 0, sy: 1, smooth: 0 },
        _order: r ? refs.indexOf(r) : 1000 + i,
      };
    });
    return out.sort((a, b) => a._order - b._order).map(({ _order, ...l }) => l);
  }

  return { loadImg, pixels, detectFrame, analyzePx, rectify, inkAnalysis, cluster, tracks, analyze, linesFrom, buildLine, polyToLine, GRID };
})();
