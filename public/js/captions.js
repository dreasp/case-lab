// Captions: lines up your script with the word timings from AssemblyAI, builds caption lines
// for each format, and writes .srt files. The text always comes from your script.

const norm = w => w.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

export const PRESETS = {
  classic: { preset: 'classic', size: 1, y: 0.88, box: true, caps: false, highlight: '#ffd400' },
  bold: { preset: 'bold', size: 1, y: 0.66, box: false, caps: true, highlight: '#ffd400' },
};
export const DEFAULT_STYLE = { '16:9': { ...PRESETS.classic }, '9:16': { ...PRESETS.bold } };

// Script words with times. spoken = [{t, s, e}] from AssemblyAI.
export function alignWords(paragraphs, spoken) {
  const script = [];
  paragraphs.forEach((p, pi) => p.split(/\s+/).filter(Boolean).forEach(w => script.push({ w, p: pi, n: norm(w) })));
  const asr = spoken.map(x => ({ ...x, n: norm(x.t) })).filter(x => x.n);
  const n = script.length, m = asr.length;
  if (!n || !m) return script.map(x => ({ w: x.w, p: x.p, s: 0, e: 0 }));

  // Banded alignment (like comparing two versions of a text), so long scripts stay fast
  const band = Math.max(60, Math.ceil(Math.abs(n - m) * 1.2) + 60);
  const W = 2 * band + 1;
  const INF = 1e9;
  const cost = new Float32Array((n + 1) * W).fill(INF);
  const move = new Uint8Array((n + 1) * W); // 1 diag, 2 up (script gap), 3 left (asr gap)
  const center = i => Math.round(i * m / n);
  const idx = (i, j) => { const k = j - center(i) + band; return k >= 0 && k < W ? i * W + k : -1; };
  const at = (i, j) => { const q = idx(i, j); return q < 0 ? INF : cost[q]; };
  for (let i = 0; i <= n; i++) {
    const c = center(i);
    for (let j = Math.max(0, c - band); j <= Math.min(m, c + band); j++) {
      const q = idx(i, j);
      if (i === 0 && j === 0) { cost[q] = 0; continue; }
      let best = INF, mv = 0;
      if (i > 0 && j > 0) {
        const a = script[i - 1].n, b = asr[j - 1].n;
        const sub = a === b ? 0 : (a && b && (a.startsWith(b) || b.startsWith(a)) ? 0.5 : 1);
        const v = at(i - 1, j - 1) + sub;
        if (v < best) { best = v; mv = 1; }
      }
      if (i > 0) { const v = at(i - 1, j) + 1; if (v < best) { best = v; mv = 2; } }
      if (j > 0) { const v = at(i, j - 1) + 1; if (v < best) { best = v; mv = 3; } }
      cost[q] = best; move[q] = mv;
    }
  }
  // Walk back to find which spoken word belongs to which script word
  const match = new Array(n).fill(-1);
  let i = n, j = m;
  if (idx(i, j) < 0) j = Math.min(m, center(n));
  while (i > 0 && j >= 0) {
    const q = idx(i, j);
    const mv = q < 0 ? 2 : move[q];
    if (mv === 1) { match[i - 1] = j - 1; i--; j--; }
    else if (mv === 3) j--;
    else i--;
  }

  // Words the narration skipped or said differently get times from their neighbors
  const out = script.map((x, k) => {
    const a = match[k] >= 0 ? asr[match[k]] : null;
    return { w: x.w, p: x.p, s: a ? a.s : null, e: a ? a.e : null };
  });
  let k = 0;
  while (k < n) {
    if (out[k].s !== null) { k++; continue; }
    let end = k;
    while (end < n && out[end].s === null) end++;
    const from = k > 0 ? out[k - 1].e : (out[end] ? Math.max(0, out[end].s - 0.3 * (end - k)) : 0);
    const to = end < n ? out[end].s : from + 0.3 * (end - k);
    const step = (to - from) / (end - k);
    for (let q = k; q < end; q++) { out[q].s = from + step * (q - k); out[q].e = from + step * (q - k + 1); }
    k = end;
  }
  return out;
}

const endsSentence = w => /[.!?…]["”’)\]]*$/.test(w);
const endsClause = w => /[,;:—–-]["”’)\]]*$/.test(w);

// Caption lines for one style ('classic' = subtitles, 'bold' = a few big words at a time)
export function buildCues(words, preset) {
  const bold = preset === 'bold';
  const maxChars = bold ? 20 : 80;
  const maxWords = bold ? 3 : 999;
  const maxDur = bold ? 2.5 : 6;
  const cues = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({ s: cur[0].s, e: cur[cur.length - 1].e, words: cur.map(w => ({ w: w.w, s: w.s, e: w.e })) });
    cur = [];
  };
  words.forEach((w, i) => {
    const next = words[i + 1];
    cur.push(w);
    const chars = cur.map(x => x.w).join(' ').length;
    const nextChars = next ? chars + 1 + next.w.length : 0;
    const gap = next ? next.s - w.e : 0;
    if (!next ||
      (next && next.p !== w.p) ||
      endsSentence(w.w) && (bold || chars > 15) ||
      (bold && endsClause(w.w)) ||
      cur.length >= maxWords ||
      nextChars > maxChars ||
      gap > 0.6 ||
      (next && next.e - cur[0].s > maxDur)) flush();
  });
  flush();
  // Keep each line on screen a little longer (until the next starts), at least 0.7s
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i], nx = cues[i + 1];
    const limit = nx ? nx.s : c.e + 0.6;
    c.e = Math.min(limit, Math.max(c.e + 0.25, c.s + 0.7));
    c.id = 'c' + i;
  }
  return cues;
}

// After editing a line's text, spread its new words evenly over the line's time
export function setCueText(cue, text) {
  const ws = text.trim().split(/\s+/).filter(Boolean);
  const d = (cue.e - cue.s) / Math.max(1, ws.length);
  cue.words = ws.map((w, i) => ({ w, s: cue.s + d * i, e: cue.s + d * (i + 1) }));
  cue.edited = true;
}

export function setCueTime(cue, s, e) {
  const os = cue.s, oe = cue.e;
  cue.s = s; cue.e = Math.max(e, s + 0.2);
  const f = (cue.e - cue.s) / Math.max(0.01, oe - os);
  cue.words.forEach(w => { w.s = cue.s + (w.s - os) * f; w.e = cue.s + (w.e - os) * f; });
  cue.edited = true;
}

export const cueText = c => c.words.map(w => w.w).join(' ');

// .srt subtitle file (for YouTube Studio > Subtitles > Upload file)
export function toSRT(cues) {
  const ts = t => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  const wrap = text => {
    if (text.length <= 42) return text;
    // Split into two balanced lines
    const words = text.split(' ');
    let best = 1, bestDiff = Infinity;
    for (let i = 1; i < words.length; i++) {
      const d = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return words.slice(0, best).join(' ') + '\n' + words.slice(best).join(' ');
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.s)} --> ${ts(c.e)}\n${wrap(cueText(c))}\n`).join('\n');
}

// Move each sentence's start to the moment its first word is spoken (keeps all footage choices)
export function retimeShots(project) {
  const words = project.captions && project.captions.words;
  if (!words || !words.length) return 0;
  let wi = 0;
  const starts = project.sentences.map(sen => {
    const count = sen.text.split(/\s+/).filter(Boolean).length;
    const first = words[Math.min(wi, words.length - 1)];
    wi += count;
    return first ? Math.max(0, first.s - 0.15) : null;
  });
  if (starts.some(v => v === null)) return 0;
  let moved = 0;
  project.sentences.forEach((sen, i) => {
    const s = i === 0 ? 0 : starts[i];
    const e = i + 1 < starts.length ? starts[i + 1] : project.duration;
    if (Math.abs(sen.start - s) > 0.05) moved++;
    sen.start = s; sen.end = Math.max(e, s + 0.3);
  });
  for (const sen of project.sentences) {
    const parts = project.shots.filter(sh => sh.sid === sen.id);
    const d = (sen.end - sen.start) / Math.max(1, parts.length);
    parts.forEach((sh, k) => { sh.start = sen.start + d * k; sh.end = sen.start + d * (k + 1); });
  }
  return moved;
}
