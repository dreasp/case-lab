// Reads the narration (ElevenLabs AAF, or a normal MP3/WAV) and the script (Word or text),
// then works out when each sentence is spoken.

/* global CFB, mammoth */

// ---------- AAF ----------
function readProps(c) {
  // AAF "properties" stream: [byteOrder, version, count(u16)], then count x (pid, form, length), then values
  const out = {};
  if (!c || c.length < 4) return out;
  const n = c[2] | (c[3] << 8);
  let off = 4 + n * 6;
  for (let k = 0; k < n; k++) {
    const b = 4 + k * 6;
    const pid = c[b] | (c[b + 1] << 8);
    const len = c[b + 4] | (c[b + 5] << 8);
    out[pid] = c.subarray ? c.subarray(off, off + len) : c.slice(off, off + len);
    off += len;
  }
  return out;
}
const i32 = (b, o = 0) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24));

export async function readAAF(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const cf = CFB.read(buf, { type: 'array' });
  const re = /EssenceData-[0-9a-f]+\{([0-9a-f]+)\}\/Data-[0-9a-f]+$/i;
  let parts = [];
  let sampleRate = 0, bits = 0, channels = 0;
  cf.FullPaths.forEach((p, i) => {
    const m = p.match(re);
    const content = cf.FileIndex[i].content;
    if (m) parts.push({ idx: parseInt(m[1], 16), data: content });
    else if (/\/properties$/.test(p) && (!sampleRate || !bits)) {
      const pr = readProps(content);
      if (pr[0x3D03] && pr[0x3D03].length === 8 && !sampleRate) {
        const num = i32(pr[0x3D03], 0), den = i32(pr[0x3D03], 4) || 1;
        sampleRate = Math.round(num / den);
      }
      if (pr[0x3D01] && !bits) bits = i32(pr[0x3D01]);
      if (pr[0x3D07] && !channels) channels = i32(pr[0x3D07]);
    }
  });
  if (!parts.length) throw new Error('No audio found inside this AAF file.');
  parts.sort((a, b) => a.idx - b.idx);
  sampleRate = sampleRate || 44100;
  bits = bits || 16;
  const bytesPer = bits / 8;

  // Stereo exports store a second identical copy for the right channel: keep the first half
  if (parts.length % 2 === 0) {
    const half = parts.length / 2;
    const same = parts.slice(0, half).every((p, i) => p.data.length === parts[half + i].data.length);
    if (same) parts = parts.slice(0, half);
  }

  const clips = [];
  let pos = 0;
  for (const p of parts) {
    const samples = p.data.length / bytesPer;
    clips.push({ start: pos / sampleRate, end: (pos + samples) / sampleRate });
    pos += samples;
  }
  const wav = makeWav(parts.map(p => p.data), sampleRate, bits);
  return { clips, duration: pos / sampleRate, audio: wav, sampleRate };
}

function makeWav(chunks, rate, bits) {
  const dataLen = chunks.reduce((n, c) => n + c.length, 0);
  const h = new DataView(new ArrayBuffer(44));
  const w = (o, s) => [...s].forEach((ch, i) => h.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); h.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
  w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * bits / 8, true);
  h.setUint16(32, bits / 8, true); h.setUint16(34, bits, true);
  w(36, 'data'); h.setUint32(40, dataLen, true);
  return new Blob([h.buffer, ...chunks.map(c => (c instanceof Uint8Array ? c : new Uint8Array(c)))], { type: 'audio/wav' });
}

// ---------- plain audio ----------
export async function readAudio(file) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const ab = await ctx.decodeAudioData(await file.arrayBuffer());
    return { clips: null, duration: ab.duration, audio: file };
  } finally { ctx.close(); }
}

// ---------- script ----------
export async function readScript(file) {
  let text;
  if (/\.docx$/i.test(file.name)) {
    const r = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    text = r.value;
  } else {
    text = await file.text();
  }
  return text.split(/\r?\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// ---------- timing ----------
export function splitSentences(p) {
  const out = [];
  const re = /[^.!?…]+(?:[.!?…]+["”’)\]]*|$)/g;
  let m;
  while ((m = re.exec(p))) {
    const s = m[0].trim();
    if (!s) continue;
    // Keep abbreviations like "Mr." or "v." or initials attached to the next words
    const prev = out[out.length - 1];
    if (prev && /\b(Mr|Mrs|Ms|Dr|Jr|Sr|St|v|vs|U\.S|No|Lt|Sgt|Det|Gov|Sen|Rep|[A-Z])\.$/.test(prev)) {
      out[out.length - 1] = prev + ' ' + s;
    } else out.push(s);
  }
  return out.length ? out : [p];
}

const MIN_SHOT = 2.2;   // seconds
const MAX_SHOT = 8.0;

export function buildTimeline(paragraphs, clips, duration) {
  let matched = !!clips && clips.length === paragraphs.length;
  let pTimes;
  if (matched) {
    pTimes = clips;
  } else {
    // Spread paragraphs across the audio by length
    const total = paragraphs.reduce((n, p) => n + p.length + 20, 0);
    let t = 0;
    pTimes = paragraphs.map(p => {
      const d = duration * (p.length + 20) / total;
      const r = { start: t, end: t + d }; t += d; return r;
    });
  }

  const sentences = [];
  paragraphs.forEach((p, pi) => {
    const ss = splitSentences(p);
    const { start, end } = pTimes[pi];
    const weights = ss.map(s => s.length + 8);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = start;
    ss.forEach((s, si) => {
      const d = (end - start) * weights[si] / total;
      sentences.push({ id: 's' + (sentences.length + 1), p: pi, text: s, start: t, end: t + d });
      t += d;
    });
  });

  // Merge very short sentences into a neighbor in the same paragraph
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.end - s.start >= MIN_SHOT) continue;
    const next = sentences[i + 1], prev = sentences[i - 1];
    if (next && next.p === s.p) { next.text = s.text + ' ' + next.text; next.start = s.start; sentences.splice(i, 1); i--; }
    else if (prev && prev.p === s.p) { prev.text += ' ' + s.text; prev.end = s.end; sentences.splice(i, 1); i--; }
  }
  sentences.forEach((s, i) => { s.id = 's' + (i + 1); });

  // Long sentences get more than one shot
  const shots = [];
  for (const s of sentences) {
    const d = s.end - s.start;
    const n = Math.max(1, Math.ceil(d / MAX_SHOT));
    for (let k = 0; k < n; k++) {
      shots.push({
        id: 'shot' + (shots.length + 1), sid: s.id, part: k, parts: n,
        start: s.start + d * k / n, end: s.start + d * (k + 1) / n, choice: null,
      });
    }
  }
  return { sentences, shots, matched };
}

export function wordCountCheck(paragraphs, clips) {
  // How well paragraph lengths follow clip lengths (1 = perfect)
  if (!clips || clips.length !== paragraphs.length || clips.length < 3) return null;
  const x = paragraphs.map(p => p.split(/\s+/).length), y = clips.map(c => c.end - c.start);
  const mx = x.reduce((a, b) => a + b) / x.length, my = y.reduce((a, b) => a + b) / y.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy || 1);
}
