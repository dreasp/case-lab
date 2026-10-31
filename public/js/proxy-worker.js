// Makes small "analysis copies" of a video in the background, in one pass:
//  - picture: 1 frame per second, 480 px wide, no sound (about 50 MB per hour), for Gemini
//  - sound: the original audio copied as is (no quality loss), for the AssemblyAI transcript
// Reads the original in pieces, so huge files are fine. The original never leaves your computer.

/* global MP4Box, DataStream, Mp4Muxer */
importScripts('/vendor/mp4box.js', '/vendor/mp4-muxer.js');

let cancelled = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

self.onmessage = async e => {
  if (e.data.type === 'cancel') { cancelled = true; return; }
  if (e.data.type !== 'start') return;
  try {
    const out = await makeProxy(e.data.file, e.data.maxW || 480, e.data.fps || 1);
    self.postMessage({ type: 'done', ...out });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

const even = n => Math.max(2, Math.round(n / 2) * 2);

async function makeProxy(file, maxW, fps) {
  const size = file.size;
  const CH = 8 * 1024 * 1024;
  const mp4 = MP4Box.createFile();
  let info = null, parseErr = null;
  mp4.onReady = i => { info = i; };
  mp4.onError = e => { parseErr = e; };
  const feed = async p => {
    const ab = await file.slice(p, p + CH).arrayBuffer();
    ab.fileStart = p;
    const next = mp4.appendBuffer(ab);
    return (typeof next === 'number' && next > p) ? next : p + ab.byteLength;
  };

  // 1) Find the video's index (it can be at the start or the end of the file)
  let pos = 0;
  while (!info && pos < size && !parseErr) pos = await feed(pos);
  if (!info) throw new Error('This file could not be read. MP4 and MOV videos are supported; convert other formats to MP4 first.');
  const tr = info.videoTracks[0];
  if (!tr) throw new Error('There is no video in this file.');
  const duration = (tr.duration / tr.timescale) || (info.duration / info.timescale) || 0;
  const trak = mp4.getTrackById(tr.id);
  let description;
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const st = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(st);
      description = new Uint8Array(st.buffer, 8);
      break;
    }
  }
  const config = { codec: tr.codec, codedWidth: tr.video.width, codedHeight: tr.video.height, description };
  const ok = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!ok.supported) throw new Error(`This browser can't read this video's format (${tr.codec}). Convert it to a standard H.264 MP4 first.`);

  // Videos with frequent keyframes: only keyframes need decoding (much faster)
  const stss = trak.mdia.minf.stbl.stss;
  const keyCount = stss ? stss.sample_numbers.length : tr.nb_samples;
  const keyOnly = duration / Math.max(1, keyCount) <= 2.5;

  const w = tr.video.width, h = tr.video.height;
  const sc = Math.min(1, maxW / w);
  const W = even(w * sc), H = even(h * sc);

  // 2) Encoder for the small copy
  const options = [
    { codec: 'avc1.42001f', muxer: 'avc' },
    { codec: 'avc1.4d001f', muxer: 'avc' },
    { codec: 'vp09.00.10.08', muxer: 'vp9' },
  ];
  let enc = null;
  for (const o of options) {
    const cfg = { codec: o.codec, width: W, height: H, bitrate: 350_000, framerate: fps };
    if (o.muxer === 'avc') cfg.avc = { format: 'avc' };
    if ((await VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }))).supported) { enc = { ...o, cfg }; break; }
  }
  if (!enc) throw new Error('This browser cannot encode video. Please use an up-to-date Chrome.');
  const target = new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer({ target, video: { codec: enc.muxer, width: W, height: H }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  let err = null;
  const encoder = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { err = e; } });
  encoder.configure(enc.cfg);

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  const step = 1e6 / fps;
  let nextWanted = 0, frames = 0, thumbSent = false, lastTs = -1;

  const decoder = new VideoDecoder({
    output: f => {
      const ts = f.timestamp;
      if (ts + 2000 >= nextWanted && ts > lastTs) {
        ctx.drawImage(f, 0, 0, W, H);
        const vf = new VideoFrame(canvas, { timestamp: ts });
        encoder.encode(vf, { keyFrame: frames % 10 === 0 });
        vf.close();
        frames++;
        lastTs = ts;
        nextWanted = ts + step;
        if (!thumbSent && ts >= Math.min(2e6, duration * 1e6 * 0.1)) {
          thumbSent = true;
          canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }).then(b => self.postMessage({ type: 'thumb', blob: b })).catch(() => {});
        }
      }
      f.close();
    },
    error: e => { err = e; },
  });
  decoder.configure(config);

  // Sound copy: AAC audio is copied as is into its own small file
  const atr = info.audioTracks[0];
  let amux = null, atarget = null, ameta = null, audioNote = atr ? null : 'This video has no sound.';
  if (atr && /^mp4a/.test(atr.codec)) {
    try {
      const entry = mp4.getTrackById(atr.id).mdia.minf.stbl.stsd.entries[0];
      const dsi = entry.esds && entry.esds.esd && entry.esds.esd.descs[0] && entry.esds.esd.descs[0].descs[0];
      ameta = { decoderConfig: { codec: atr.codec, numberOfChannels: atr.audio.channel_count, sampleRate: atr.audio.sample_rate, description: dsi ? new Uint8Array(dsi.data) : undefined } };
      atarget = new Mp4Muxer.ArrayBufferTarget();
      amux = new Mp4Muxer.Muxer({ target: atarget, audio: { codec: 'aac', numberOfChannels: atr.audio.channel_count, sampleRate: atr.audio.sample_rate }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
    } catch (e) { amux = null; audioNote = 'The sound could not be copied: ' + e.message; }
  } else if (atr) {
    audioNote = `The sound is in a format (${atr.codec}) that can't be copied for the transcript. Convert the video to a standard MP4 to get a transcript.`;
  }
  let firstAudio = true;

  // 3) Go through the file once, decoding what's needed
  let lastNum = -1, lastAudioNum = -1;
  mp4.onSamples = (id, user, samples) => {
    if (atr && id === atr.id) {
      for (const s of samples) {
        if (s.number <= lastAudioNum) continue;
        lastAudioNum = s.number;
        if (!amux) continue;
        amux.addAudioChunkRaw(s.data, 'key', Math.round(s.cts * 1e6 / s.timescale), Math.round(s.duration * 1e6 / s.timescale), firstAudio ? ameta : undefined);
        firstAudio = false;
      }
      mp4.releaseUsedSamples(id, samples[samples.length - 1].number + 1);
      return;
    }
    for (const s of samples) {
      if (s.number <= lastNum) continue; // the library can send a sample twice
      lastNum = s.number;
      if (keyOnly && !s.is_sync) continue;
      decoder.decode(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round(s.cts * 1e6 / s.timescale),
        duration: Math.round(s.duration * 1e6 / s.timescale),
        data: s.data,
      }));
    }
    mp4.releaseUsedSamples(id, samples[samples.length - 1].number + 1);
  };
  mp4.setExtractionOptions(tr.id, null, { nbSamples: 200 });
  if (atr) mp4.setExtractionOptions(atr.id, null, { nbSamples: 500 });
  mp4.start();
  pos = mp4.seek(0, true).offset;
  let lastReport = 0;
  while (pos < size) {
    if (cancelled) throw new Error('Cancelled');
    if (err) throw err;
    pos = await feed(pos);
    while (decoder.decodeQueueSize > 40 || encoder.encodeQueueSize > 8) await sleep(4);
    if (Date.now() - lastReport > 500) {
      lastReport = Date.now();
      self.postMessage({ type: 'progress', frac: Math.min(0.99, pos / size) });
    }
  }
  mp4.flush();
  await decoder.flush();
  await encoder.flush();
  if (err) throw err;
  decoder.close(); encoder.close();
  muxer.finalize();
  if (!frames) throw new Error('No pictures could be read from this video.');
  if (!thumbSent) {
    const b = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    self.postMessage({ type: 'thumb', blob: b });
  }
  let audio = null;
  if (amux && !firstAudio) {
    amux.finalize();
    audio = new Blob([atarget.buffer], { type: 'audio/mp4' });
  } else if (amux && !audioNote) audioNote = 'No sound could be read from this video.';
  return {
    blob: new Blob([target.buffer], { type: 'video/mp4' }),
    audio,
    info: { duration, width: w, height: h, codec: tr.codec, frames, keyOnly, audioNote },
  };
}
