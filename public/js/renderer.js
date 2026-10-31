// Plays the timeline on a canvas (preview) and records it to a video file (export).
// Everything here runs in the browser, so the free server does no video work.

const FADE = 0.35;      // crossfade length in seconds
const LOOKAHEAD = 12;   // seconds of footage prepared ahead of the playhead (browsers can only decode a few videos at once)

export const SIZES = { '16:9': [1920, 1080], '9:16': [1080, 1920] };

// ---------- drawing helpers (also used by the shot editor) ----------
const blurCanvas = document.createElement('canvas');

// How a picture is placed. frame = { x, y, zoom, mode } where x/y (0..1) pick which part stays
// visible when cropping, zoom >= 1, and mode is 'fill' (crop to fill), 'fit' (whole picture,
// blurred sides) or 'auto'.
export function mediaLayout(el, W, H, frame = {}, extraZoom = 1) {
  const w = el.videoWidth || el.naturalWidth || el.width;
  const h = el.videoHeight || el.naturalHeight || el.height;
  let mode = frame.mode || 'auto';
  if (mode === 'auto') {
    // Photos with a very different shape are shown whole; videos fill the frame
    const ratio = (w / h) / (W / H);
    mode = el.tagName !== 'VIDEO' && (ratio < 0.8 || ratio > 1.25) ? 'fit' : 'fill';
  }
  const zoom = (frame.zoom || 1) * extraZoom;
  const s = (mode === 'fit' ? Math.min(W / w, H / h) : Math.max(W / w, H / h)) * zoom;
  return { w, h, mode, dw: w * s, dh: h * s };
}

export function drawMedia(x, el, W, H, frame = {}, extraZoom = 1) {
  const { w, h, mode } = mediaLayout(el, W, H, frame, extraZoom);
  if (!w || !h) return;
  const fx = frame.x ?? 0.5, fy = frame.y ?? 0.5;
  const zoom = (frame.zoom || 1) * extraZoom;
  if (mode === 'fit') {
    // Soft blurred copy behind, whole picture on top
    const bw = W >= H ? 192 : 108, bh = W >= H ? 108 : 192;
    blurCanvas.width = bw; blurCanvas.height = bh;
    const b = blurCanvas.getContext('2d');
    b.filter = 'blur(6px) brightness(0.5)';
    const sb = Math.max(bw / w, bh / h) * 1.2;
    b.drawImage(el, (bw - w * sb) / 2, (bh - h * sb) / 2, w * sb, h * sb);
    x.imageSmoothingEnabled = true;
    x.drawImage(blurCanvas, 0, 0, W, H);
    const s = Math.min(W / w, H / h) * zoom;
    const dw = w * s, dh = h * s;
    x.drawImage(el, (W - dw) * fx, (H - dh) * fy, dw, dh);
  } else {
    const s = Math.max(W / w, H / h) * zoom;
    const dw = w * s, dh = h * s;
    x.drawImage(el, (W - dw) * fx, (H - dh) * fy, dw, dh);
  }
}

export function frameFor(shot, aspect) {
  return (shot.edit && shot.edit.frames && shot.edit.frames[aspect]) || {};
}

// Try each address in turn (direct from the stock site first, then through our server),
// so one refused request doesn't leave a shot empty.
export async function loadVideo(sources, timeoutMs = 45000) {
  let lastErr = null;
  for (const src of sources) {
    if (src.delay) await new Promise(r => setTimeout(r, src.delay));
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    try {
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout')), timeoutMs);
        v.addEventListener('loadeddata', () => { clearTimeout(t); res(); }, { once: true });
        v.addEventListener('error', () => { clearTimeout(t); rej(new Error('error ' + (v.error && v.error.code))); }, { once: true });
        v.src = src.url;
      });
      return v;
    } catch (e) {
      lastErr = e;
      v.removeAttribute('src'); v.load();
    }
  }
  throw lastErr || new Error('no source');
}

export async function loadImage(sources) {
  let lastErr = null;
  for (const src of sources) {
    if (src.delay) await new Promise(r => setTimeout(r, src.delay));
    try {
      const r = await fetch(src.url, { mode: 'cors' });
      if (!r.ok) throw new Error('status ' + r.status);
      const url = URL.createObjectURL(await r.blob());
      const img = new Image();
      img.src = url;
      try { await img.decode(); } catch (e) { URL.revokeObjectURL(url); throw e; }
      return { img, url };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no source');
}

const waitFor = (el, evt, ms) => new Promise(res => {
  const t = setTimeout(res, ms);
  el.addEventListener(evt, () => { clearTimeout(t); res(); }, { once: true });
});

export class Renderer {
  constructor(canvas, { mediaUrl, onTime, onState }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mediaUrl = mediaUrl;          // async (shot) => list of { url, delay } to try, or null
    this.onTime = onTime || (() => {});
    this.onState = onState || (() => {});
    this.cache = new Map();            // shot.id -> {status, el, url}
    this.running = false;
    this.aspect = '16:9';
  }

  setAspect(aspect) {
    this.aspect = SIZES[aspect] ? aspect : '16:9';
    const [w, h] = SIZES[this.aspect];
    this.canvas.width = w; this.canvas.height = h;
  }

  setProject(shots, audioBlob) {
    this.stop();
    this.shots = shots;
    if (audioBlob !== this.audioBlob) { this.audioBlob = audioBlob; this.audioBuffer = null; }
    this.releaseAll();
  }

  async ensureAudio() {
    if (!this.actx) this.actx = new AudioContext();
    if (!this.audioBuffer) this.audioBuffer = await this.actx.decodeAudioData(await this.audioBlob.arrayBuffer());
    return this.audioBuffer;
  }

  get duration() { return this.audioBuffer ? this.audioBuffer.duration : (this.shots.at(-1)?.end || 0); }

  startPoint(shot) { return (shot.edit && shot.edit.start) || 0; }

  // ---------- media loading ----------
  // Videos are streamed (only the part that's used is downloaded); photos are loaded whole.
  async load(shot) {
    let item = this.cache.get(shot.id);
    const sig = JSON.stringify([shot.choice && shot.choice.key, this.startPoint(shot)]);
    if (item && item.choiceRef === shot.choice && item.sig === sig) return item.ready;
    if (item) this.release(shot.id);
    item = { status: 'loading', choiceRef: shot.choice, sig };
    this.cache.set(shot.id, item);
    item.ready = (async () => {
      try {
        if (!shot.choice) { item.status = 'empty'; return item; }
        const sources = await this.mediaUrl(shot);
        if (!sources || !sources.length) throw new Error('no url');
        if (shot.choice.type === 'video') {
          const v = await loadVideo(sources);
          v.loop = true;
          // Jump to the chosen start point now, so the shot starts instantly later
          const target = this.clipTime(shot, v, 0);
          if (Math.abs(v.currentTime - target) > 0.05) { v.currentTime = target; await waitFor(v, 'seeked', 15000); }
          item.el = v;
          item.url = null;
        } else {
          const { img, url } = await loadImage(sources);
          item.url = url;
          item.el = img;
        }
        item.status = 'ready';
      } catch (e) {
        console.warn('Could not load footage for', shot.id, e);
        item.status = 'error';
      }
      return item;
    })();
    return item.ready;
  }

  // Where in the clip we should be, `into` seconds after the shot starts
  clipTime(shot, v, into) {
    const d = v.duration || 0;
    const start = this.startPoint(shot) || (d > 3 ? 0.5 : 0);
    if (!d) return start;
    const t = start + into;
    return t < d - 0.05 ? t : start + ((t - start) % Math.max(0.1, d - start));
  }

  release(id) {
    const it = this.cache.get(id);
    if (!it) return;
    if (it.el && it.el.tagName === 'VIDEO') { it.el.pause(); it.el.removeAttribute('src'); it.el.load(); }
    if (it.url) URL.revokeObjectURL(it.url);
    this.cache.delete(id);
  }
  releaseAll() { for (const id of [...this.cache.keys()]) this.release(id); }
  invalidate(shotId) { this.release(shotId); }

  // ---------- drawing ----------
  shotAt(t) {
    const s = this.shots;
    let lo = 0, hi = s.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (t < s[m].start) hi = m - 1; else if (t >= s[m].end) lo = m + 1; else return m;
    }
    return Math.min(Math.max(lo, 0), s.length - 1);
  }

  drawShot(i, t, alpha) {
    const shot = this.shots[i];
    const it = this.cache.get(shot.id);
    const W = this.canvas.width, H = this.canvas.height, x = this.ctx;
    x.globalAlpha = alpha;
    if (!it || it.status !== 'ready') {
      if (it && it.status === 'empty' && alpha >= 1) { x.fillStyle = '#000'; x.fillRect(0, 0, W, H); }
      x.globalAlpha = 1;
      return;
    }
    let kb = 1;
    if (it.el.tagName !== 'VIDEO') {
      // Slow zoom on photos
      const p = Math.min(1, Math.max(0, (t - shot.start) / Math.max(0.1, shot.end - shot.start)));
      kb = i % 2 === 0 ? 1 + 0.08 * p : 1.08 - 0.08 * p;
    }
    drawMedia(x, it.el, W, H, frameFor(shot, this.aspect), kb);
    x.globalAlpha = 1;
  }

  // ---------- playback ----------
  async play(from = 0, { record = false, muteSpeakers = false, onProgress } = {}) {
    this.stop();
    await this.ensureAudio();
    if (this.actx.state === 'suspended') await this.actx.resume();
    const token = {};
    this.token = token;
    this.running = true;
    this.onState('loading');

    // Load the first stretch of footage before starting
    const initial = this.shots.filter(s => s.end > from && s.start < from + 10);
    await Promise.all(initial.map(s => this.load(s)));
    if (this.token !== token) return null;

    const src = this.actx.createBufferSource();
    src.buffer = this.audioBuffer;
    const speaker = this.actx.createGain();
    speaker.gain.value = muteSpeakers ? 0 : 1;
    src.connect(speaker).connect(this.actx.destination);

    let recorder = null, chunks = [], mime = '';
    if (record) {
      const dest = this.actx.createMediaStreamDestination();
      src.connect(dest);
      const stream = new MediaStream([
        ...this.canvas.captureStream(30).getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]);
      mime = pickMime();
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.start(1000);
    }
    this.recorder = recorder;
    this.src = src;

    const startAt = this.actx.currentTime + 0.05;
    src.start(startAt, from);
    let offset = from;
    let clockStart = startAt;
    let stalled = false;
    let lastIdx = -1;

    const finished = new Promise(resolve => { this._resolveFinish = resolve; });
    const end = this.duration;

    // Pause audio + recording while footage catches up, then carry on
    const stall = async (t, waitFn) => {
      stalled = true; offset = t;
      await this.actx.suspend();
      if (recorder && recorder.state === 'recording') recorder.pause();
      for (const it of this.cache.values()) if (it.el && it.el.tagName === 'VIDEO') it.el.pause();
      this.onState('buffering');
      await waitFn();
      if (this.token !== token) return;
      const cur = this.cache.get(this.shots[this.shotAt(t)].id);
      if (cur && cur.el && cur.el.tagName === 'VIDEO') await cur.el.play().catch(() => {});
      await this.actx.resume();
      clockStart = this.actx.currentTime;
      if (recorder && recorder.state === 'paused') recorder.resume();
      stalled = false;
      this.onState(record ? 'recording' : 'playing');
    };

    const tick = async () => {
      if (this.token !== token) return;
      const t = stalled ? offset : offset + (this.actx.currentTime - clockStart);
      if (t >= end) { this._finish(); return; }
      const i = this.shotAt(Math.max(t, 0));
      const shot = this.shots[i];

      // Keep footage prepared ahead, free what is behind
      for (const s of this.shots) {
        if (s.end > t - 2 && s.start < t + LOOKAHEAD) this.load(s);
        else if (s.end < t - 3 && this.cache.has(s.id)) this.release(s.id);
      }

      const it = this.cache.get(shot.id);
      if (!it || it.status === 'loading') {
        if (!stalled) await stall(t, () => (it ? it.ready : this.load(shot)));
        requestAnimationFrame(tick);
        return;
      }

      if (i !== lastIdx) {
        if (it.el && it.el.tagName === 'VIDEO') {
          const target = this.clipTime(shot, it.el, Math.max(0, t - shot.start));
          if (Math.abs(it.el.currentTime - target) > 0.3) it.el.currentTime = target;
          it.el.play().catch(() => {});
        }
        const prev = this.shots[lastIdx];
        if (prev) {
          const pi = this.cache.get(prev.id);
          if (pi && pi.el && pi.el.tagName === 'VIDEO') setTimeout(() => pi.el.pause(), FADE * 1000 + 100);
        }
        lastIdx = i;
      } else if (it.el && it.el.tagName === 'VIDEO' && it.el.readyState < 3 && !it.el.ended) {
        // The streamed video is still downloading: wait for it instead of freezing on screen
        if (!stalled) await stall(t, () => waitFor(it.el, 'canplay', 20000));
        requestAnimationFrame(tick);
        return;
      }

      const since = t - shot.start;
      const alpha = i > 0 && since < FADE ? Math.max(0.08, since / FADE) : 1;
      // If a clip failed to load, the previous picture simply stays on screen
      if (alpha >= 1 && it.status === 'ready') { this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); }
      this.drawShot(i, t, alpha);
      this.onTime(t, i);
      if (onProgress) onProgress(t / end);
      requestAnimationFrame(tick);
    };

    this.onState(record ? 'recording' : 'playing');
    requestAnimationFrame(tick);
    await finished;

    if (recorder) {
      const done = new Promise(r => { recorder.onstop = r; });
      if (recorder.state !== 'inactive') recorder.stop();
      await done;
      return new Blob(chunks, { type: mime.split(';')[0] });
    }
    return null;
  }

  _finish() {
    this.running = false;
    this.token = null;
    try { this.src && this.src.stop(); } catch (e) { /* already stopped */ }
    for (const it of this.cache.values()) if (it.el && it.el.tagName === 'VIDEO') it.el.pause();
    this.onState('stopped');
    if (this._resolveFinish) { const r = this._resolveFinish; this._resolveFinish = null; r(); }
  }

  stop() {
    if (!this.running) return;
    this._finish();
  }

  // Draw a single still frame at time t (used when clicking a shot)
  async showFrame(t) {
    if (!this.shots || !this.shots.length) return;
    const i = this.shotAt(t);
    const shot = this.shots[i];
    await this.load(shot);
    const it = this.cache.get(shot.id);
    if (it && it.el && it.el.tagName === 'VIDEO') {
      const target = this.clipTime(shot, it.el, Math.max(0, t - shot.start));
      if (Math.abs(it.el.currentTime - target) > 0.05) { it.el.currentTime = target; await waitFor(it.el, 'seeked', 5000); }
    }
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawShot(i, t, 1);
    this.onTime(t, i);
  }
}

export function pickMime() {
  const options = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.4D401F,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return options.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || 'video/webm';
}
