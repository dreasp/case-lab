// Plays the timeline on a canvas (preview) and records it to a video file (export).
// Everything here runs in the browser, so the free server does no video work.

const FADE = 0.35;      // crossfade length in seconds
const LOOKAHEAD = 25;   // seconds of footage loaded ahead of the playhead

export class Renderer {
  constructor(canvas, { mediaUrl, onTime, onState }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mediaUrl = mediaUrl;          // async (shot) => url string or null
    this.onTime = onTime || (() => {});
    this.onState = onState || (() => {});
    this.cache = new Map();            // shot.id -> {status, el, url, bg}
    this.running = false;
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

  // ---------- media loading ----------
  async load(shot) {
    let item = this.cache.get(shot.id);
    if (item && item.choiceRef === shot.choice) return item.ready;
    if (item) this.release(shot.id);
    item = { status: 'loading', choiceRef: shot.choice };
    this.cache.set(shot.id, item);
    item.ready = (async () => {
      try {
        if (!shot.choice) { item.status = 'empty'; return item; }
        const url = await this.mediaUrl(shot);
        if (!url) throw new Error('no url');
        const r = await fetch(url);
        if (!r.ok) throw new Error('fetch ' + r.status);
        const blob = await r.blob();
        item.url = URL.createObjectURL(blob);
        if (shot.choice.type === 'video') {
          const v = document.createElement('video');
          v.muted = true; v.playsInline = true; v.preload = 'auto'; v.loop = true;
          v.src = item.url;
          await new Promise((res, rej) => {
            v.oncanplay = res; v.onerror = () => rej(new Error('video decode'));
            setTimeout(() => rej(new Error('video timeout')), 30000);
          });
          item.el = v;
        } else {
          const img = new Image();
          img.src = item.url;
          await img.decode();
          item.el = img;
          item.bg = this.blurredBackground(img);
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

  blurredBackground(img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const ratio = (w / h) / (16 / 9);
    if (ratio > 0.87 && ratio < 1.15) return null; // close enough to 16:9: just fill
    const c = document.createElement('canvas');
    c.width = 480; c.height = 270;
    const x = c.getContext('2d');
    x.filter = 'blur(18px) brightness(0.55)';
    drawCover(x, img, w, h, 480, 270, 1.15, 0, 0);
    return c;
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
    const el = it.el;
    if (el.tagName === 'VIDEO') {
      drawCover(x, el, el.videoWidth, el.videoHeight, W, H, 1, 0, 0);
    } else {
      const p = Math.min(1, Math.max(0, (t - shot.start) / Math.max(0.1, shot.end - shot.start)));
      const zoomIn = i % 2 === 0;
      const z = zoomIn ? 1 + 0.08 * p : 1.08 - 0.08 * p;
      const pan = (i % 3 - 1) * 0.02 * (p - 0.5);
      if (it.bg) {
        x.drawImage(it.bg, 0, 0, W, H);
        drawContain(x, el, el.naturalWidth, el.naturalHeight, W, H, z);
      } else {
        drawCover(x, el, el.naturalWidth, el.naturalHeight, W, H, z, pan, 0);
      }
    }
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
    const first = this.shotAt(from);
    const initial = this.shots.filter(s => s.end > from && s.start < from + 12);
    await Promise.all(initial.map(s => this.load(s)));
    if (this.token !== token) return;
    void first;

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
    let offset = from;           // timeline time when the clock started
    let clockStart = startAt;
    let stalled = false;
    let lastIdx = -1;

    const finished = new Promise(resolve => { this._resolveFinish = resolve; });
    const end = this.duration;

    const tick = async () => {
      if (this.token !== token) return;
      const t = stalled ? offset : offset + (this.actx.currentTime - clockStart);
      if (t >= end) { this._finish(); return; }
      const i = this.shotAt(Math.max(t, 0));
      const shot = this.shots[i];

      // Keep footage loaded ahead, free what is behind
      for (const s of this.shots) {
        if (s.end > t - 2 && s.start < t + LOOKAHEAD) this.load(s);
        else if (s.end < t - 3 && this.cache.has(s.id)) this.release(s.id);
      }

      const it = this.cache.get(shot.id);
      if (!it || it.status === 'loading') {
        // Footage not ready yet: pause everything (audio, recording) until it is
        if (!stalled) {
          stalled = true; offset = t;
          await this.actx.suspend();
          if (recorder && recorder.state === 'recording') recorder.pause();
          this.onState('buffering');
          await (it ? it.ready : this.load(shot));
          if (this.token !== token) return;
          await this.actx.resume();
          clockStart = this.actx.currentTime;
          if (recorder && recorder.state === 'paused') recorder.resume();
          stalled = false;
          this.onState(record ? 'recording' : 'playing');
        }
        requestAnimationFrame(tick);
        return;
      }

      if (i !== lastIdx) {
        // New shot: start its video from the beginning (skip the first half second)
        if (it.el && it.el.tagName === 'VIDEO') {
          const d = it.el.duration || 0;
          const into = Math.max(0, t - shot.start);
          it.el.currentTime = d > 3 ? Math.min(0.5 + into, Math.max(0, d - 1)) : into % Math.max(d, 0.1);
          it.el.play().catch(() => {});
        }
        const prev = this.shots[lastIdx];
        if (prev) {
          const pi = this.cache.get(prev.id);
          if (pi && pi.el && pi.el.tagName === 'VIDEO') setTimeout(() => pi.el.pause(), FADE * 1000 + 100);
        }
        lastIdx = i;
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
    this._cancelled = !!this.recorder;
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
      it.el.currentTime = Math.min(0.5, (it.el.duration || 1) / 2);
      await new Promise(r => { it.el.onseeked = r; setTimeout(r, 1500); });
    }
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawShot(i, t, 1);
    this.onTime(t, i);
  }
}

function drawCover(x, el, w, h, W, H, zoom = 1, panX = 0, panY = 0) {
  if (!w || !h) return;
  const s = Math.max(W / w, H / h) * zoom;
  const dw = w * s, dh = h * s;
  x.drawImage(el, (W - dw) / 2 + panX * W, (H - dh) / 2 + panY * H, dw, dh);
}

function drawContain(x, el, w, h, W, H, zoom = 1) {
  if (!w || !h) return;
  const s = Math.min(W / w, H / h) * zoom;
  const dw = w * s, dh = h * s;
  x.drawImage(el, (W - dw) / 2, (H - dh) / 2, dw, dh);
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
