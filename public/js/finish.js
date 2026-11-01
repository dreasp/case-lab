// Final video (footage step 3): your recorded narration is matched to the narration parts,
// then the whole story is built at full quality from your original footage.

import { alignWords, buildCues, DEFAULT_STYLE } from './captions.js';
import { mediaUrl, mediaBlob, migrate } from './media.js';

let X = null;
const $ = id => document.getElementById(id);
const WPS = 2.6;
const LEAD = 0.15, TAIL = 0.4;      // short pauses around each narration part
const NATIVE = /\.(mp4|mov|m4v)$/i;
const label = f => f ? (f.path || f.name) : 'missing file';
const fmt1 = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; };
const UNDER = { next: 'Lead-up to the next clip', prev: 'What comes after the last clip', still: 'Still frame of the next clip', black: 'Black screen' };
const IMG = /\.(jpe?g|png|webp|gif)$/i;

export function initFinish(helpers) {
  X = helpers;
  $('narrFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadNarration(f); });
  $('narrParts').addEventListener('click', onPartClick);
  $('narrParts').addEventListener('change', async e => {
    const d = e.target.dataset;
    if (d.under) {
      const n = narr(); n.under = n.under || {}; n.under[d.under] = e.target.value;
      await X.save();
      renderFinish();
    }
  });
  $('finDuck').addEventListener('input', () => { $('finDuckVal').textContent = $('finDuck').value + '%'; });
  ['finAspect', 'finCaps', 'finDuck'].forEach(id => $(id).addEventListener('change', async () => {
    const n = narr(); n.opts = { aspect: $('finAspect').value, caps: $('finCaps').value, duck: +$('finDuck').value };
    await X.save();
  }));
  $('finExport').addEventListener('click', exportVideo);
  wireFinalPreview();
  $('finCancel').addEventListener('click', () => { if (worker) worker.postMessage({ type: 'cancel' }); });
  const a = $('narrAudio');
  a.addEventListener('timeupdate', () => { if (a.dataset.stop && a.currentTime >= +a.dataset.stop) { a.pause(); delete a.dataset.stop; } });
}

const narr = () => { const c = X.cur(); if (!c.narr) c.narr = {}; return c.narr; };
const narrKey = c => `${c.id}:n:narration`;
const storySegs = c => (c.story && c.story.segments) || [];
const narrParts = c => storySegs(c).filter(s => s.type === 'narration' && (s.text || '').trim());

// ---------- narration ----------
async function uploadNarration(file) {
  const c = X.cur();
  if (!narrParts(c).length) return alert('Build the story first (Story tab), so the app knows your narration parts.');
  const n = narr();
  if (n.words && !confirm('Replace the narration audio you uploaded before?')) return;
  $('narrInfo').textContent = 'Reading the audio…';
  let duration = 0;
  try { duration = await audioDuration(file); } catch (e) { return alert('This audio file could not be read. Use MP3, WAV or M4A.'); }
  await X.putFile(narrKey(c), file);
  Object.assign(n, { name: file.name, size: file.size, duration, words: null, adj: {}, at: Date.now() });
  await X.save();
  narrUrl = null;
  renderFinish();
  // Word timing from AssemblyAI (about 4 cents for 10 minutes)
  $('narrInfo').textContent = 'Finding where each narration part is (word timing)… about a minute.';
  try {
    const r = await fetch('/api/captions/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, credentials: 'same-origin' });
    const st = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(st.error || `Upload failed (${r.status})`);
    let res;
    for (let i = 0; i < 300; i++) {
      await new Promise(ok => setTimeout(ok, 3000));
      res = await X.api('captions/status/' + st.id);
      if (res.status === 'completed' || res.status === 'error') break;
    }
    if (!res || res.status !== 'completed') throw new Error((res && res.error) || 'Timing took too long. Try again.');
    n.words = res.words;
    await X.save();
    X.refreshUsage();
  } catch (e) {
    alert('Could not time the narration: ' + e.message);
  }
  renderFinish();
}

function audioDuration(file) {
  return new Promise((ok, bad) => {
    const a = new Audio();
    const u = URL.createObjectURL(file);
    a.preload = 'metadata';
    a.onloadedmetadata = () => { URL.revokeObjectURL(u); ok(a.duration || 0); };
    a.onerror = () => { URL.revokeObjectURL(u); bad(new Error('unreadable')); };
    a.src = u;
  });
}

// Where each narration part is in the recording (worked out again from the stored word timing,
// so editing a part's text later still works)
function matchParts(c) {
  const n = c.narr || {};
  const parts = narrParts(c);
  if (!n.words || !n.words.length || !parts.length) return null;
  const words = alignWords(parts.map(p => p.text), n.words);
  return parts.map((p, i) => {
    const ws = words.filter(w => w.p === i);
    const adj = (n.adj || {})[p.id] || { d0: 0, d1: 0 };
    let a0 = ws.length ? ws[0].s : 0, a1 = ws.length ? ws[ws.length - 1].e : 0;
    a0 = Math.max(0, a0 - 0.05 + adj.d0);
    a1 = Math.min(n.duration || a1 + 1, a1 + 0.1 + adj.d1);
    const expected = ws.length / WPS;
    const ok = a1 > a0 && (a1 - a0) > expected * 0.45 && (a1 - a0) < expected * 2.2 + 2;
    return { id: p.id, a0, a1, ok, words: ws, text: p.text };
  });
}

let narrUrl = null;
async function narrSrc() {
  if (narrUrl) return narrUrl;
  const blob = await X.getFile(narrKey(X.cur()));
  if (!blob) throw new Error('The narration audio is not on this computer or in the cloud. Upload it again.');
  narrUrl = URL.createObjectURL(blob);
  return narrUrl;
}

async function onPartClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const c = X.cur();
  const id = b.closest('[data-id]').dataset.id;
  const m = (matchParts(c) || []).find(x => x.id === id);
  if (!m) return;
  if (b.dataset.act === 'play') {
    const a = $('narrAudio');
    try { a.src = await narrSrc(); } catch (err) { return alert(err.message); }
    a.currentTime = m.a0; a.dataset.stop = m.a1; a.play().catch(() => {});
    return;
  }
  const n = narr(); n.adj = n.adj || {};
  const adj = n.adj[id] || { d0: 0, d1: 0 };
  const d = +b.dataset.d;
  if (b.dataset.act === 'start') adj.d0 = Math.round((adj.d0 + d) * 100) / 100; else adj.d1 = Math.round((adj.d1 + d) * 100) / 100;
  n.adj[id] = adj;
  await X.save();
  renderFinish();
}

export function renderFinish() {
  const c = X.cur();
  if (!c) return;
  if (migrate(c)) X.save();
  const n = c.narr || {};
  const o = n.opts || {};
  $('finAspect').value = o.aspect || '16:9';
  $('finCaps').value = o.caps || 'footage';
  $('finDuck').value = o.duck != null ? o.duck : 15;
  $('finDuckVal').textContent = $('finDuck').value + '%';
  const parts = narrParts(c);
  if (!storySegs(c).length) {
    $('narrInfo').textContent = 'Build the story first (Story tab).';
    $('narrParts').innerHTML = '';
    $('finSummary').textContent = '';
    $('finExport').disabled = true;
    return;
  }
  const m = matchParts(c);
  $('narrInfo').textContent = n.name ? `${n.name} · ${X.fmtH(n.duration || 0)}${n.words ? '' : ' · not matched yet'}` : `No narration uploaded yet. Your story has ${parts.length} narration parts.`;
  const under = n.under || {};
  $('narrParts').innerHTML = parts.map((p, i) => {
    const x = m && m[i];
    return `<li class="np ${x && !x.ok ? 'warn' : ''}" data-id="${p.id}">
      <div class="np-head"><strong>Narration ${i + 1}</strong>
        ${x ? `<span class="mono small-text">${fmt1(x.a0)} to ${fmt1(x.a1)} (${(x.a1 - x.a0).toFixed(1)}s)</span>
        <button class="btn ghost small" data-act="play" type="button">▶ Listen</button>
        <span class="np-adj small-text">Start <button class="btn ghost" data-act="start" data-d="-0.25" type="button">−</button><button class="btn ghost" data-act="start" data-d="0.25" type="button">+</button>
        End <button class="btn ghost" data-act="end" data-d="-0.25" type="button">−</button><button class="btn ghost" data-act="end" data-d="0.25" type="button">+</button></span>
        ${x.ok ? '<span class="np-ok small-text">Matched</span>' : '<span class="np-bad small-text">Check this one: the timing looks off</span>'}` : ''}
        ${(p.media || []).length ? `<span class="small-text muted np-under">On screen: your ${p.media.length} photo${p.media.length > 1 ? 's/videos' : ' or video'} (set on the Story tab)</span>` : `<label class="small-text muted np-under">Under it <select data-under="${p.id}">${Object.entries(UNDER).map(([k, v]) => `<option value="${k}" ${(under[p.id] || 'next') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`}
      </div>
      <div class="np-text">${X.esc(p.text.slice(0, 220))}${p.text.length > 220 ? '…' : ''}</div>
    </li>`;
  }).join('');
  const plan = m ? buildPlan(c, m) : null;
  $('finSummary').textContent = plan ? `The video will be about ${X.fmtH(plan.total)} long: ${plan.clips} clips from ${plan.files.size} file${plan.files.size === 1 ? '' : 's'} and ${parts.length} narration parts.${plan.convert.size ? ` ${plan.convert.size} file${plan.convert.size === 1 ? '' : 's'} (like WMV) will have the needed parts converted first.` : ''}` : 'Upload your narration to continue.';
  $('finExport').disabled = !plan || !!worker;
  $('finPreview').disabled = !plan;
}

// ---------- the plan: every segment on the final timeline ----------
function buildPlan(c, matched) {
  const segs = storySegs(c);
  const byId = Object.fromEntries(matched.map(m => [m.id, m]));
  const n = c.narr || {};
  const duck = ((n.opts && n.opts.duck) != null ? n.opts.duck : 15) / 100;
  const out = [];
  const files = new Set(), convert = new Set();
  let t = 0, clips = 0;
  const clipAt = (i, dir) => { for (let k = i + dir; k >= 0 && k < segs.length; k += dir) if (segs[k].type === 'clip' && X.fileById(segs[k].file)) return segs[k]; return null; };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.type === 'clip') {
      const f = X.fileById(s.file);
      if (!f) continue;
      const dur = Math.max(0.5, s.end - s.start);
      files.add(f.id); if (!NATIVE.test(f.name) || f.type === 'audio') convert.add(f.id);
      const pic = (s.media || []).length ? { own: s.media } : f.type === 'video' ? { file: f, from: s.start } : { card: f.analysis && f.analysis.camera ? cap(f.analysis.camera) : 'Audio recording', sub: label(f) };
      out.push({ kind: 'clip', t0: t, dur, file: f, from: s.start, pic, sound: [{ file: f, from: s.start, gain: 1 }], seg: s });
      clips++;
      t += dur;
      continue;
    }
    const m = byId[s.id];
    if (!m) continue;
    const len = m.a1 - m.a0;
    const dur = LEAD + len + TAIL;
    const prev = clipAt(i, -1), next = clipAt(i, 1);
    let mode = (n.under || {})[s.id] || 'next';
    let pic = null, sound = [];
    const tryNext = () => {
      if (!next) return false;
      const f = X.fileById(next.file);
      const from = next.start - dur;
      if (from < 0) return false;
      if (prev && prev.file === next.file && prev.end > from) return false; // would repeat what was just shown
      pic = f.type === 'video' ? { file: f, from } : { card: cap((f.analysis && f.analysis.camera) || 'Audio recording'), sub: label(f) };
      sound = [{ file: f, from, gain: duck }];
      files.add(f.id); if (!NATIVE.test(f.name) || f.type === 'audio') convert.add(f.id);
      return true;
    };
    const tryPrev = () => {
      if (!prev) return false;
      const f = X.fileById(prev.file);
      const from = prev.end;
      if (from + dur > (f.duration || 0)) return false;
      if (next && next.file === prev.file && next.start < from + dur && next.start >= from) return false;
      pic = f.type === 'video' ? { file: f, from } : { card: cap((f.analysis && f.analysis.camera) || 'Audio recording'), sub: label(f) };
      sound = [{ file: f, from, gain: duck }];
      files.add(f.id); if (!NATIVE.test(f.name) || f.type === 'audio') convert.add(f.id);
      return true;
    };
    const still = () => {
      const k = next || prev;
      if (!k) return;
      const f = X.fileById(k.file);
      if (f.type !== 'video') { pic = { card: cap((f.analysis && f.analysis.camera) || 'Audio recording'), sub: label(f) }; return; }
      pic = { file: f, from: next ? next.start : Math.max(0, prev.end - 0.1), freeze: true };
      files.add(f.id); if (!NATIVE.test(f.name)) convert.add(f.id);
    };
    const own = s.media || [];
    if (own.length) pic = { own };
    else if (mode === 'next' || mode === 'own') { if (!tryNext() && !tryPrev()) still(); }
    else if (mode === 'prev') { if (!tryPrev() && !tryNext()) still(); }
    else if (mode === 'still') still();
    out.push({ kind: 'narr', t0: t, dur, pic, sound, narr: { a0: m.a0, len, lead: LEAD }, match: m, seg: s });
    t += dur;
  }
  return { segs: out, total: t, clips, files, convert };
}
const cap = s => String(s || '').replace(/^./, x => x.toUpperCase());
// Caption colors per speaker (readable on the dark caption box)
const SPEAKER_COLORS = ['#ffffff', '#ffd84d', '#7fdcff', '#9be89b', '#ff9fcf', '#ffb26b', '#c7a6ff'];
function splitCue(q, max) {
  if (q.words.length <= max) return [q];
  const out = [];
  for (let i = 0; i < q.words.length; i += max) { const w = q.words.slice(i, i + max); out.push({ s: w[0].s, e: w[w.length - 1].e, words: w }); }
  out[out.length - 1].e = Math.max(out[out.length - 1].e, q.e);
  return out;
}

// ---------- captions ----------
function captionCues(plan, mode, aspect) {
  if (mode === 'off') return null;
  const style = { ...DEFAULT_STYLE[aspect] };
  const preset = style.preset;
  let all = [];
  if (mode === 'narr' || mode === 'both') {
    for (const sg of plan.segs.filter(x => x.kind === 'narr')) {
      const off = sg.t0 + LEAD - sg.match.a0;
      const words = sg.match.words.map(w => ({ w: w.w, p: 0, s: w.s + off, e: w.e + off }));
      all = all.concat(buildCues(words, preset));
    }
  }
  if (mode === 'footage' || mode === 'both') {
    const colors = new Map(); // speaker name -> color, in the order they are first heard
    const colorOf = who => { if (!colors.has(who)) colors.set(who, SPEAKER_COLORS[colors.size % SPEAKER_COLORS.length]); return colors.get(who); };
    for (const sg of plan.segs.filter(x => x.kind === 'clip')) {
      const f = sg.file;
      const names = X.speakerMap(f);
      const utt = ((f.transcript && f.transcript.utterances) || []).filter(u => u.e > sg.from && u.s < sg.from + sg.dur);
      for (const u of utt) {
        const ws = String(u.text || '').split(/\s+/).filter(Boolean);
        if (!ws.length) continue;
        const step = (u.e - u.s) / ws.length;
        const words = [];
        ws.forEach((w, k) => {
          const s = u.s + step * k, e = s + step;
          if (s >= sg.from - 0.05 && e <= sg.from + sg.dur + 0.3) words.push({ w, p: 0, s: sg.t0 + (s - sg.from), e: sg.t0 + Math.min(sg.dur, e - sg.from) });
        });
        if (!words.length) continue;
        const who = names[u.sp] || 'Speaker ' + u.sp;
        // the speaker's name takes room on screen, so lines are a little shorter
        for (const q of buildCues(words, preset).flatMap(q => splitCue(q, preset === 'bold' ? 3 : 9))) { q.who = who; q.color = colorOf(who); all.push(q); }
      }
    }
  }
  all.sort((a, b) => a.s - b.s);
  for (let i = 0; i < all.length - 1; i++) if (all[i].e > all[i + 1].s) all[i].e = all[i + 1].s;
  return { cues: all.filter(x => x.e > x.s), style };
}

// ---------- export ----------
let worker = null;

async function exportVideo() {
  const c = X.cur();
  const m = matchParts(c);
  if (!m) return alert('Upload your narration first.');
  const bad = m.filter(x => !x.ok).length;
  if (bad && !confirm(`${bad} narration part${bad > 1 ? 's look' : ' looks'} off (marked "Check this one"). Export anyway?`)) return;
  // Chrome only shows its "allow access" question right after a click
  if ((await X.checkAccess()) !== 'granted') {
    if (await X.requestAccess()) alert('Thanks. Click "Export video" again to start.');
    else alert('Case Lab needs your OK to read the footage folder to build the video.');
    return;
  }
  let fileHandle = null;
  if (window.showSaveFilePicker) {
    try {
      fileHandle = await window.showSaveFilePicker({ suggestedName: `${c.title.replace(/[^\w\s()-]/g, '').trim() || 'case'}.mp4`, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
    } catch (e) { if (e.name === 'AbortError') return; fileHandle = null; }
  }
  if (!fileHandle) return alert('Your browser can\'t save large files directly. Please use an up-to-date Chrome on a computer.');

  const opts = (c.narr && c.narr.opts) || {};
  const aspect = opts.aspect || '16:9';
  const duckGain = (opts.duck != null ? opts.duck : 15) / 100;
  const plan = buildPlan(c, m);
  const progress = (frac, text) => { $('finProgress').classList.remove('hidden'); $('finFill').style.width = `${Math.round(frac * 100)}%`; $('finText').textContent = text; };
  $('finExport').disabled = true; $('finCancel').classList.remove('hidden'); $('finResult').innerHTML = '';
  let cancelledPrep = false;
  $('finCancel').onclick = () => { cancelledPrep = true; if (worker) worker.postMessage({ type: 'cancel' }); };
  try {
    // 1) Originals: MP4/MOV are read directly; other formats get just the needed parts converted
    progress(0, 'Getting your footage ready…');
    const sources = {};
    const locate = new Map(); // file id -> (t => { sid, from })
    const used = new Map();   // file id -> [[a, b]] time ranges needed
    const need = (f, a, b) => { if (!used.has(f.id)) used.set(f.id, []); used.get(f.id).push([a, b]); };
    for (const sg of plan.segs) {
      if (sg.pic && sg.pic.file) need(sg.pic.file, sg.pic.from, sg.pic.from + (sg.pic.freeze ? 0.5 : sg.dur));
      for (const s of sg.sound) need(s.file, s.from, s.from + sg.dur);
    }
    const toConvert = [];
    for (const [fid, ranges] of used) {
      const f = X.fileById(fid);
      const file = await X.getLocalFile(f).catch(() => null);
      if (!file) throw new Error(`"${label(f)}" is not available on this computer. Open the case on the computer with the footage folder.`);
      if (NATIVE.test(f.name) && f.type === 'video') {
        sources[fid] = { blob: file, name: label(f) };
        locate.set(fid, t => ({ sid: fid, from: t }));
        continue;
      }
      // merge nearby ranges, so one conversion covers several clips
      ranges.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const [a, b] of ranges) { const last = merged[merged.length - 1]; if (last && a <= last[1] + 20) last[1] = Math.max(last[1], b); else merged.push([a, b]); }
      const pieces = merged.map(([a, b]) => ({ a: Math.max(0, a - 0.5), b: Math.min(f.duration || b + 1, b + 0.5) }));
      pieces.forEach(pc => { pc.sid = `${fid}@${Math.round(pc.a * 10)}`; toConvert.push({ f, file, pc }); });
      locate.set(fid, t => { const pc = pieces.find(x => t >= x.a - 0.01 && t <= x.b + 0.01) || pieces[0]; return { sid: pc.sid, from: Math.max(0, t - pc.a) }; });
    }
    if (toConvert.length) {
      const { convertRange } = await import('./convert.js');
      const totalSec = toConvert.reduce((x, y) => x + (y.pc.b - y.pc.a), 0);
      let doneSec = 0;
      for (const { f, file, pc } of toConvert) {
        if (cancelledPrep) throw new Error('Export cancelled');
        const len = pc.b - pc.a;
        const blob = await convertRange(file, pc.a, len, {
          video: f.type === 'video',
          onProgress: p => progress(0.3 * (doneSec + p * len) / totalSec, `Converting the parts of "${label(f)}" that are used (${X.fmtH(doneSec + p * len)} of ${X.fmtH(totalSec)})…`),
        });
        sources[pc.sid] = { blob, name: label(f) };
        doneSec += len;
      }
    }
    if (cancelledPrep) throw new Error('Export cancelled');

    // 2) Narration as 48 kHz mono
    progress(0.3, 'Reading the narration…');
    const nb = await X.getFile(narrKey(c));
    if (!nb) throw new Error('The narration audio is not on this computer or in the cloud. Upload it again.');
    const ab = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await nb.arrayBuffer());
    const pcm = new Float32Array(ab.length);
    for (let ch = 0; ch < ab.numberOfChannels; ch++) { const d = ab.getChannelData(ch); for (let i = 0; i < d.length; i++) pcm[i] += d[i] / ab.numberOfChannels; }
    // even out the narration level
    let sum = 0; for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / Math.max(1, pcm.length / 4));
    const narrGain = rms > 1e-4 ? Math.max(0.5, Math.min(4, 0.12 / rms)) : 1;

    // Your own photos and videos
    progress(0.3, 'Getting your photos and videos ready…');
    for (const sg of plan.segs) {
      for (const it of (sg.pic && sg.pic.own) || []) {
        const sid = 'own:' + it.id;
        if (sources[sid]) continue;
        const blob = await mediaBlob(it);
        if (!blob) throw new Error(`"${it.name}" could not be found. Remove it from the narration part or add it again.`);
        sources[sid] = { blob, name: it.name };
      }
    }

    // 3) The job for the background engine
    const where = (f, t) => locate.get(f.id)(t);
    const segs = plan.segs.map(sg => {
      if (sg.pic && sg.pic.own) {
        const d = sg.dur / sg.pic.own.length;
        const pics = sg.pic.own.map((it, k) => ({ t: k * d, dur: d, pic: it.kind === 'photo' ? { img: 'own:' + it.id, kb: k % 2 } : { sid: 'own:' + it.id, from: 0 } }));
        const sound = sg.kind === 'clip'
          ? sg.sound.map(s => { const w = where(s.file, s.from); return { sid: w.sid, from: w.from, gain: s.gain }; })
          : sg.pic.own.map((it, k) => it.kind === 'video' ? { sid: 'own:' + it.id, from: 0, gain: duckGain, at: k * d, len: d } : null).filter(Boolean);
        return { t0: sg.t0, dur: sg.dur, pic: null, pics, sound, narr: sg.narr || null };
      }
      let pic = null;
      if (sg.pic && sg.pic.file) { const w = where(sg.pic.file, sg.pic.from); pic = { sid: w.sid, from: w.from, freeze: !!sg.pic.freeze }; }
      else if (sg.pic && sg.pic.card) pic = { card: sg.pic.card, sub: sg.pic.sub };
      const sound = sg.sound.map(s => { const w = where(s.file, s.from); return { sid: w.sid, from: w.from, gain: s.gain }; });
      return { t0: sg.t0, dur: sg.dur, pic, sound, narr: sg.narr || null };
    });
    const job = {
      aspect, bitrate: aspect === '9:16' ? 10_000_000 : 12_000_000,
      sources, segs, narration: pcm, narrGain, fileHandle,
      captions: captionCues(plan, opts.caps || 'footage', aspect),
    };
    progress(0.3, 'Building the video…');
    const res = await new Promise((ok, bad) => {
      worker = new Worker('/js/story-export-worker.js');
      worker.onmessage = e => {
        const d = e.data;
        if (d.type === 'progress') progress(0.3 + 0.7 * d.frac, d.text);
        else if (d.type === 'done') ok(d);
        else if (d.type === 'cancelled') bad(new Error(d.message || 'Export cancelled'));
        else if (d.type === 'error') bad(new Error(d.message));
      };
      worker.onerror = e => bad(new Error(e.message || 'The video engine stopped.'));
      worker.postMessage({ type: 'start', job }, [pcm.buffer]);
    });
    progress(1, 'Done');
    $('finResult').innerHTML = `<div class="story-note"><strong>Your video is saved</strong> as "${X.esc(fileHandle.name)}" (${X.fmtH(res.duration)} long, built in ${X.fmtH(res.seconds)}).${res.problems.length ? `<br><br><strong>Some parts had problems:</strong><ul>${res.problems.map(p => `<li>${X.esc(p)}</li>`).join('')}</ul>` : ''}</div>`;
  } catch (e) {
    $('finResult').innerHTML = `<div class="story-note"><strong>${/cancel/i.test(e.message) ? 'Export cancelled' : 'The export stopped'}</strong>${/cancel/i.test(e.message) ? '' : ': ' + X.esc(e.message)}</div>`;
  } finally {
    if (worker) { worker.terminate(); worker = null; }
    $('finCancel').classList.add('hidden');
    $('finProgress').classList.add('hidden');
    renderFinish();
  }
}

// ---------- preview: the whole video with your real narration, before exporting ----------
let PV = null;
const PLAYABLE_AUDIO = /\.(mp3|wav|m4a|aac|ogg)$/i;

async function previewMedia(f) {
  if (PV.media.has(f.id)) return PV.media.get(f.id);
  let m = null;
  const local = async () => { const file = await X.getLocalFile(f); const u = URL.createObjectURL(file); PV.urls.push(u); return u; };
  if (f.type === 'video' && NATIVE.test(f.name)) { try { m = { video: await local(), audio: null, note: '' }; } catch (e) { /* copies below */ } }
  if (!m && f.type === 'audio' && PLAYABLE_AUDIO.test(f.name)) { try { m = { video: null, audio: await local(), note: '' }; } catch (e) { /* below */ } }
  if (!m) {
    const [v, a] = await X.signedUrls([f.type === 'video' ? f.proxyKey : null, f.audioKey]);
    m = { video: f.type === 'video' ? v : null, audio: a || null, note: f.type === 'video' ? 'This part shows the analysis copy (1 frame a second) with the real sound. The exported video uses your original footage.' : '' };
  }
  PV.media.set(f.id, m);
  return m;
}

async function previewFinal() {
  const c = X.cur();
  const m = matchParts(c);
  if (!m) return alert('Upload your narration first.');
  const opts = (c.narr && c.narr.opts) || {};
  const plan = buildPlan(c, m);
  const caps = captionCues(plan, opts.caps || 'footage', '16:9');
  let nurl;
  try { nurl = await narrSrc(); } catch (e) { return alert(e.message); }
  PV = { plan, cues: caps ? caps.cues : [], i: -1, token: 0, playing: true, base: 0, wall: performance.now(), media: new Map(), urls: [], duck: (opts.duck != null ? opts.duck : 15) / 100 };
  $('fpNarr').src = nurl;
  $('fpTotal').textContent = X.fmtH(plan.total);
  $('fpBar').innerHTML = '<div id="fpFill"></div>' + plan.segs.slice(1).map(sg => `<i style="left:${sg.t0 / plan.total * 100}%"></i>`).join('');
  $('fpPlay').textContent = 'Pause';
  $('finDialog').showModal();
  await seekTo(0);
  requestAnimationFrame(tick);
}

const nowT = () => PV.playing ? PV.base + (performance.now() - PV.wall) / 1000 : PV.base;
const segAt = T => { const s = PV.plan.segs; let i = s.findIndex(x => T < x.t0 + x.dur); return i < 0 ? s.length - 1 : i; };

async function seekTo(T) {
  if (!PV) return;
  T = Math.max(0, Math.min(PV.plan.total - 0.05, T));
  PV.base = T; PV.wall = performance.now();
  const i = segAt(T);
  await loadSeg(i, T - PV.plan.segs[i].t0);
}

function stopAll() {
  ['fpVideo', 'fpAudio', 'fpNarr'].forEach(id => $(id).pause());
}

async function loadSeg(i, into) {
  const token = ++PV.token;
  stopAll();
  const sg = PV.plan.segs[i];
  PV.i = i; PV.narrStarted = false; PV.ownK = -1; PV.freeze = false;
  const V = $('fpVideo'), A = $('fpAudio'), N = $('fpNarr'), IMG = $('fpImg'), CARD = $('fpCard');
  const nIdx = PV.plan.segs.slice(0, i + 1).filter(x => x.kind === 'narr').length;
  $('fpMeta').textContent = `${i + 1} of ${PV.plan.segs.length} · ${sg.kind === 'clip' ? 'clip' : 'narration ' + nIdx}`;
  $('fpTitle').textContent = sg.kind === 'clip' ? `${sg.seg.label || 'Clip'} · ${label(sg.file)}` : `Narration ${nIdx}`;
  $('fpNote').textContent = '';
  V.classList.remove('hidden'); IMG.classList.add('hidden'); CARD.classList.add('hidden');
  A.removeAttribute('src'); A.dataset.src = '';
  const gain = sg.kind === 'clip' ? 1 : PV.duck;
  const pic = sg.pic;
  PV.vidFrom = null; PV.audFrom = null;
  if (pic && pic.own) {
    const d = sg.dur / pic.own.length;
    const k = Math.min(pic.own.length - 1, Math.floor(into / d));
    PV.ownK = k; PV.ownD = d;
    const it = pic.own[k];
    const u = await mediaUrl(it).catch(() => null);
    if (token !== PV.token) return;
    if (it.kind === 'photo') { V.classList.add('hidden'); IMG.src = u || ''; IMG.classList.remove('hidden'); IMG.dataset.kb = k % 2; }
    else { if (V.dataset.src !== u) { V.src = u || ''; V.dataset.src = u || ''; } V.muted = sg.kind === 'clip'; V.volume = PV.duck; PV.vidFrom = 0 - k * d; }
    if (sg.kind === 'clip' && sg.sound[0]) {
      const md = await previewMedia(sg.sound[0].file);
      if (token !== PV.token) return;
      const su = md.audio || md.video;
      if (su) { A.src = su; A.dataset.src = su; A.volume = 1; PV.audFrom = sg.sound[0].from - (sg.t0 - sg.t0); }
    }
  } else if (pic && pic.file) {
    const md = await previewMedia(pic.file);
    if (token !== PV.token) return;
    $('fpNote').textContent = md.note;
    if (md.video) { if (V.dataset.src !== md.video) { V.src = md.video; V.dataset.src = md.video; } }
    PV.freeze = !!pic.freeze;
    V.muted = PV.freeze || !!md.audio;
    V.volume = Math.min(1, gain);
    PV.vidFrom = pic.from;
    if (md.audio && !PV.freeze && sg.sound.length) { A.src = md.audio; A.dataset.src = md.audio; A.volume = Math.min(1, gain); PV.audFrom = sg.sound[0].from; }
  } else if (pic && pic.card) {
    V.classList.add('hidden');
    CARD.textContent = `${pic.card}\n${pic.sub || ''}`; CARD.classList.remove('hidden');
    const f = sg.sound[0] && sg.sound[0].file;
    if (f) { const md = await previewMedia(f); if (token !== PV.token) return; if (md.audio) { A.src = md.audio; A.dataset.src = md.audio; A.volume = Math.min(1, gain); PV.audFrom = sg.sound[0].from; } }
  } else {
    V.classList.add('hidden');
  }
  const waitMeta = el => el.readyState >= 1 ? null : new Promise(r => { el.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 4000); });
  await Promise.all([PV.vidFrom != null ? waitMeta(V) : null, PV.audFrom != null ? waitMeta(A) : null]);
  if (token !== PV.token) return;
  if (PV.vidFrom != null) V.currentTime = Math.max(0, PV.freeze ? PV.vidFrom : PV.vidFrom + into);
  if (PV.audFrom != null) A.currentTime = Math.max(0, PV.audFrom + into);
  if (sg.narr) N.currentTime = sg.narr.a0 + Math.max(0, into - sg.narr.lead);
  if (PV.playing) playNow(into);
}

function playNow(into) {
  const sg = PV.plan.segs[PV.i];
  if (PV.vidFrom != null && !PV.freeze) $('fpVideo').play().catch(() => {});
  if (PV.audFrom != null) $('fpAudio').play().catch(() => {});
  if (sg.narr && into >= sg.narr.lead && into < sg.narr.lead + sg.narr.len) { $('fpNarr').play().catch(() => {}); PV.narrStarted = true; }
}

function tick() {
  if (!PV) return;
  const T = nowT();
  const segs = PV.plan.segs;
  const sg = segs[PV.i];
  if (sg && PV.playing) {
    const into = T - sg.t0;
    if (T >= PV.plan.total) { togglePlay(false); PV.base = PV.plan.total; }
    else if (into >= sg.dur && PV.i < segs.length - 1) { loadSeg(PV.i + 1, T - segs[PV.i + 1].t0); }
    else if (sg.pic && sg.pic.own && Math.min(sg.pic.own.length - 1, Math.floor(into / PV.ownD)) !== PV.ownK) { loadSeg(PV.i, into); }
    else {
      if (sg.narr && !PV.narrStarted && into >= sg.narr.lead) { $('fpNarr').play().catch(() => {}); PV.narrStarted = true; }
      if (sg.narr && into >= sg.narr.lead + sg.narr.len) $('fpNarr').pause();
      // keep the 1-frame-a-second picture in step with the sound
      const V = $('fpVideo'), A = $('fpAudio');
      if (PV.audFrom != null && PV.vidFrom != null && !PV.freeze && Math.abs((V.currentTime - PV.vidFrom) - (A.currentTime - PV.audFrom)) > 1.5) V.currentTime = PV.vidFrom + (A.currentTime - PV.audFrom);
    }
    const IMG = $('fpImg');
    if (!IMG.classList.contains('hidden') && PV.ownD) {
      const p = Math.min(1, ((T - sg.t0) % PV.ownD) / PV.ownD);
      IMG.style.transform = `scale(${IMG.dataset.kb === '1' ? 1.08 - 0.08 * p : 1 + 0.08 * p})`;
    }
  }
  const fill = $('fpFill'); if (fill) fill.style.width = `${Math.min(100, T / PV.plan.total * 100)}%`;
  $('fpTime').textContent = X.fmtH(T);
  const cue = PV.cues.find(q => T >= q.s && T < q.e);
  const cap = $('fpCap');
  if (cue) { cap.innerHTML = `<span style="color:${cue.color || '#fff'}">${cue.who ? X.esc(cue.who) + ': ' : ''}${X.esc(cue.words.map(w => w.w).join(' '))}</span>`; cap.classList.remove('hidden'); } else cap.classList.add('hidden');
  requestAnimationFrame(tick);
}

function togglePlay(play) {
  if (!PV) return;
  const want = play === undefined ? !PV.playing : play;
  if (want === PV.playing) return;
  if (!want) { PV.base = nowT(); PV.playing = false; stopAll(); $('fpPlay').textContent = 'Play'; return; }
  if (PV.base >= PV.plan.total - 0.1) { PV.playing = true; $('fpPlay').textContent = 'Pause'; seekTo(0); return; }
  PV.wall = performance.now(); PV.playing = true; $('fpPlay').textContent = 'Pause';
  playNow(PV.base - PV.plan.segs[PV.i].t0);
}

function closePreview() {
  if (!PV) return;
  PV.token++;
  stopAll();
  ['fpVideo', 'fpAudio'].forEach(id => { const el = $(id); el.removeAttribute('src'); el.dataset.src = ''; el.load(); });
  PV.urls.forEach(u => URL.revokeObjectURL(u));
  PV = null;
}

export function wireFinalPreview() {
  $('finPreview').addEventListener('click', previewFinal);
  $('fpClose').addEventListener('click', () => $('finDialog').close());
  $('finDialog').addEventListener('close', closePreview);
  $('fpPlay').addEventListener('click', () => togglePlay());
  $('fpBack').addEventListener('click', () => PV && seekTo(nowT() - 10));
  $('fpFwd').addEventListener('click', () => PV && seekTo(nowT() + 10));
  $('fpPrev').addEventListener('click', () => { if (!PV) return; const T = nowT(); const sg = PV.plan.segs[PV.i]; seekTo(T - sg.t0 > 2 || PV.i === 0 ? sg.t0 : PV.plan.segs[PV.i - 1].t0); });
  $('fpNext').addEventListener('click', () => { if (PV && PV.i < PV.plan.segs.length - 1) seekTo(PV.plan.segs[PV.i + 1].t0); });
  $('fpBar').addEventListener('click', e => { if (!PV) return; const r = e.currentTarget.getBoundingClientRect(); seekTo((e.clientX - r.left) / r.width * PV.plan.total); });
}
