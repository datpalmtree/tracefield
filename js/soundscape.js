'use strict';
/* =====================================================================
   Tracefield · soundscape
   audio library, per-place voices, felt-time drive (graph lines steer
   tempo / loudness / brightness / space), recorded ⟷ felt crossfade,
   spatial levels, and the synthetic demo sounds
   ===================================================================== */

const AUDIO = new Map(); // id → { blob, name, type, size, dur, peaks }

const AudioLib = {
  EXT: /\.(wav|wave|mp3|m4a|mp4|aac|ogg|oga|opus|flac|webm|aif|aiff)$/i,
  isAudio(f) { return f.type.startsWith('audio/') || this.EXT.test(f.name); },

  async sameBytes(x, y) {
    const STEP = 8e6;
    try {
      for (let at = 0; at < x.size; at += STEP) {
        const [p, q] = await Promise.all([x, y].map(b => b.slice(at, at + STEP).arrayBuffer()));
        const P = new Uint8Array(p), Q = new Uint8Array(q);
        for (let i = 0; i < P.length; i++) if (P[i] !== Q[i]) return false;
      }
      return x.size === y.size;
    } catch { return false; }
  },

  /** Points sharing an id each still get their own player, so sharing cannot affect playback. */
  async add(file) {
    for (const [id, known] of AUDIO) {
      if (known.size === file.size && await this.sameBytes(known.blob, file)) {
        toast(`${file.name} is already in this project, so it shares that copy.`);
        return id;
      }
    }
    const a = { blob: file, name: file.name, type: file.type, size: file.size, dur: 0, peaks: null };
    await this.analyse(a);
    const id = uid('s');
    AUDIO.set(id, a);
    Store.put('audio', id, a);
    return id;
  },

  /** Waveform + duration. Very long files skip the decode and only read the duration. */
  async analyse(a) {
    if (a.size < 250e6) {
      try {
        const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await a.blob.arrayBuffer());
        a.dur = buf.duration;
        a.peaks = this.peaks(buf);
        return;
      } catch (err) { console.warn('decode', err); }
    }
    a.dur = await new Promise((res, rej) => {
      const url = URL.createObjectURL(a.blob), m = new Audio();
      const done = fn => v => { URL.revokeObjectURL(url); fn(v); };
      m.preload = 'metadata';
      m.onloadedmetadata = done(() => res(m.duration));
      m.onerror = done(() => rej(new Error('this browser cannot play this file (try WAV, MP3, M4A or OGG)')));
      m.src = url;
    });
  },

  peaks(buf, N = 480) {
    const out = new Array(N).fill(0), L = buf.length, chs = Math.min(buf.numberOfChannels, 2);
    for (let c = 0; c < chs; c++) {
      const d = buf.getChannelData(c), step = Math.max(1, Math.floor(L / N / 40));
      for (let i = 0; i < N; i++) {
        let m = out[i];
        for (let j = Math.floor(i * L / N), e = Math.floor((i + 1) * L / N); j < e; j += step) { const v = Math.abs(d[j]); if (v > m) m = v; }
        out[i] = m;
      }
    }
    const mx = Math.max(...out) || 1;
    return out.map(v => round(v / mx, 3));
  },

  used() {
    const ids = new Set();
    for (const p of S.atlas.places) { if (p.audio) ids.add(p.audio); if (p.felt) ids.add(p.felt); }
    return ids;
  },

  async load() {
    const used = this.used();
    for (const k of (await Store.keys('audio')) || []) {
      if (!used.has(k)) { Store.del('audio', k); continue; }
      const a = await Store.get('audio', k);
      if (a) AUDIO.set(k, a);
    }
  },

  /** Repoints points at one copy of identical files. Stored spares go at the next load(), after the state has saved. */
  async merge() {
    const kept = [], repoint = new Map();
    for (const id of this.used()) {
      const a = AUDIO.get(id);
      if (!a) continue;
      let same = null;
      for (const k of kept) if (AUDIO.get(k).size === a.size && await this.sameBytes(AUDIO.get(k).blob, a.blob)) { same = k; break; }
      if (same) repoint.set(id, same); else kept.push(id);
    }
    for (const p of S.atlas.places) for (const slot of ['audio', 'felt']) if (repoint.has(p[slot])) p[slot] = repoint.get(p[slot]);
    for (const id of repoint.keys()) AUDIO.delete(id);
    return repoint.size;
  },

  /** Older .json project files hold their audio as base64. */
  fromDataUrl(url) {
    const [head, b64] = url.split(','), bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: head.slice(5).split(';')[0] });
  },
};

const fmtTime = s => { if (!isFinite(s) || s < 0) s = 0; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

/** Lines a place can be driven by: a map's visible lines, or a lens's group averages. */
function graphLines(item) {
  if (item?.type === 'map') return item.lines.filter(l => l.visible).map(l => ({ id: l.id, name: l.name, color: l.color, pts: Plot.effective(l) }));
  if (item?.type === 'lens') return [...Plot.lensData(item).agg].map(([g, a]) => ({ id: 'avg:' + g, name: '⌀ ' + g, color: a.color, pts: a.mean }));
  return [];
}

const DRIVE_TARGETS = [
  ['tempo', 'Tempo', 'High on the line = faster, low = slower. Depth is in octaves of speed (1 = half to double).', 1],
  ['gain', 'Emphasis', 'High on the line = louder, low = quieter. Depth 1 = ±12 dB.', 0.75],
  ['bright', 'Brightness', 'High on the line = open and clear, low = muffled, as if heard from far away.', 1],
  ['space', 'Space', 'High on the line = more reverb, for a dreamlike or distant quality.', 0.8],
];
function defaultDrive() {
  const d = { graph: null, keepPitch: true, feltToo: false };
  for (const [k, , , depth] of DRIVE_TARGETS) d[k] = { line: null, depth, inv: false };
  return d;
}

const Scape = (() => {
  const N = 256;
  const voices = new Map();
  let ctx = null, bus = null, reverb = null, mix = 1, onEnded = () => {};

  function ensure() {
    if (!Sound.ensure()) { toast('This browser has no Web Audio support.', 'bad'); return false; }
    ctx = Sound.ctx;
    if (!bus) {
      bus = ctx.createGain(); bus.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      bus.connect(comp); comp.connect(ctx.destination);
      reverb = ctx.createConvolver(); reverb.buffer = impulse(2.8); reverb.connect(bus);
    }
    return true;
  }

  function impulse(secs) {
    const L = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(2, L, ctx.sampleRate), rnd = mulberry32(7);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < L; i++) d[i] = (rnd() * 2 - 1) * (1 - i / L) ** 2.6; }
    return b;
  }

  function clip(assetId, loop) {
    const a = AUDIO.get(assetId);
    if (!a) return null;
    const m = new Audio(URL.createObjectURL(a.blob));
    m.preload = 'auto'; m.loop = loop;
    const gain = ctx.createGain();
    ctx.createMediaElementSource(m).connect(gain);
    return { el: m, gain, a };
  }

  /** Drive value per position, −1…1, sampled ahead of time so ticks stay cheap. */
  function curve(place, key) {
    const t = place.drive?.[key];
    if (!t?.line) return null;
    const ln = graphLines(getItem(place.drive.graph)).find(l => l.id === t.line);
    if (!ln || ln.pts.length < 2) return null;
    const out = new Float32Array(N + 1);
    let last = ln.pts[0][1];
    for (let i = 0; i <= N; i++) {
      const v = sampleAt(ln.pts, i / N);
      if (v != null) last = v;
      out[i] = clamp((last - 0.5) * 2, -1, 1) * (t.inv ? -1 : 1);
    }
    return out;
  }
  const read = (c, u) => c ? c[Math.round(clamp(u, 0, 1) * N)] : 0;
  const rateOf = (place, x) => clamp(2 ** (x * (place.drive?.tempo?.depth ?? 1)), 0.25, 4);

  /** How much felt time has passed at each position of the recording. */
  function feltTable(place, tempo) {
    if (!tempo) return null;
    const out = new Float32Array(N + 1);
    for (let i = 1; i <= N; i++) out[i] = out[i - 1] + 1 / N / rateOf(place, tempo[i]);
    return out;
  }

  function prepare(v) {
    const p = v.place;
    v.curves = { tempo: curve(p, 'tempo'), gain: curve(p, 'gain'), bright: curve(p, 'bright'), space: curve(p, 'space') };
    v.table = feltTable(p, v.curves.tempo);
    v.driven = !p.felt || !!p.drive?.feltToo;
    for (const c of [v.a, v.b]) if (c) c.el.preservesPitch = !v.driven || p.drive?.keepPitch !== false;
  }

  const leadOf = v => v.b && mix >= 0.5 ? v.b : v.a;

  function finish(v) {
    if (!v.playing) return;
    v.playing = false;
    v.level.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
    v.a.el.pause(); v.b?.el.pause();
    onEnded(v.place.id);
  }

  /** The other clip matches the lead by speed, not seeking, so the lead is never interrupted. */
  function follow(v, lead, rate) {
    const f = lead === v.a ? v.b : v.a, ld = lead.el.duration, fd = f.el.duration;
    if (!(ld > 0 && fd > 0 && isFinite(ld) && isFinite(fd))) return;
    if (f.el.paused && !f.el.ended) f.el.play().catch(() => {});
    let drift = f.el.currentTime / fd - v.u;
    if (f.el.loop) drift -= Math.round(drift);
    let off = drift * fd;
    if (Math.abs(off) > 1.5) { f.el.currentTime = v.u * fd; off = 0; }
    const nudge = Math.abs(off) > 0.05 ? clamp(1 - off * 0.5, 0.9, 1.1) : 1;
    f.el.playbackRate = clamp(rate * fd / ld * nudge, 0.25, 4);
  }

  function voice(place) {
    let v = voices.get(place.id);
    if (v) { v.place = place; prepare(v); return v; }
    if (!ensure()) return null;
    const rec = place.audio && clip(place.audio, true), felt = place.felt && clip(place.felt, true);
    if (!rec && !felt) return null;
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 20000; filter.Q.value = 0.4;
    const emph = ctx.createGain(), pan = ctx.createStereoPanner(), level = ctx.createGain(), send = ctx.createGain(), an = ctx.createAnalyser();
    level.gain.value = 0; send.gain.value = 0; an.fftSize = 512;
    for (const c of [rec, felt]) if (c) c.gain.connect(filter);
    filter.connect(emph); emph.connect(pan); pan.connect(level); level.connect(an); an.connect(bus); level.connect(send); send.connect(reverb);
    v = { key: `${place.audio}|${place.felt}`, place, a: rec || felt, b: rec && felt ? felt : null, rec: !!rec, filter, emph, pan, level, send, an, buf: new Float32Array(an.fftSize), target: 0, playing: false, lv: 0, rate: 1, u: 0 };
    for (const c of [v.a, v.b]) if (c) c.el.addEventListener('ended', () => { if (c === leadOf(v)) finish(v); });
    prepare(v);
    voices.set(place.id, v);
    return v;
  }

  function play(place, o = {}) {
    if (!ensure()) return false;
    const v = voice(place);
    if (!v) return false;
    v.target = o.level ?? (place.vol ?? 1);
    v.pan.pan.setTargetAtTime(o.pan ?? 0, ctx.currentTime, 0.05);
    v.a.el.loop = !!o.loop;
    if (v.b) v.b.el.loop = !!o.loop;
    if (o.from != null) seek(place.id, o.from);
    else if (leadOf(v).el.ended) seek(place.id, 0);
    v.playing = true;
    clearTimeout(v.fade);
    v.level.gain.setTargetAtTime(v.target, ctx.currentTime, 0.08);
    for (const c of [v.a, v.b]) if (c) c.el.play().catch(err => {
      if (err.name === 'AbortError') return;
      console.warn(err); toast(`Could not play ${c.a.name}: ${err.message}`, 'bad');
    });
    tickVoice(v);
    return true;
  }

  function pause(id) {
    const v = voices.get(id);
    if (!v || !v.playing) return;
    v.playing = false;
    v.level.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    clearTimeout(v.fade);
    v.fade = setTimeout(() => { v.a.el.pause(); v.b?.el.pause(); }, 220);
  }

  function seek(id, u) {
    const v = voices.get(id);
    if (!v) return;
    for (const c of [v.a, v.b]) if (c && isFinite(c.el.duration)) c.el.currentTime = clamp(u, 0, 0.999) * c.el.duration;
    v.u = clamp(u, 0, 1);
  }

  function drop(id) {
    const v = voices.get(id);
    if (!v) return;
    v.playing = false;
    for (const c of [v.a, v.b]) if (c) { c.el.pause(); URL.revokeObjectURL(c.el.src); c.gain.disconnect(); }
    v.level.disconnect(); v.send.disconnect(); v.an.disconnect();
    voices.delete(id);
  }

  function tickVoice(v) {
    const t = ctx.currentTime, lead = leadOf(v), dur = lead.el.duration;
    if (lead.el.ended) { finish(v); return; }
    if (isFinite(dur) && dur > 0) v.u = clamp(lead.el.currentTime / dur, 0, 1);
    const u = v.u, c = v.curves;
    const x = read(c.tempo, u), d = v.place.drive || {};
    v.rate = rateOf(v.place, x);
    const amt = v.driven ? mix : 0, rate = lerp(1, v.rate, amt);
    lead.el.playbackRate = rate;
    if (v.b) {
      follow(v, lead, rate);
      v.a.gain.gain.setTargetAtTime(Math.cos(mix * Math.PI / 2), t, 0.04);
      v.b.gain.gain.setTargetAtTime(Math.sin(mix * Math.PI / 2), t, 0.04);
    } else {
      v.a.gain.gain.setTargetAtTime(1, t, 0.04);
    }
    const gdb = read(c.gain, u) * (d.gain?.depth ?? 0) * 12 * amt;
    v.emph.gain.setTargetAtTime(10 ** (gdb / 20), t, 0.09);
    const b = c.bright ? read(c.bright, u) : 1;
    const octaves = (1 - b) * 3 * (d.bright?.depth ?? 1) * (c.bright ? amt : 0);
    v.filter.frequency.setTargetAtTime(20000 / 2 ** octaves, t, 0.1);
    v.send.gain.setTargetAtTime(c.space ? (read(c.space, u) + 1) / 2 * (d.space?.depth ?? 0) * amt : 0, t, 0.12);
    v.an.getFloatTimeDomainData(v.buf);
    let e = 0;
    for (let i = 0; i < v.buf.length; i++) e += v.buf[i] * v.buf[i];
    v.lv += (Math.min(1, Math.sqrt(e / v.buf.length) * 3.4) - v.lv) * 0.35;
  }

  function tick() {
    if (!ctx) return;
    for (const v of voices.values()) {
      if (v.playing) tickVoice(v);
      else v.lv *= 0.86;
    }
  }

  function state(id) {
    const v = voices.get(id);
    if (!v) return null;
    const dur = isFinite(v.a.el.duration) ? v.a.el.duration : 0, u = v.u;
    const base = v.b && isFinite(v.b.el.duration) ? v.b.el.duration : dur;
    let felt = u * base, feltDur = base;
    if (v.driven && v.table) { felt = v.table[Math.round(u * N)] * base; feltDur = v.table[N] * base; }
    return { playing: v.playing, u, dur, clock: u * dur, felt, feltDur, rate: v.rate, level: v.lv, x: read(v.curves.tempo, u) };
  }

  return {
    ensure, play, pause, seek, drop, tick, state, voices,
    /** Move a voice's level + pan without restarting it (soundwalk). */
    spatial(id, level, pan) {
      const v = voices.get(id);
      if (!v) return;
      v.target = level;
      v.level.gain.setTargetAtTime(level, ctx.currentTime, 0.14);
      v.pan.pan.setTargetAtTime(pan, ctx.currentTime, 0.14);
    },
    refresh(place) { const v = voices.get(place.id); if (v) { v.place = place; prepare(v); } },
    stopAll() { for (const id of voices.keys()) pause(id); },
    dropAll() { for (const id of [...voices.keys()]) drop(id); },
    isPlaying: id => !!voices.get(id)?.playing,
    level: id => voices.get(id)?.lv ?? 0,
    get mix() { return mix; },
    set mix(v) { mix = clamp(v, 0, 1); },
    set onEnded(f) { onEnded = f; },
  };
})();

/* =====================================================================
   Demo sounds: synthesised on the fly so the repo ships no recordings.
   They are placeholders, not real soundscapes.
   ===================================================================== */
const DemoSound = (() => {
  const SR = 22050;
  function noise(c, secs, seed) {
    const b = c.createBuffer(1, Math.floor(secs * c.sampleRate), c.sampleRate), d = b.getChannelData(0), rnd = mulberry32(seed);
    let last = 0;
    for (let i = 0; i < d.length; i++) { last = last * 0.82 + (rnd() * 2 - 1) * 0.18; d[i] = last * 2.4; }
    const s = c.createBufferSource(); s.buffer = b;
    return s;
  }
  function band(c, src, type, f, q) { const n = c.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; src.connect(n); return n; }
  function tone(c, out, t, dur, f0, f1, g, type = 'sine') {
    const o = c.createOscillator(), a = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(g, t + dur * 0.2); a.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(a); a.connect(out); o.start(t); o.stop(t + dur + 0.02);
  }
  const SCENES = {
    forest(c, secs, rnd) {
      const wind = c.createGain(); wind.gain.value = 0.3;
      for (let t = 0; t < secs; t += 2) wind.gain.linearRampToValueAtTime(0.16 + rnd() * 0.3, t);
      band(c, noise(c, secs, 3), 'lowpass', 900, 0.5).connect(wind); wind.connect(c.destination);
      for (let t = 0.6; t < secs - 1; t += 0.5 + rnd() * 1.6) {
        const f = 2200 + rnd() * 2400, n = 2 + Math.floor(rnd() * 4);
        for (let k = 0; k < n; k++) tone(c, c.destination, t + k * 0.13, 0.1, f, f * (1 + rnd() * 0.3), 0.14);
      }
    },
    harbour(c, secs, rnd) {
      const sw = c.createGain(); sw.gain.value = 0.3;
      for (let t = 0; t < secs; t += 3.2) { sw.gain.linearRampToValueAtTime(0.55, t + 1.5); sw.gain.linearRampToValueAtTime(0.14, t + 3.2); }
      band(c, noise(c, secs, 5), 'lowpass', 520, 0.7).connect(sw); sw.connect(c.destination);
      for (let t = 3; t < secs - 3; t += 7 + rnd() * 5) { tone(c, c.destination, t, 2.6, 110, 106, 0.22, 'sawtooth'); tone(c, c.destination, t, 2.6, 165, 160, 0.1, 'triangle'); }
      for (let t = 1; t < secs - 1; t += 2 + rnd() * 3.5) tone(c, c.destination, t, 0.42, 1500 + rnd() * 500, 950, 0.1);
    },
    city(c, secs, rnd) {
      const hum = c.createGain(); hum.gain.value = 0.34;
      band(c, noise(c, secs, 9), 'lowpass', 340, 0.8).connect(hum); hum.connect(c.destination);
      for (let t = 0.4; t < secs - 3; t += 1.2 + rnd() * 2.8) {
        const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
        f.frequency.setValueAtTime(380, t); f.frequency.linearRampToValueAtTime(1100, t + 1.2); f.frequency.linearRampToValueAtTime(320, t + 2.6);
        const a = c.createGain(); a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.4, t + 1.2); a.gain.linearRampToValueAtTime(0, t + 2.6);
        const s = noise(c, 3, 11 + Math.floor(t)); s.connect(f); f.connect(a); a.connect(c.destination); s.start(t);
      }
      for (let t = 2; t < secs - 1; t += 3 + rnd() * 5) tone(c, c.destination, t, 0.7, 1320, 1310, 0.08, 'triangle');
    },
  };
  function wav(buf) {
    const d = buf.getChannelData(0), out = new DataView(new ArrayBuffer(44 + d.length * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + d.length * 2, true); str(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, d.length * 2, true);
    for (let i = 0; i < d.length; i++) out.setInt16(44 + i * 2, clamp(d[i], -1, 1) * 32767, true);
    return new Blob([out], { type: 'audio/wav' });
  }
  /** Scenes wire up their noise beds; anything not started on a schedule starts at zero. */
  async function render(kind, secs, seed = 1) {
    const c = new OfflineAudioContext(1, Math.floor(secs * SR), SR), rnd = mulberry32(seed);
    const started = [], orig = c.createBufferSource.bind(c);
    c.createBufferSource = () => { const s = orig(); started.push(s); return s; };
    SCENES[kind](c, secs, rnd);
    for (const s of started) { try { s.start(0); } catch { /* already scheduled */ } }
    return c.startRendering();
  }
  /** A re-designed take: the recording time-warped by a felt-pace line (tape-style). */
  async function warp(buf, pts) {
    const rate = u => clamp(2 ** ((sampleAt(pts, clamp(u, pts[0][0], pts[pts.length - 1][0])) - 0.5) * 2), 0.4, 2.5);
    let len = 0;
    for (let i = 0; i < 400; i++) len += buf.duration / 400 / rate((i + 0.5) / 400);
    const c = new OfflineAudioContext(1, Math.ceil(len * SR), SR), s = c.createBufferSource(), curve = new Float32Array(400);
    // resample so the curve advances in listening time, not in recording time
    let u = 0;
    for (let i = 0; i < 400; i++) { const r = rate(u); curve[i] = r; u = Math.min(1, u + len / 400 * r / buf.duration); }
    s.buffer = buf; s.connect(c.destination);
    s.playbackRate.setValueCurveAtTime(curve, 0, len);
    s.start(0);
    return c.startRendering();
  }
  return { render, warp, wav };
})();
