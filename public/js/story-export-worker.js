// Final video engine for the footage story (step 3). Runs in a background worker.
// Reads only the parts of each original it needs (fine for 1 GB+ files), mixes the footage
// sound with your narration (footage turned down under the narration, volumes evened out),
// draws every frame at full resolution with optional captions, and writes an MP4 to disk.

/* global MP4Box, DataStream, Mp4Muxer, CaseDraw */
importScripts('/vendor/mp4box.js', '/vendor/mp4-muxer.js', '/js/draw.js');

const FPS = 30;
const SR = 48000;
const FADE = 0.25;           // picture crossfade between segments, seconds
let cancelled = false;

self.onmessage = async e => {
  if (e.data.type === 'cancel') { cancelled = true; return; }
  if (e.data.type !== 'start') return;
  try {
    await run(e.data.job);
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

const post = (type, data) => self.postMessage({ type, ...data });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtTime = t => { t = Math.max(0, Math.round(t || 0)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };

// ---------- reading a source file in pieces ----------
class Src {
  constructor(blob, name) { this.blob = blob; this.name = name || 'file'; }

  async open() {
    if (this.ready) return this;
    const blob = this.blob, size = blob.size, CH = 4 * 1024 * 1024;
    const mp4 = MP4Box.createFile();
    let info = null, perr = null;
    mp4.onReady = i => { info = i; };
    mp4.onError = e => { perr = e; };
    let pos = 0;
    while (!info && !perr && pos < size) {
      const ab = await blob.slice(pos, pos + CH).arrayBuffer();
      ab.fileStart = pos;
      const next = mp4.appendBuffer(ab);
      pos = (typeof next === 'number' && next > pos) ? next : pos + ab.byteLength;
    }
    if (!info) throw new Error(`"${this.name}" could not be read.`);
    const vt = info.videoTracks[0], at = info.audioTracks[0];
    if (vt) {
      const trak = mp4.getTrackById(vt.id);
      let description;
      for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
        if (box) { const st = new DataStream(undefined, 0, DataStream.BIG_ENDIAN); box.write(st); description = new Uint8Array(st.buffer, 8); break; }
      }
      this.v = {
        config: { codec: vt.codec, codedWidth: vt.video.width, codedHeight: vt.video.height, description },
        samples: trak.samples.map(s => ({ offset: s.offset, size: s.size, cts: s.cts / s.timescale, dts: s.dts / s.timescale, dur: s.duration / s.timescale, key: s.is_sync })).sort((a, b) => a.dts - b.dts),
        w: vt.video.width, h: vt.video.height,
      };
      const ok = await VideoDecoder.isConfigSupported(this.v.config).catch(() => ({ supported: false }));
      if (!ok.supported) { this.vErr = `This browser can't decode the video in "${this.name}" (${vt.codec}).`; this.v = null; }
    }
    if (at) {
      const trak = mp4.getTrackById(at.id);
      let description;
      try {
        const entry = trak.mdia.minf.stbl.stsd.entries[0];
        const dsi = entry.esds && entry.esds.esd && entry.esds.esd.descs[0] && entry.esds.esd.descs[0].descs[0];
        if (dsi && dsi.data) description = new Uint8Array(dsi.data);
      } catch (e) { /* no extra config */ }
      const config = { codec: at.codec === 'mp4a' ? 'mp4a.40.2' : at.codec, sampleRate: at.audio.sample_rate, numberOfChannels: at.audio.channel_count, description };
      const ok = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (ok.supported) {
        this.a = { config, samples: trak.samples.map(s => ({ offset: s.offset, size: s.size, cts: s.cts / s.timescale, dur: s.duration / s.timescale })).sort((a, b) => a.cts - b.cts) };
      } else this.aErr = `This browser can't decode the sound in "${this.name}" (${at.codec}).`;
    }
    this.ready = true;
    return this;
  }

  // Reads the bytes of several samples with one read
  async readBatch(list) {
    const lo = Math.min(...list.map(s => s.offset)), hi = Math.max(...list.map(s => s.offset + s.size));
    const buf = await this.blob.slice(lo, hi).arrayBuffer();
    return list.map(s => new Uint8Array(buf, s.offset - lo, s.size));
  }
}

// Gives the decoded frame for any time, reading and decoding only what's needed
class Frames {
  constructor(src) { this.src = src; this.queue = []; this.cur = null; this.waiters = []; this.last = -1; }

  restart(t) {
    if (this.dec) try { this.dec.close(); } catch (e) { /* closed */ }
    this.queue.forEach(f => f.close()); this.queue = [];
    if (this.cur) { this.cur.close(); this.cur = null; }
    this.flushed = false; this.err = null;
    this.dec = new VideoDecoder({ output: f => { this.queue.push(f); this.wake(); }, error: e => { this.err = e; this.wake(); } });
    this.dec.configure(this.src.v.config);
    const s = this.src.v.samples;
    let k = 0;
    for (let i = 0; i < s.length; i++) { if (s[i].key && s[i].cts <= t + 0.001) k = i; if (s[i].dts > t) break; }
    this.next = k;
  }

  wake() { const w = this.waiters; this.waiters = []; w.forEach(r => r()); }
  waitOutput() { return new Promise(r => { this.waiters.push(r); setTimeout(r, 150); }); }

  async feed() {
    const s = this.src.v.samples;
    if (this.next >= s.length || this.dec.decodeQueueSize >= 8 || this.queue.length >= 10) return;
    const batch = [];
    let bytes = 0;
    while (this.next + batch.length < s.length && batch.length < 30 && bytes < 24e6) { const x = s[this.next + batch.length]; batch.push(x); bytes += x.size; }
    const data = await this.src.readBatch(batch);
    batch.forEach((x, i) => {
      this.dec.decode(new EncodedVideoChunk({ type: x.key ? 'key' : 'delta', timestamp: Math.round(x.cts * 1e6), duration: Math.round(x.dur * 1e6), data: data[i] }));
    });
    this.next += batch.length;
  }

  async frameAt(t) {
    if (this.last < 0 || t + 0.001 < this.last || t - this.last > 8) this.restart(t);
    this.last = t;
    const us = t * 1e6;
    for (let guard = 0; guard < 20000; guard++) {
      if (this.err) throw this.err;
      while (this.queue.length && this.queue[0].timestamp <= us + 1000) { if (this.cur) this.cur.close(); this.cur = this.queue.shift(); }
      if (this.queue.length || this.flushed) break;
      if (this.next < this.src.v.samples.length) { await this.feed(); await this.waitOutput(); } else { await this.dec.flush(); this.flushed = true; }
    }
    if (!this.cur && this.queue.length) this.cur = this.queue.shift();
    return this.cur;
  }

  close() {
    try { this.dec.close(); } catch (e) { /* closed */ }
    this.queue.forEach(f => f.close()); if (this.cur) this.cur.close();
    this.queue = []; this.cur = null;
  }
}

// Sound of a source from `from` for `dur` seconds, as mono at 48 kHz
async function soundOf(src, from, dur) {
  const n = Math.max(0, Math.round(dur * SR));
  const out = new Float32Array(n);
  if (!src.a || !n) return out;
  const list = src.a.samples.filter(s => s.cts + s.dur > from - 0.05 && s.cts < from + dur + 0.05);
  if (!list.length) return out;
  const chunks = [];
  let err = null;
  const dec = new AudioDecoder({
    output: d => {
      const ch = d.numberOfChannels, len = d.numberOfFrames;
      const mono = new Float32Array(len);
      for (let c = 0; c < ch; c++) {
        const tmp = new Float32Array(len);
        d.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < len; i++) mono[i] += tmp[i] / ch;
      }
      chunks.push({ t: d.timestamp / 1e6, rate: d.sampleRate, data: mono });
      d.close();
    },
    error: e => { err = e; },
  });
  dec.configure(src.a.config);
  for (let i = 0; i < list.length; i += 200) {
    const part = list.slice(i, i + 200);
    const data = await src.readBatch(part);
    part.forEach((s, k) => dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(s.cts * 1e6), duration: Math.round(s.dur * 1e6), data: data[k] })));
    while (dec.decodeQueueSize > 50) await sleep(1);
  }
  await dec.flush();
  dec.close();
  if (err) throw err;
  // Place each decoded piece where it belongs, converting to 48 kHz
  for (const c of chunks) {
    const startIdx = Math.ceil((c.t - from) * SR);
    const endIdx = Math.min(n, Math.floor((c.t + c.data.length / c.rate - from) * SR));
    for (let i = Math.max(0, startIdx); i < endIdx; i++) {
      const p = ((from + i / SR) - c.t) * c.rate;
      const j = Math.floor(p), f = p - j;
      const a = c.data[j] || 0, b = c.data[j + 1] !== undefined ? c.data[j + 1] : a;
      out[i] = a + (b - a) * f;
    }
  }
  return out;
}

// Brings a piece of sound to an even loudness (quiet bodycams up, loud ones down)
// Brings a piece of sound to the same loudness as everything else. Measures the speech, not the
// pauses, so a quiet interview with long silences is turned up properly (up to about 23 dB).
function level(x, target) {
  const F = 2400; // 50 ms
  const frames = [];
  for (let i = 0; i + F <= x.length; i += F) {
    let s = 0;
    for (let k = i; k < i + F; k += 2) s += x[k] * x[k];
    frames.push(Math.sqrt(s / (F / 2)));
  }
  if (!frames.length) return x;
  const sorted = [...frames].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
  const gate = Math.max(0.002, loud * 0.1);
  let p = 0, n = 0;
  for (const r of frames) if (r >= gate) { p += r * r; n++; }
  if (!n) return x;
  const speech = Math.sqrt(p / n);
  const g = Math.max(0.3, Math.min(14, target / speech));
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

function fadeEdges(x, sec = 0.03) {
  const n = Math.min(Math.round(sec * SR), x.length >> 1);
  for (let i = 0; i < n; i++) { const g = i / n; x[i] *= g; x[x.length - 1 - i] *= g; }
  return x;
}

// Swear words: silence (or bleep) exact stretches of a sound, with tiny fades so there's no click.
// ranges are in seconds from the start of this piece of sound.
function muteWords(x, ranges, how) {
  const F = Math.round(0.012 * SR);
  for (const [a, b] of ranges) {
    const i0 = Math.max(0, Math.round(a * SR)), i1 = Math.min(x.length, Math.round(b * SR));
    for (let i = i0; i < i1; i++) {
      const edge = Math.min(1, (i - i0) / F, (i1 - 1 - i) / F); // 0 at the edges, 1 inside
      const tone = how === 'bleep' ? 0.16 * Math.sin(2 * Math.PI * 1000 * i / SR) : 0; // turned down with the footage under narration
      x[i] = x[i] * (1 - Math.max(0, edge)) + tone * Math.max(0, edge);
    }
  }
}

// Soft limiter so peaks never clip
const limit = v => { const a = Math.abs(v); return a <= 0.65 ? v : Math.sign(v) * (0.65 + 0.22 * Math.tanh((a - 0.65) / 0.22)); };

// ---------- main ----------
async function pickVideoCodec(W, H, bitrate) {
  for (const o of [{ codec: 'avc1.640028', muxer: 'avc' }, { codec: 'avc1.4d0028', muxer: 'avc' }, { codec: 'vp09.00.40.08', muxer: 'vp9' }]) {
    const cfg = { codec: o.codec, width: W, height: H, bitrate, framerate: FPS, latencyMode: 'quality' };
    if (o.muxer === 'avc') cfg.avc = { format: 'avc' };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { ...o, cfg }; } catch (e) { /* next */ }
  }
  throw new Error('This browser cannot encode video. Please use an up-to-date Chrome.');
}

async function run(job) {
  const [W, H] = job.aspect === '9:16' ? [1080, 1920] : [1920, 1080];
  const v = await pickVideoCodec(W, H, job.bitrate || 10_000_000);
  let aac = false;
  try { aac = (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, bitrate: 192000 })).supported; } catch (e) { aac = false; }

  const srcs = {};
  for (const [id, s] of Object.entries(job.sources)) srcs[id] = new Src(s.blob, s.name);
  const problems = [];
  const segs = job.segs;
  const total = segs.length ? segs[segs.length - 1].t0 + segs[segs.length - 1].dur : 0;

  let writable = null, target;
  if (job.fileHandle) { writable = await job.fileHandle.createWritable(); target = new Mp4Muxer.FileSystemWritableFileStreamTarget(writable); }
  else target = new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer({
    target,
    video: { codec: v.muxer, width: W, height: H, frameRate: FPS },
    audio: { codec: aac ? 'aac' : 'opus', numberOfChannels: 2, sampleRate: SR },
    fastStart: writable ? false : 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  const abort = async msg => { if (writable) { try { await writable.abort(); } catch (e) { /* ignore */ } } post('cancelled', { message: msg }); };
  const t0 = Date.now();

  // 1) Sound, segment by segment (keeps memory low even for a 40-minute video)
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { throw e; } });
  aenc.configure({ codec: aac ? 'mp4a.40.2' : 'opus', sampleRate: SR, numberOfChannels: 2, bitrate: 192000 });
  const narr = job.narration;
  let written = 0;
  for (let si = 0; si < segs.length; si++) {
    if (cancelled) return abort('Export cancelled');
    const sg = segs[si];
    const startIdx = Math.round(sg.t0 * SR);
    const n = Math.round((sg.t0 + sg.dur) * SR) - startIdx;
    const mix = new Float32Array(n);
    for (const snd of sg.sound || []) {
      const src = srcs[snd.sid];
      try {
        await src.open();
        if (src.aErr && !src.aWarned) { problems.push(src.aErr); src.aWarned = true; }
        const at = Math.round((snd.at || 0) * SR);
        const x = fadeEdges(level(await soundOf(src, snd.from, snd.len || sg.dur), 0.11));
        if (snd.mute) muteWords(x, snd.mute, job.muteHow);
        for (let i = 0; i < x.length && at + i < n; i++) mix[at + i] += x[i] * snd.gain;
      } catch (e) { problems.push(`Sound of "${src.name}" at ${fmtTime(sg.t0)}: ${e.message}`); }
    }
    if (sg.narr && narr) {
      const a = Math.round(sg.narr.a0 * SR), len = Math.round(sg.narr.len * SR), off = Math.round((sg.narr.lead || 0) * SR);
      for (let i = 0; i < len && off + i < n; i++) mix[off + i] += (narr[a + i] || 0) * (job.narrGain || 1);
    }
    // stereo out, limited
    for (let i = 0; i < n; i += 4800) {
      const len = Math.min(4800, n - i);
      const data = new Float32Array(len * 2);
      for (let k = 0; k < len; k++) { const s = limit(mix[i + k]); data[k] = s; data[len + k] = s; }
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round((startIdx + i) * 1e6 / SR), data });
      aenc.encode(ad); ad.close();
      if (aenc.encodeQueueSize > 30) await sleep(1);
    }
    written += n;
    post('progress', { frac: 0.1 * (si + 1) / segs.length, text: `Mixing sound ${fmtTime(sg.t0 + sg.dur)} of ${fmtTime(total)}` });
  }
  await aenc.flush(); aenc.close();

  // 2) Picture, frame by frame
  let encErr = null;
  const enc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { encErr = e; } });
  enc.configure(v.cfg);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  // captions and the logo go on a separate layer, so they don't end up in the crossfade picture
  const layered = !!(job.captions || job.watermark);
  const out = layered ? new OffscreenCanvas(W, H) : canvas;
  const octx = layered ? out.getContext('2d', { alpha: false }) : ctx;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);

  const frames = new Map(); // source id -> Frames reader
  const reader = async sid => {
    const src = srcs[sid];
    await src.open();
    if (!src.v) return null;
    if (!frames.has(sid)) frames.set(sid, new Frames(src));
    return frames.get(sid);
  };
  const frameMode = src => { const r = (src.v.w / src.v.h) / (W / H); return { mode: r < 0.9 || r > 1.11 ? 'fit' : 'fill' }; };

  // A narration part can show several of your photos/videos in a row: one picture slot each
  const vsegs = [];
  for (const x of segs) {
    if (x.pics && x.pics.length) x.pics.forEach(p => vsegs.push({ t0: x.t0 + p.t, dur: p.dur, pic: p.pic }));
    else vsegs.push({ t0: x.t0, dur: x.dur, pic: x.pic });
  }
  const images = new Map(); // source id -> decoded photo
  const imageOf = async sid => {
    if (!images.has(sid)) images.set(sid, await createImageBitmap(srcs[sid].blob).catch(e => { problems.push(`Photo "${srcs[sid].name}" could not be read.`); return null; }));
    return images.get(sid);
  };

  let snapshot = null;
  const nFrames = Math.ceil(total * FPS);
  let si = -1, sg = null, rd = null, held = null;
  for (let k = 0; k < nFrames; k++) {
    if (cancelled) { enc.close(); return abort('Export cancelled'); }
    if (encErr) throw encErr;
    const t = k / FPS;
    let changed = false;
    while (si < vsegs.length - 1 && (si < 0 || t >= vsegs[si].t0 + vsegs[si].dur)) { si++; changed = true; }
    if (changed) {
      if (k > 0) { if (snapshot) snapshot.close(); snapshot = await createImageBitmap(canvas); }
      sg = vsegs[si];
      if (held) { held.close(); held = null; }
      rd = null;
      if (sg.pic && sg.pic.sid && !sg.pic.img) {
        try { rd = await reader(sg.pic.sid); if (!rd && srcs[sg.pic.sid].vErr) problems.push(srcs[sg.pic.sid].vErr); } catch (e) { problems.push(`Picture of "${srcs[sg.pic.sid].name}" at ${fmtTime(sg.t0)}: ${e.message}`); }
        if (rd) rd.last = -1; // start fresh at this segment
      }
      // close readers no later segment uses
      for (const [sid, r] of frames) if (!vsegs.slice(si).some(x => x.pic && x.pic.sid === sid)) { r.close(); frames.delete(sid); }
    }
    const into = t - sg.t0;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const fading = si > 0 && snapshot && into < FADE;
    if (fading) ctx.drawImage(snapshot, 0, 0, W, H);
    ctx.globalAlpha = fading ? Math.max(0.05, into / FADE) : 1;
    if (sg.pic && sg.pic.img) {
      const bmp = await imageOf(sg.pic.img);
      const p = Math.min(1, into / Math.max(0.1, sg.dur));
      if (bmp) CaseDraw.drawMedia(ctx, bmp, W, H, { mode: 'auto' }, sg.pic.kb ? 1.08 - 0.08 * p : 1 + 0.08 * p, false);
    } else if (rd) {
      let pic = null;
      try {
        if (sg.pic.freeze) {
          if (!held) { const f = await rd.frameAt(sg.pic.from); held = f ? await createImageBitmap(f) : null; }
          pic = held;
        } else pic = await rd.frameAt(sg.pic.until != null ? Math.min(sg.pic.from + into, sg.pic.until) : sg.pic.from + into);
      } catch (e) { problems.push(`Picture at ${fmtTime(t)}: ${e.message}`); rd = null; }
      if (pic) CaseDraw.drawMedia(ctx, pic, W, H, frameMode(rd.src), 1, true);
    } else if (sg.pic && sg.pic.card) {
      ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#e8e6e1';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.round(Math.min(W, H) * 0.05)}px Arial, Helvetica, sans-serif`;
      ctx.fillText(sg.pic.card, W / 2, H / 2 - Math.min(W, H) * 0.03);
      if (sg.pic.sub) { ctx.fillStyle = '#9a9890'; ctx.font = `400 ${Math.round(Math.min(W, H) * 0.028)}px Arial, Helvetica, sans-serif`; ctx.fillText(sg.pic.sub, W / 2, H / 2 + Math.min(W, H) * 0.04); }
    }
    ctx.globalAlpha = 1;
    if (layered) octx.drawImage(canvas, 0, 0);
    if (job.captions) CaseDraw.drawCaptions(octx, W, H, job.captions.cues, t, job.captions.style);
    if (job.watermark) CaseDraw.drawWatermark(octx, job.watermark.img, W, H, t, job.watermark);
    const frame = new VideoFrame(out, { timestamp: Math.round(k * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(frame, { keyFrame: k % (FPS * 2) === 0 });
    frame.close();
    while (enc.encodeQueueSize > 6) await sleep(2);
    if (k % 15 === 0) {
      const frac = 0.1 + 0.9 * k / nFrames;
      const el = (Date.now() - t0) / 1000;
      const left = k > FPS * 20 ? el / frac * (1 - frac) : null;
      post('progress', { frac, text: `Building ${fmtTime(t)} of ${fmtTime(total)}${left !== null ? ` · about ${fmtTime(left)} left` : ''}` });
    }
  }
  frames.forEach(r => r.close());
  images.forEach(b => b && b.close());
  if (held) held.close();
  if (snapshot) snapshot.close();
  post('progress', { frac: 1, text: 'Finishing the file…' });
  await enc.flush(); enc.close();
  muxer.finalize();
  let blob = null;
  if (writable) await writable.close(); else blob = new Blob([target.buffer], { type: 'video/mp4' });
  post('done', { blob, problems: [...new Set(problems)], seconds: Math.round((Date.now() - t0) / 1000), duration: total });
}
