// Converter for formats Chrome can't play by itself (WMV, AVI, MPG, MKV, WMA...).
// Runs ffmpeg inside the browser (downloaded once, then cached). It reads the original
// straight from your folder and only writes the small analysis copies.

import { FFmpeg } from '/vendor/ffmpeg/index.js';

let ff = null;
let loading = null;

async function engine() {
  if (ff) return ff;
  if (!loading) {
    loading = (async () => {
      const f = new FFmpeg();
      await f.load({ coreURL: '/vendor/ffmpeg-core/ffmpeg-core.js', wasmURL: '/vendor/ffmpeg-core/ffmpeg-core.wasm' });
      ff = f;
      return f;
    })().catch(e => { loading = null; throw e; });
  }
  return loading;
}

export function stopConverter() {
  if (ff) { try { ff.terminate(); } catch (e) { /* already stopped */ } }
  ff = null; loading = null;
}

function parseInfo(log) {
  const d = log.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const duration = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0;
  const vline = (log.match(/Stream #[^\n]*Video:[^\n]*/) || [''])[0];
  const size = vline.match(/,\s*(\d{2,5})x(\d{2,5})/);
  return {
    duration,
    hasVideo: !!vline,
    hasAudio: /Stream #[^\n]*Audio:/.test(log),
    width: size ? +size[1] : 0,
    height: size ? +size[2] : 0,
  };
}

async function readOut(f, name, type) {
  try {
    const data = await f.readFile(name);
    await f.deleteFile(name).catch(() => {});
    return data && data.length ? new Blob([data], { type }) : null;
  } catch (e) { return null; }
}

// Makes the analysis copies: picture (1 frame/sec, 480 px) and/or sound (mono AAC)
export async function convertForAnalysis(file, { onProgress, video = true } = {}) {
  const f = await engine();
  const dir = '/in' + Date.now().toString(36);
  await f.createDir(dir);
  await f.mount('WORKERFS', { files: [file] }, dir);
  const input = `${dir}/${file.name}`;
  let log = '';
  const onLog = ({ message }) => { log += message + '\n'; };
  f.on('log', onLog);
  let info;
  try {
    // 1) What's inside the file?
    await f.exec(['-hide_banner', '-i', input]).catch(() => {});
    info = parseInfo(log);
    if (!info.hasVideo && !info.hasAudio) throw new Error('This file could not be read (no video or sound found).');

    // 2) Make the copies in one pass
    const onProg = ({ time }) => {
      if (!onProgress || !info.duration) return;
      const sec = time > info.duration * 1000 ? time / 1e6 : time; // ffmpeg reports microseconds
      onProgress(Math.max(0, Math.min(0.99, sec / info.duration)));
    };
    f.on('progress', onProg);
    const args = ['-hide_banner', '-y', '-i', input];
    const wantVideo = video && info.hasVideo;
    if (wantVideo) args.push('-map', '0:v:0', '-vf', 'fps=1,scale=480:-2', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'proxy.mp4');
    if (info.hasAudio) args.push('-map', '0:a:0', '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', 'audio.m4a');
    log = '';
    const rc = await f.exec(args);
    f.off('progress', onProg);
    if (rc !== 0) throw new Error('The conversion failed: ' + (log.split('\n').filter(Boolean).slice(-2).join(' ') || 'unknown error'));

    let thumb = null;
    if (wantVideo) {
      await f.exec(['-hide_banner', '-y', '-ss', String(Math.min(2, info.duration / 2 || 0)), '-i', 'proxy.mp4', '-frames:v', '1', 'thumb.jpg']).catch(() => {});
      thumb = await readOut(f, 'thumb.jpg', 'image/jpeg');
    }
    const blob = wantVideo ? await readOut(f, 'proxy.mp4', 'video/mp4') : null;
    const audio = info.hasAudio ? await readOut(f, 'audio.m4a', 'audio/mp4') : null;
    if (wantVideo && !blob) throw new Error('The video copy could not be made.');
    return {
      blob, audio, thumb,
      info: { duration: info.duration, width: info.width, height: info.height, converted: true, audioNote: info.hasAudio ? null : 'This video has no sound.' },
    };
  } finally {
    f.off('log', onLog);
    await f.unmount(dir).catch(() => {});
    await f.deleteDir(dir).catch(() => {});
  }
}
