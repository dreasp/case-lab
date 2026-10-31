// Export engine. Runs in a background worker and builds the video frame by frame:
// every clip is decoded at full resolution, each frame is drawn exactly like the preview,
// then encoded at high quality and written straight to a file. It doesn't depend on the
// screen, so the tab can be in the background, and it's usually faster than real time.

/* global MP4Box, DataStream, Mp4Muxer, CaseDraw */
importScripts('/vendor/mp4box.js', '/vendor/mp4-muxer.js', '/js/draw.js');

const FPS = 30;
const FADE = 0.35;
const SR = 48000;
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

// ---------- loading sources ----------
async function fetchBuffer(shot) {
  if (shot.blob) return shot.blob.arrayBuffer();
  let lastErr = null;
  for (const src of shot.sources || []) {
    if (src.delay) await sleep(src.delay);
    try {
      const r = await fetch(src.url, { mode: 'cors', credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      return await r.arrayBuffer();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no source');
}

function demux(buf) {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    const samples = [];
    let track = null;
    file.onError = e => reject(new Error('Could not read video file: ' + e));
    file.onReady = info => {
      track = info.videoTracks[0];
      if (!track) return reject(new Error('No video track in this file'));
      file.setExtractionOptions(track.id, null, { nbSamples: 100000 });
      file.start();
    };
    file.onSamples = (id, user, list) => { for (const s of list) samples.push(s); };
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();
    if (!track) return reject(new Error('This video format is not supported (MP4 or MOV needed)'));
    const trak = file.getTrackById(track.id);
    let description;
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        description = new Uint8Array(stream.buffer, 8);
        break;
      }
    }
    samples.sort((a, b) => a.dts - b.dts);
    const last = samples[samples.length - 1];
    const duration = last ? (last.cts + last.duration) / last.timescale : track.duration / track.timescale;
    resolve({
      config: { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description },
      samples,
      duration,
    });
  });
}

// Gives the right decoded frame for any time in the clip, decoding only what's needed
class VideoSource {
  constructor(d) {
    this.d = d;
    this.queue = [];
    this.cur = null;
    this.waiters = [];
    this.lastWanted = -1;
  }

  async init() {
    const support = await VideoDecoder.isConfigSupported(this.d.config);
    if (!support.supported) throw new Error(`This browser can't decode ${this.d.config.codec}`);
    this.width = this.d.config.codedWidth; this.height = this.d.config.codedHeight;
    this.restart(0);
  }

  restart(us) {
    if (this.decoder) try { this.decoder.close(); } catch (e) { /* closed */ }
    for (const f of this.queue) f.close();
    this.queue = [];
    if (this.cur) { this.cur.close(); this.cur = null; }
    this.flushed = false;
    this.decoder = new VideoDecoder({
      output: f => { this.queue.push(f); this.wake(); },
      error: e => { this.err = e; this.wake(); },
    });
    this.decoder.configure(this.d.config);
    // Start from the last keyframe at or before the wanted time
    const s = this.d.samples;
    let k = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i].is_sync && s[i].cts * 1e6 / s[i].timescale <= us) k = i;
      if (s[i].dts * 1e6 / s[i].timescale > us) break;
    }
    this.next = k;
  }

  wake() { const w = this.waiters; this.waiters = []; w.forEach(r => r()); }
  waitOutput() { return new Promise(r => { this.waiters.push(r); setTimeout(r, 200); }); }

  feed() {
    const s = this.d.samples;
    while (this.next < s.length && this.decoder.decodeQueueSize < 8 && this.queue.length < 12) {
      const smp = s[this.next++];
      this.decoder.decode(new EncodedVideoChunk({
        type: smp.is_sync ? 'key' : 'delta',
        timestamp: Math.round(smp.cts * 1e6 / smp.timescale),
        duration: Math.round(smp.duration * 1e6 / smp.timescale),
        data: smp.data,
      }));
    }
  }

  async frameAt(sec) {
    const us = sec * 1e6;
    if (us + 1 < this.lastWanted) this.restart(us); // jumped back (loop): start over
    this.lastWanted = us;
    for (let guard = 0; guard < 5000; guard++) {
      if (this.err) throw this.err;
      // Move forward through decoded frames up to the wanted time
      while (this.queue.length && this.queue[0].timestamp <= us + 1000) {
        if (this.cur) this.cur.close();
        this.cur = this.queue.shift();
      }
      if (this.queue.length || this.flushed) break;
      if (this.next < this.d.samples.length) {
        this.feed();
        await this.waitOutput();
      } else {
        await this.decoder.flush();
        this.flushed = true;
      }
    }
    if (!this.cur && this.queue.length) { this.cur = this.queue.shift(); }
    return this.cur;
  }

  close() {
    try { this.decoder.close(); } catch (e) { /* closed */ }
    for (const f of this.queue) f.close();
    if (this.cur) this.cur.close();
    this.queue = []; this.cur = null;
  }
}

async function openShot(shot) {
  if (!shot.type) return { kind: 'empty' };
  const buf = await fetchBuffer(shot);
  if (shot.type === 'video') {
    const d = await demux(buf);
    const src = new VideoSource(d);
    await src.init();
    return { kind: 'video', src, duration: d.duration };
  }
  const bmp = await createImageBitmap(new Blob([buf]));
  return { kind: 'photo', bmp };
}

function closeShot(m) {
  if (!m) return;
  if (m.src) m.src.close();
  if (m.bmp) m.bmp.close();
}

// Which moment of the clip to show, `into` seconds after the shot starts
function clipTime(shot, m, into) {
  const d = m.duration || 0;
  const start = (shot.edit && shot.edit.start) || (d > 3 ? 0.5 : 0);
  const t = start + into;
  if (!d || t < d - 0.05) return t;
  const span = Math.max(0.1, d - start - 0.05);
  return start + ((t - start) % span);
}

// ---------- audio ----------
async function encodeAudio(job, muxer, aac) {
  const enc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: e => { throw e; },
  });
  enc.configure({ codec: aac ? 'mp4a.40.2' : 'opus', sampleRate: SR, numberOfChannels: 2, bitrate: 192000 });
  const mono = job.audio;
  const step = 4800;
  for (let i = 0; i < mono.length; i += step) {
    const len = Math.min(step, mono.length - i);
    const data = new Float32Array(len * 2);
    data.set(mono.subarray(i, i + len), 0);
    data.set(mono.subarray(i, i + len), len);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round(i * 1e6 / SR), data });
    enc.encode(ad);
    ad.close();
    if (enc.encodeQueueSize > 30) await sleep(1);
  }
  await enc.flush();
  enc.close();
}

// ---------- main ----------
async function pickVideoCodec(W, H, bitrate) {
  const options = [
    { codec: 'avc1.640028', muxer: 'avc' },
    { codec: 'avc1.4d0028', muxer: 'avc' },
    { codec: 'vp09.00.40.08', muxer: 'vp9' },
  ];
  for (const o of options) {
    const cfg = { codec: o.codec, width: W, height: H, bitrate, framerate: FPS, latencyMode: 'quality' };
    if (o.muxer === 'avc') cfg.avc = { format: 'avc' };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { ...o, cfg }; } catch (e) { /* next */ }
  }
  throw new Error('This browser cannot encode video. Please use an up-to-date Chrome.');
}

async function run(job) {
  const [W, H] = job.aspect === '9:16' ? [1080, 1920] : [1920, 1080];
  const v = await pickVideoCodec(W, H, job.bitrate);
  let aac = false;
  try { aac = (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, bitrate: 192000 })).supported; } catch (e) { aac = false; }

  let writable = null;
  let target;
  if (job.fileHandle) {
    writable = await job.fileHandle.createWritable();
    target = new Mp4Muxer.FileSystemWritableFileStreamTarget(writable);
  } else {
    target = new Mp4Muxer.ArrayBufferTarget();
  }
  const muxer = new Mp4Muxer.Muxer({
    target,
    video: { codec: v.muxer, width: W, height: H, frameRate: FPS },
    audio: { codec: aac ? 'aac' : 'opus', numberOfChannels: 2, sampleRate: SR },
    fastStart: writable ? false : 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  const abort = async msg => {
    if (writable) { try { await writable.abort(); } catch (e) { /* ignore */ } }
    post('cancelled', { message: msg });
  };

  post('progress', { frac: 0, text: 'Encoding narration…' });
  await encodeAudio(job, muxer, aac);

  let encErr = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { encErr = e; },
  });
  encoder.configure(v.cfg);

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const shots = job.shots;
  const total = Math.ceil(job.duration * FPS);
  const loading = new Map();      // shot index -> promise of media
  const load = i => {
    if (i < 0 || i >= shots.length) return null;
    if (!loading.has(i)) loading.set(i, openShot(shots[i]).catch(e => ({ kind: 'error', error: e.message })));
    return loading.get(i);
  };

  let si = 0;
  let media = null;
  let snapshot = null;            // last picture of the previous shot, for the crossfade
  const problems = [];
  const t0 = Date.now();

  for (let k = 0; k < total; k++) {
    if (cancelled) { encoder.close(); closeShot(media); return abort('Export cancelled'); }
    if (encErr) throw encErr;
    const t = k / FPS;

    // Move to the shot that covers this moment
    let changed = k === 0;
    while (si < shots.length - 1 && t >= shots[si].end) { si++; changed = true; }
    if (changed) {
      if (k > 0) { if (snapshot) snapshot.close(); snapshot = await createImageBitmap(canvas); }
      if (media) closeShot(media);
      loading.forEach((p, idx) => { if (idx < si) loading.delete(idx); });
      media = await load(si);
      load(si + 1); // start downloading the next clip while this one is encoded
      if (media.kind === 'error') problems.push(`${fmtTime(shots[si].start)}: ${media.error}`);
    }

    const shot = shots[si];
    let pic = null, isVid = false, kb = 1;
    if (media.kind === 'video') {
      pic = await media.src.frameAt(clipTime(shot, media, Math.max(0, t - shot.start)));
      isVid = true;
    } else if (media.kind === 'photo') {
      pic = media.bmp;
      const p = Math.min(1, Math.max(0, (t - shot.start) / Math.max(0.1, shot.end - shot.start)));
      kb = si % 2 === 0 ? 1 + 0.08 * p : 1.08 - 0.08 * p;
    }

    if (media.kind === 'empty') {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    } else if (pic) {
      const since = t - shot.start;
      const fading = si > 0 && snapshot && since < FADE;
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      if (fading) ctx.drawImage(snapshot, 0, 0, W, H);
      ctx.globalAlpha = fading ? Math.max(0.05, since / FADE) : 1;
      CaseDraw.drawMedia(ctx, pic, W, H, shot.frame || {}, kb, isVid);
      ctx.globalAlpha = 1;
    } // a clip that failed to load keeps the previous picture on screen

    const frame = new VideoFrame(canvas, { timestamp: Math.round(k * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    encoder.encode(frame, { keyFrame: k % (FPS * 2) === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 6) await sleep(2);

    if (k % 15 === 0) {
      const frac = k / total;
      const elapsed = (Date.now() - t0) / 1000;
      const left = frac > 0.02 ? elapsed / frac * (1 - frac) : null;
      post('progress', { frac, text: `Building ${fmtTime(t)} of ${fmtTime(job.duration)}${left !== null ? ` · about ${fmtTime(left)} left` : ''}` });
    }
  }

  closeShot(media);
  if (snapshot) snapshot.close();
  post('progress', { frac: 1, text: 'Finishing the file…' });
  await encoder.flush();
  encoder.close();
  muxer.finalize();
  let blob = null;
  if (writable) await writable.close();
  else blob = new Blob([target.buffer], { type: 'video/mp4' });
  post('done', { blob, problems, codec: v.muxer, audio: aac ? 'aac' : 'opus', seconds: Math.round((Date.now() - t0) / 1000) });
}

function fmtTime(t) {
  t = Math.max(0, Math.round(t || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
