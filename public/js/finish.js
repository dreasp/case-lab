// Final video (footage step 3): your recorded narration is matched to the narration parts,
// then the whole story is built at full quality from your original footage.

import { blurData } from './faces.js';
import { evenVolume } from './even-volume.js';
import { alignWords, buildCues, DEFAULT_STYLE } from './captions.js';
import { mediaUrl, mediaBlob, migrate, slots } from './media.js';
import { linesBetween, linesHtml, applyLineEdit } from './lines.js';
import { getWords, timeLines, DEFAULT_MUTE, muteMatcher, maskWord, swearsIn } from './words.js';

let X = null;
const $ = id => document.getElementById(id);
const WPS = 2.6;
const LEAD = 0.15, TAIL = 0.4;      // short pauses around each narration part
const NATIVE = /\.(mp4|mov|m4v)$/i;
// A file the export can read directly: named MP4/MOV and really an MP4/MOV inside. Some police
// systems (Hikvision and others) save files named .mp4 that are really another format; those
// are converted like WMV.
const direct = f => NATIVE.test(f.name) && !f.needsConvert;
async function isRealMp4(file) {
  try {
    const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    return ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'pnot'].includes(String.fromCharCode(...b.slice(4, 8)));
  } catch (e) { return false; }
}
const label = f => f ? (f.path || f.name) : 'missing file';
const fmt1 = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; };
const UNDER = { next: 'Lead-up to the next clip', prev: 'What comes after the last clip', still: 'Still frame of the next clip', black: 'Black screen' };
const IMG = /\.(jpe?g|png|webp|gif)$/i;

export function initFinish(helpers) {
  evenVolume(document.getElementById('fpAudio')); evenVolume(document.getElementById('fpVideo'));
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
  $('finFrame').addEventListener('change', async () => {
    const c = X.cur();
    if (!c || !c.isShort) return;
    c.frame = { mode: $('finFrame').value === 'fill' ? 'fill' : 'big' };
    await X.save();
  });
  $('finShortBack').addEventListener('click', () => { if (X.leaveShort) X.leaveShort(); });
  $('finCapY').addEventListener('input', () => { if (PV) placeCaptions(+$('finCapY').value); });
  ['finAspect', 'finCaps', 'finDuck', 'finMute', 'finMuteHow', 'finCapY'].forEach(id => $(id).addEventListener('change', async () => {
    const n = narr(); n.opts = { ...(n.opts || {}), aspect: $('finAspect').value, caps: $('finCaps').value, duck: +$('finDuck').value, mute: $('finMute').checked, muteHow: $('finMuteHow').value, capY: +$('finCapY').value };
    await X.save();
  }));
  $('finExport').addEventListener('click', exportVideo);
  $('finMuteList').value = muteList().join('\n');
  $('finMuteList').addEventListener('change', () => { try { localStorage.setItem('caselab-mute-list', JSON.stringify($('finMuteList').value.split(/\n+/).map(x => x.trim()).filter(Boolean))); } catch (e) { /* not saved */ } $('finMuteReport').innerHTML = ''; });
  $('finMuteReset').addEventListener('click', () => { try { localStorage.removeItem('caselab-mute-list'); } catch (e) { /* ignore */ } $('finMuteList').value = DEFAULT_MUTE.join('\n'); $('finMuteReport').innerHTML = ''; });
  $('finMuteCheck').addEventListener('click', checkSwears);
  wireWatermark();
  wireFinalPreview();
  $('finCancel').addEventListener('click', () => { if (worker) worker.postMessage({ type: 'cancel' }); });
  const a = $('narrAudio');
  a.addEventListener('timeupdate', () => { if (a.dataset.stop && a.currentTime >= +a.dataset.stop) { a.pause(); delete a.dataset.stop; } });
}

const narr = () => { const c = X.cur(); if (!c.narr) c.narr = {}; return c.narr; };
// (a Short keeps its own recording under its own key)
const narrKey = c => c.narrKey || `${c.id}:n:narration`;
// Forget cached audio when switching between the long video and a Short
export function resetFinish() { narrUrl = null; }
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
  try {
    const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'audio/mpeg' });
    await X.putFileSafe(narrKey(c), blob);
    narrUrl = null;
  } catch (e) {
    $('narrInfo').textContent = '';
    return alert(`The narration could not be saved: ${e.message}. If the file is in a synced folder (OneDrive, Google Drive), make it available offline or copy it to your Desktop, then try again.`);
  }
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
let alignMemo = { key: null, words: null };
function matchParts(c) {
  const n = c.narr || {};
  const parts = narrParts(c);
  if (!parts.length) return []; // footage only (a Short without an intro): nothing to match
  if (!n.words || !n.words.length) return null;
  const key = n.words.length + '|' + (n.at || 0) + '|' + parts.map(p => p.text).join('\u0001');
  if (alignMemo.key !== key) alignMemo = { key, words: alignWords(parts.map(p => p.text), n.words) };
  const words = alignMemo.words;
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
  $('finCaps').value = (o.caps || (c.isShort ? 'both' : 'footage'));
  $('finDuck').value = o.duck != null ? o.duck : 15;
  $('finDuckVal').textContent = $('finDuck').value + '%';
  $('finCapY').value = capYOf(c);
  $('finMute').checked = o.mute !== false;
  renderWatermark(o);
  $('finMuteHow').value = o.muteHow || 'silence';
  const parts = narrParts(c);
  if (!storySegs(c).length) {
    $('narrInfo').textContent = 'Build the story first (Story tab).';
    $('narrParts').innerHTML = '';
    $('finSummary').textContent = '';
    $('finExport').disabled = true;
    return;
  }
  const m = matchParts(c);
  $('finShortBar').classList.toggle('hidden', !c.isShort);
  if (c.isShort) $('finShortTitle').textContent = c.title;
  $('finAspect').disabled = !!c.isShort;
  if (c.isShort) $('finAspect').value = '9:16';
  $('finFrameRow').classList.toggle('hidden', !c.isShort);
  if (c.isShort) $('finFrame').value = (c.frame && c.frame.mode === 'fill') ? 'fill' : 'big';
  if (!parts.length) $('narrInfo').textContent = 'No intro to record: this Short is footage only. You can preview and export it straight away.';
  else $('narrInfo').textContent = n.name ? `${n.name} · ${X.fmtH(n.duration || 0)}${n.words ? '' : ' · not matched yet'}` : `No narration uploaded yet. Your story has ${parts.length} narration parts.`;
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
  $('finSummary').textContent = plan ? `The ${c.isShort ? 'Short' : 'video'} will be about ${X.fmtH(plan.total)} long: ${plan.clips} clip${plan.clips === 1 ? '' : 's'} from ${plan.files.size} file${plan.files.size === 1 ? '' : 's'}${parts.length ? ` and ${parts.length} narration part${parts.length === 1 ? '' : 's'}` : ''}.${plan.convert.size ? ` ${plan.convert.size} file${plan.convert.size === 1 ? '' : 's'} (like WMV) will have the needed parts converted first.` : ''}` : 'Upload your narration to continue.';
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
  const transOf = (s, k) => (k ? s.trans || (c.story && c.story.trans) || 'none' : 'none');
  const clipAt = (i, dir) => { for (let k = i + dir; k >= 0 && k < segs.length; k += dir) if (segs[k].type === 'clip' && X.fileById(segs[k].file)) return segs[k]; return null; };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.type === 'clip') {
      const f = X.fileById(s.file);
      if (!f) continue;
      const dur = Math.max(0.5, s.end - s.start);
      files.add(f.id); if (!direct(f) || f.type === 'audio') convert.add(f.id);
      const pic = (s.media || []).length ? { own: s.media } : f.type === 'video' ? { file: f, from: s.start } : { card: f.analysis && f.analysis.camera ? cap(f.analysis.camera) : 'Audio recording', sub: label(f) };
      out.push({ kind: 'clip', t0: t, dur, file: f, from: s.start, pic, sound: [{ file: f, from: s.start, gain: 1 }], seg: s, trans: transOf(s, out.length) });
      clips++;
      t += dur;
      continue;
    }
    if (s.type === 'media') {
      // your photos or videos on their own (a Short's start or end): photos 3.5 s, videos their chosen part or 5 s
      const own = s.media || [];
      if (!own.length) continue;
      const dur = own.reduce((d, it) => d + (it.kind === 'video' ? (it.len || 5) : 3.5), 0);
      out.push({ kind: 'media', t0: t, dur, pic: { own }, sound: [], seg: s, trans: transOf(s, out.length) });
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
      files.add(f.id); if (!direct(f) || f.type === 'audio') convert.add(f.id);
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
      files.add(f.id); if (!direct(f) || f.type === 'audio') convert.add(f.id);
      return true;
    };
    const still = () => {
      const k = next || prev;
      if (!k) return;
      const f = X.fileById(k.file);
      if (f.type !== 'video') { pic = { card: cap((f.analysis && f.analysis.camera) || 'Audio recording'), sub: label(f) }; return; }
      pic = { file: f, from: next ? next.start : Math.max(0, prev.end - 0.1), freeze: true };
      files.add(f.id); if (!direct(f)) convert.add(f.id);
    };
    const own = s.media || [];
    if (own.length) pic = { own };
    else if (mode === 'next' || mode === 'own') { if (!tryNext() && !tryPrev()) still(); }
    else if (mode === 'prev') { if (!tryPrev() && !tryNext()) still(); }
    else if (mode === 'still') still();
    const card = s.card && (s.card.date || s.card.place) ? s.card : null;
    out.push({ kind: 'narr', t0: t, dur, pic, sound, narr: { a0: m.a0, len, lead: LEAD }, match: m, seg: s, trans: transOf(s, out.length), card });
    t += dur;
  }
  return { segs: out, total: t, clips, files, convert };
}
const cap = s => String(s || '').replace(/^./, x => x.toUpperCase());
// Caption colors per speaker (readable on the dark caption box)
const SPEAKER_COLORS = ['#ffffff', '#ffd84d', '#7fdcff', '#9be89b', '#ff9fcf', '#ffb26b', '#c7a6ff'];
const NARR_COLOR = '#ff7a6b'; // coral: used only for your narration
function splitCue(q, max) {
  if (q.words.length <= max) return [q];
  const out = [];
  for (let i = 0; i < q.words.length; i += max) { const w = q.words.slice(i, i + max); out.push({ s: w[0].s, e: w[w.length - 1].e, words: w }); }
  out[out.length - 1].e = Math.max(out[out.length - 1].e, q.e);
  return out;
}

// ---------- captions ----------
async function captionCues(plan, mode, aspect, isSwear = null) {
  if (mode === 'off') return null;
  const style = { ...DEFAULT_STYLE[aspect] };
  const preset = style.preset;
  let all = [];
  if (mode === 'narr' || mode === 'both') {
    for (const sg of plan.segs.filter(x => x.kind === 'narr')) {
      const off = sg.t0 + LEAD - sg.match.a0;
      const words = sg.match.words.map(w => ({ w: w.w, p: 0, s: w.s + off, e: w.e + off }));
      // your narration has its own color, so it stands apart from the people in the footage
      all = all.concat(buildCues(words, preset).map(q => ({ ...q, color: NARR_COLOR })));
    }
  }
  if (mode === 'footage' || mode === 'both') {
    const colors = new Map(); // speaker name -> color, in the order they are first heard
    const colorOf = who => { if (!colors.has(who)) colors.set(who, SPEAKER_COLORS[colors.size % SPEAKER_COLORS.length]); return colors.get(who); };
    const c = X.cur();
    for (const sg of plan.segs.filter(x => x.kind === 'clip')) {
      const f = sg.file;
      const names = X.speakerMap(f);
      const timing = await getWords(c, f); // exact word times, so captions match the speech
      const utt = ((f.transcript && f.transcript.utterances) || []).filter(u => u.e > sg.from - 4 && u.s < sg.from + sg.dur + 4);
      const timed = timeLines(utt, timing); // all lines matched together, in order
      utt.forEach((u, ui) => {
        const words = [];
        for (const x of timed[ui]) {
          if (x.s >= sg.from - 0.05 && x.e <= sg.from + sg.dur + 0.3) words.push({ w: isSwear && isSwear(x.w) ? maskWord(x.w) : x.w, p: 0, s: sg.t0 + (x.s - sg.from), e: sg.t0 + Math.min(sg.dur, x.e - sg.from) });
        }
        if (!words.length) return;
        const who = names[u.sp] || 'Speaker ' + u.sp;
        // the speaker's name takes room on screen, so lines are a little shorter
        for (const q of buildCues(words, preset).flatMap(q => splitCue(q, preset === 'bold' ? 3 : 9))) { q.who = who; q.color = colorOf(who); q.fid = f.id; all.push(q); }
      });
    }
  }
  all.sort((a, b) => a.s - b.s);
  for (let i = 0; i < all.length - 1; i++) if (all[i].e > all[i + 1].s) all[i].e = all[i + 1].s;
  return { cues: all.filter(x => x.e > x.s), style };
}

// ---------- watermark: your logo, saved once and used for every case ----------
const WM_KEY = 'pglobal:logo:wm';
let logoBlob, logoUrl = null;
const WM_DEFAULT = { size: 0.14, opacity: 0.65, move: 'move', every: 180 };
const wmSettings = () => {
  let w = { ...WM_DEFAULT };
  try { w = { ...w, ...JSON.parse(localStorage.getItem('caselab-watermark') || '{}') }; } catch (e) { /* defaults */ }
  if (w.size < 0.08) w.size = 0.14; // the old "small" was too small
  return w;
};
async function getLogo() {
  if (logoBlob === undefined) logoBlob = (await X.getFile(WM_KEY).catch(() => null)) || null;
  if (logoBlob && !logoUrl) logoUrl = URL.createObjectURL(logoBlob);
  return logoBlob;
}
async function renderWatermark(o) {
  const w = wmSettings();
  $('wmSize').value = Math.round(w.size * 100);
  $('wmSizeVal').textContent = $('wmSize').value + '%';
  $('wmEvery').value = String(w.every || 180);
  $('wmEveryBox').classList.toggle('hidden', w.move !== 'move');
  $('wmOpacity').value = Math.round(w.opacity * 100);
  $('wmOpVal').textContent = $('wmOpacity').value + '%';
  $('wmMove').value = w.move;
  const logo = await getLogo();
  $('wmOn').checked = !!logo && (o || {}).wm !== false;
  $('wmOn').disabled = !logo;
  $('wmThumb').classList.toggle('hidden', !logo);
  if (logo) $('wmThumb').src = logoUrl;
  $('wmUpLabel').textContent = logo ? 'Change logo' : 'Upload logo';
}
function wireWatermark() {
  const saveW = () => {
    const w = { size: +$('wmSize').value / 100, opacity: +$('wmOpacity').value / 100, move: $('wmMove').value, every: +$('wmEvery').value };
    try { localStorage.setItem('caselab-watermark', JSON.stringify(w)); } catch (e) { /* not saved */ }
    $('wmEveryBox').classList.toggle('hidden', w.move !== 'move');
    if (PV && PV.wm) PV.wm = w; // an open preview follows the change straight away
  };
  $('wmOpacity').addEventListener('input', () => { $('wmOpVal').textContent = $('wmOpacity').value + '%'; saveW(); });
  $('wmSize').addEventListener('input', () => { $('wmSizeVal').textContent = $('wmSize').value + '%'; saveW(); });
  ['wmMove', 'wmEvery'].forEach(id => $(id).addEventListener('change', saveW));
  $('wmOn').addEventListener('change', async () => { const n = narr(); n.opts = { ...(n.opts || {}), wm: $('wmOn').checked }; await X.save(); });
  $('wmFile').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'image/png' });
      await createImageBitmap(blob); // make sure it's a picture the browser can read
      await X.putFileSafe(WM_KEY, blob);
      logoBlob = blob; if (logoUrl) URL.revokeObjectURL(logoUrl); logoUrl = null;
      const n = narr(); n.opts = { ...(n.opts || {}), wm: true }; await X.save();
      renderFinish();
    } catch (err) { alert('This logo could not be used: ' + err.message + '. Use a PNG (best with a see-through background), JPG or WEBP.'); }
  });
}
async function watermarkJob(opts) {
  if (opts.wm === false) return null;
  const logo = await getLogo();
  if (!logo) return null;
  return { img: await createImageBitmap(logo), ...wmSettings() };
}

// ---------- swear words ----------
function muteList() {
  try { const l = JSON.parse(localStorage.getItem('caselab-mute-list') || 'null'); if (Array.isArray(l) && l.length) return l; } catch (e) { /* standard list */ }
  return DEFAULT_MUTE;
}

// For every piece of footage sound in the video: the swear words in it, as { a, b } seconds from
// the start of that piece, plus where they are in the finished video (for the check list)
async function planSwears(c, plan, isSwear) {
  const out = [];
  for (const sg of plan.segs) {
    const per = [];
    for (const s of sg.sound) {
      const f = s.file;
      if (!f || !f.transcript) { per.push([]); continue; }
      const words = await getWords(c, f);
      const found = swearsIn(words, f.transcript.utterances, s.from, s.from + sg.dur, isSwear);
      per.push(found.map(x => ({ a: Math.max(0, x.s - s.from), b: Math.min(sg.dur, x.e - s.from), w: x.w, at: sg.t0 + Math.max(0, x.s - s.from), file: f, under: sg.kind !== 'clip' })).filter(r => r.b > r.a));
    }
    out.push(per);
  }
  return out;
}

async function checkSwears() {
  const c = X.cur();
  const m = matchParts(c);
  if (!m) return alert('Upload your narration first, so the app knows the order and timing of the video.');
  const box = $('finMuteReport');
  box.innerHTML = '<div class="story-note muted">Checking every clip…</div>';
  const plan = buildPlan(c, m);
  const all = (await planSwears(c, plan, muteMatcher(muteList()))).flat(2).sort((a, b) => a.at - b.at);
  if (!all.length) { box.innerHTML = '<div class="story-note">No words from your list were found in the footage that is used.</div>'; return; }
  const counts = {};
  all.forEach(x => { const k = maskWord(x.w.toLowerCase().replace(/[^a-z']/g, '')); counts[k] = (counts[k] || 0) + 1; });
  box.innerHTML = `<div class="story-note"><strong>${all.length} word${all.length > 1 ? 's' : ''} will be ${$('finMuteHow').value === 'bleep' ? 'bleeped' : 'silenced'}</strong> (${Object.entries(counts).map(([w, n]) => `${X.esc(w)} ×${n}`).join(', ')}).
    ${$('finMute').checked ? '' : '<br><strong>"Silence swear words" is switched off</strong>, so right now they would be heard.'}
    <ul class="mute-found">${all.map(x => `<li><span class="mono">${X.fmtH(x.at)}</span> ${X.esc(maskWord(x.w))} <span class="muted">· ${X.esc(label(x.file))}${x.under ? ' (quietly, under your narration)' : ''}</span></li>`).join('')}</ul>
    <span class="muted small-text">If one is missed, it was probably transcribed as a different word: fix it with "Edit lines" on the Story tab and it will be caught. To silence other words too, add them to your list.</span></div>`;
}

// Originals the app couldn't find: one "Find it" button each (picking a file needs a click)
function showMissing(list) {
  $('finResult').innerHTML = `<div class="story-note"><strong>The app can't find ${list.length === 1 ? 'this original' : 'these originals'} on your computer:</strong>
    <ul class="missing-list">${list.map(f => `<li><span>${X.esc(label(f))}</span> <button class="btn small" type="button" data-find="${f.id}">Find it</button></li>`).join('')}</ul>
    <span class="muted small-text">This happens when a file was added with "Add files" in an earlier session, was moved, or is on a drive that isn't plugged in. Plug in the drive if needed, click "Find it" and pick the same file: the app remembers it from then on. Then click "Export video" again.</span></div>`;
  $('finResult').querySelectorAll('[data-find]').forEach(b => b.addEventListener('click', async () => {
    const f = X.fileById(b.dataset.find);
    if (f && await X.linkOriginal(f)) { b.replaceWith(Object.assign(document.createElement('span'), { className: 'np-ok small-text', textContent: 'Found' })); }
  }));
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
  // videos need their originals: find out now, before asking where to save
  {
    const plan0 = buildPlan(c, m);
    const missing = [];
    for (const fid of plan0.files) {
      const f = X.fileById(fid);
      if (f && f.type === 'video' && !(await X.getLocalFile(f).catch(() => null))) missing.push(f);
    }
    if (missing.length) { showMissing(missing); return; }
  }
  let fileHandle = null;
  if (window.showSaveFilePicker) {
    try {
      fileHandle = await window.showSaveFilePicker({ suggestedName: `${c.title.replace(/[^\w\s()-]/g, '').trim() || 'case'}.mp4`, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
    } catch (e) { if (e.name === 'AbortError') return; fileHandle = null; }
  }
  if (!fileHandle) return alert('Your browser can\'t save large files directly. Please use an up-to-date Chrome on a computer.');

  const opts = (c.narr && c.narr.opts) || {};
  const aspect = c.isShort ? '9:16' : opts.aspect || '16:9';
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
    // find every original first, so all missing files can be shown at once
    const found = new Map(), missing = [];
    let usedCloud = [];
    for (const fid of used.keys()) {
      const f = X.fileById(fid);
      let file = await X.getLocalFile(f).catch(() => null);
      if (!file && f.type === 'audio' && f.audioKey) {
        // a recording (911 call, phone call): the copy saved in the cloud during analysis is fine
        progress(0, `Downloading the saved copy of "${label(f)}"…`);
        const [u] = await X.signedUrls([f.audioKey]);
        const r = u ? await fetch(u).catch(() => null) : null;
        if (r && r.ok) { file = new File([await r.blob()], f.name.replace(/\.[^.]+$/, '') + '.m4a', { type: 'audio/mp4' }); usedCloud.push(label(f)); }
      }
      if (file) found.set(fid, file); else missing.push(f);
    }
    if (missing.length) { showMissing(missing); throw new Error('MISSING'); }
    for (const [fid, ranges] of used) {
      const f = X.fileById(fid);
      const file = found.get(fid);
      if (direct(f) && f.type === 'video' && !(await isRealMp4(file))) { f.needsConvert = true; await X.save(); }
      if (direct(f) && f.type === 'video') {
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
    let pcm = new Float32Array(0);
    if (narrParts(c).length) {
      const nb = await X.getFile(narrKey(c));
      if (!nb) throw new Error('The narration audio is not on this computer or in the cloud. Upload it again.');
      const ab = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await nb.arrayBuffer());
      pcm = new Float32Array(ab.length);
      for (let ch = 0; ch < ab.numberOfChannels; ch++) { const d = ab.getChannelData(ch); for (let i = 0; i < d.length; i++) pcm[i] += d[i] / ab.numberOfChannels; }
    }
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
    const mutes = opts.mute !== false ? await planSwears(c, plan, muteMatcher(muteList())) : null;
    const withMute = (si, list) => list.map((x, k) => (mutes && mutes[si][k] && mutes[si][k].length && x.sid && !String(x.sid).startsWith('own:') ? { ...x, mute: mutes[si][k].map(r => [r.a, r.b]) } : x));
    const segs = plan.segs.map((sg, si) => {
      if (sg.pic && sg.pic.own) {
        const sl = slots(sg.pic.own, sg.dur);
        const items = sg.pic.own.slice(0, sl.length);
        const pics = items.map((it, k) => ({ t: sl[k].t, dur: sl[k].d, pic: it.kind === 'photo' ? { img: 'own:' + it.id, kb: k % 2 } : { sid: 'own:' + it.id, from: it.from || 0, until: it.len ? (it.from || 0) + it.len : null } }));
        const sound = sg.kind === 'clip'
          ? withMute(si, sg.sound.map(s => { const w = where(s.file, s.from); return { sid: w.sid, from: w.from, gain: s.gain }; }))
          : items.map((it, k) => it.kind === 'video' && !it.muted ? { sid: 'own:' + it.id, from: it.from || 0, gain: sg.kind === 'media' ? 1 : duckGain, at: sl[k].t, len: it.len ? Math.min(it.len, sl[k].d) : sl[k].d } : null).filter(Boolean);
        return { t0: sg.t0, dur: sg.dur, pic: null, pics, sound, narr: sg.narr || null };
      }
      let pic = null;
      if (sg.pic && sg.pic.file) { const w = where(sg.pic.file, sg.pic.from); pic = { sid: w.sid, from: w.from, freeze: !!sg.pic.freeze, faces: blurData(sg.pic.file), fofs: sg.pic.from - w.from }; }
      else if (sg.pic && sg.pic.card) pic = { card: sg.pic.card, sub: sg.pic.sub };
      const sound = withMute(si, sg.sound.map(s => { const w = where(s.file, s.from); return { sid: w.sid, from: w.from, gain: s.gain }; }));
      return { t0: sg.t0, dur: sg.dur, pic, sound, narr: sg.narr || null };
    });
    const job = {
      // a Short is built in memory (small), so the finished file starts with its index the way
      // Instagram and YouTube want it, and it can be kept in the cloud for posting
      aspect, bitrate: c.isShort ? 8_000_000 : aspect === '9:16' ? 10_000_000 : 12_000_000,
      sources, segs, narration: pcm, narrGain, fileHandle: c.isShort ? null : fileHandle,
      captions: await captionCues(plan, (opts.caps || (c.isShort ? 'both' : 'footage')), aspect, opts.mute !== false ? muteMatcher(muteList()) : null),
      watermark: await watermarkJob(opts),
      muteHow: opts.muteHow || 'silence',
      cuts: plan.segs.map(sg => ({ T: sg.t0, kind: sg.trans || 'none' })),
      cards: plan.segs.filter(sg => sg.card).map(sg => ({ t0: sg.t0 + (sg.card.at || 0), card: sg.card })),
      frame: c.isShort ? shortFrame(c) : null,
      capY: capYOf(c),
      hook: c.isShort && (c.hook || '').trim() ? { text: c.hook.trim(), dur: 4 } : null,
    };
    // a Short with the big picture: captions go under the picture
    if (job.captions && job.captions.style) job.captions.style.y = job.capY;
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
      worker.postMessage({ type: 'start', job }, [pcm.buffer, ...(job.watermark ? [job.watermark.img] : [])]);
    });
    let kept = '';
    if (c.isShort && res.blob) {
      progress(1, 'Saving the file…');
      const w = await fileHandle.createWritable(); await w.write(res.blob); await w.close();
      kept = await keepShort(c, res, progress);
    }
    progress(1, 'Done');
    $('finResult').innerHTML = `<div class="story-note"><strong>Your video is saved</strong> as "${X.esc(fileHandle.name)}" (${X.fmtH(res.duration)} long, built in ${X.fmtH(res.seconds)}).${kept}${usedCloud.length ? `<br><span class="muted small-text">The original of ${usedCloud.map(x => `"${X.esc(x)}"`).join(', ')} wasn't on this computer, so the copy saved in the cloud was used (same sound).</span>` : ''}${res.problems.length ? `<br><br><strong>Some parts had problems:</strong><ul>${res.problems.map(p => `<li>${X.esc(p)}</li>`).join('')}</ul>` : ''}</div>`;
  } catch (e) {
    if (e.message !== 'MISSING') $('finResult').innerHTML = `<div class="story-note"><strong>${/cancel/i.test(e.message) ? 'Export cancelled' : 'The export stopped'}</strong>${/cancel/i.test(e.message) ? '' : ': ' + X.esc(e.message)}</div>`;
  } finally {
    if (worker) { worker.terminate(); worker = null; }
    $('finCancel').classList.add('hidden');
    $('finProgress').classList.add('hidden');
    renderFinish();
  }
}

// Keeps the exported Short in the cloud, so it can be posted from the Shorts tab (or downloaded on the phone)
async function keepShort(c, res, progress) {
  const sh = c.short;
  if (!sh) return '';
  try {
    const key = `${c.id}:s:${sh.id}`;
    const { url } = await X.api('cloud/file-url', { key, method: 'PUT' });
    await new Promise((ok, bad) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      x.upload.onprogress = e => { if (e.lengthComputable) progress(1, `Keeping a copy in the cloud for posting (${Math.round(e.loaded / e.total * 100)}%)…`); };
      x.onload = () => (x.status < 300 ? ok() : bad(new Error(`upload failed (${x.status})`)));
      x.onerror = () => bad(new Error('upload failed'));
      x.send(res.blob);
    });
    sh.video = { at: Date.now(), size: res.blob.size, duration: res.duration };
    await X.save();
    return '<br>A copy is kept in the cloud: go back to the Shorts tab to post it or schedule it.';
  } catch (e) {
    return `<br><span class="muted small-text">The copy for posting could not be saved in the cloud (${X.esc(e.message)}). Export again to post from the app.</span>`;
  }
}

// ---------- preview: the whole video with your real narration, before exporting ----------
let PV = null;
const PLAYABLE_AUDIO = /\.(mp3|wav|m4a|aac|ogg)$/i;

// What the preview plays for a file: the original if it's linked and plays in Chrome, otherwise
// the analysis copies in the cloud. When those were removed ("Free cloud space"), the part a..b
// of the linked original is converted for the preview (offset = where that part starts).
async function previewMedia(f, a = null, b = null) {
  if (PV.media.has(f.id)) return PV.media.get(f.id);
  const rk = f.id + ':' + a + ':' + b;
  if (PV.media.has(rk)) return PV.media.get(rk);
  let m = null;
  const local = async () => {
    const file = await X.getLocalFile(f);
    if (f.type === 'video' && !(await isRealMp4(file))) { f.needsConvert = true; X.save(); throw new Error('not MP4 inside'); }
    const u = URL.createObjectURL(file); PV.urls.push(u); return u;
  };
  if (f.type === 'video' && direct(f)) { try { m = { video: await local(), audio: null, note: '' }; } catch (e) { /* copies below */ } }
  if (!m && f.type === 'audio' && PLAYABLE_AUDIO.test(f.name)) { try { m = { video: null, audio: await local(), note: '' }; } catch (e) { /* below */ } }
  if (!m && (f.type === 'video' ? f.proxyKey : f.audioKey)) {
    const [v, au] = await X.signedUrls([f.type === 'video' ? f.proxyKey : null, f.audioKey]);
    if (v || au) m = { video: f.type === 'video' ? v : null, audio: au || null, note: f.type === 'video' ? 'This part shows the analysis copy (1 frame a second) with the real sound. The exported video uses your original footage.' : '' };
  }
  if (!m && a != null) {
    // no copies in the cloud: convert just this part of the original, if it's linked here
    let why = '';
    const file = await X.getLocalFile(f).catch(e => { why = e.message || ''; return null; });
    if (file) {
      const start = Math.max(0, a - 1), len = Math.min(240, (b || a + 30) - start + 1);
      $('fpNote').textContent = `Preparing this part of "${label(f)}" for the preview… (its analysis copy was removed from the cloud)`;
      PV.preparing = true; // the clock waits meanwhile
      try {
        const { convertRange } = await import('./convert.js');
        const blob = await convertRange(file, start, len, { video: f.type === 'video', onProgress: p => { if (PV) $('fpNote').textContent = `Preparing this part of "${label(f)}" for the preview… ${Math.round(p * 100)}%`; } });
        const u = URL.createObjectURL(blob); PV.urls.push(u);
        m = f.type === 'video' ? { video: u, audio: null, offset: start, note: '' } : { video: null, audio: u, offset: start, note: '' };
        PV.media.set(rk, m);
        return m;
      } catch (e) { m = { video: null, audio: null, note: `This part could not be prepared: ${e.message}` }; PV.media.set(rk, m); return m; }
      finally { if (PV) PV.preparing = false; }
    }
    m = { video: null, audio: null, missing: true, note: `"${label(f)}" can't be shown: its analysis copy was removed from the cloud ("Free cloud space") and the original couldn't be opened${why ? ` (${why})` : ''}. If Chrome asked to allow access to your files, click Allow and open the preview again; otherwise link it on the Files tab (Choose case folder, or Find it).` };
    PV.media.set(rk, m);
    return m;
  }
  if (!m) m = { video: null, audio: null, missing: true, note: `"${label(f)}" can't be shown here: link the original on the Files tab.` };
  PV.media.set(f.id, m);
  return m;
}

async function previewFinal() {
  const c = X.cur();
  const m = matchParts(c);
  if (!m) return alert('Upload your narration first.');
  const opts = (c.narr && c.narr.opts) || {};
  const plan = buildPlan(c, m);
  // Chrome's OK to read your original files has to be asked right after the click
  if (X.ensureRead) await X.ensureRead([...plan.files].map(id => X.fileById(id)).filter(Boolean));
  const isSwear = opts.mute !== false ? muteMatcher(muteList()) : null;
  const tall = !!c.isShort;
  const caps = await captionCues(plan, (opts.caps || (c.isShort ? 'both' : 'footage')), '16:9', isSwear);
  let nurl = '';
  if (narrParts(c).length) { try { nurl = await narrSrc(); } catch (e) { return alert(e.message); } }
  $('fpStage').classList.toggle('tall', tall);
  const mutes = isSwear ? await planSwears(c, plan, isSwear) : null;
  const logo = opts.wm !== false ? await getLogo() : null;
  $('fpWm').classList.toggle('hidden', !logo);
  if (logo) $('fpWm').src = logoUrl;
  PV = { wm: logo ? wmSettings() : null, plan, capMode: (opts.caps || (c.isShort ? 'both' : 'footage')), isSwear, cues: caps ? caps.cues : [], mutes, i: -1, token: 0, playing: true, base: 0, wall: performance.now(), media: new Map(), faces: new Map(plan.segs.filter(sg => sg.pic && sg.pic.file && blurData(sg.pic.file)).map(sg => [sg.pic.file.id, blurData(sg.pic.file)])), cut: null, frame: tall ? shortFrame(c) : null, hook: tall && (c.hook || '').trim() ? c.hook.trim() : '', urls: [], duck: (opts.duck != null ? opts.duck : 15) / 100 };
  if (nurl) $('fpNarr').src = nurl; else $('fpNarr').removeAttribute('src');
  placeCaptions(capYOf(c));
  $('fpTotal').textContent = X.fmtH(plan.total);
  $('fpBar').innerHTML = '<div id="fpFill"></div>' + plan.segs.slice(1).map(sg => `<i style="left:${sg.t0 / plan.total * 100}%"></i>`).join('');
  $('fpPlay').textContent = 'Pause';
  $('finDialog').showModal();
  await seekTo(0);
  requestAnimationFrame(tick);
}

// ---------- effects in the preview: blurred faces, transitions, date and place card ----------
// Drawn on a layer over the video with the same drawing code as the export.
const snapCanvas = document.createElement('canvas');
function fxSize() {
  const c = $('fpFx'), r = $('fpStage').getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(2, Math.round(r.width * d)), H = Math.max(2, Math.round(r.height * d));
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  return [W, H];
}
const modeFor = (w, h, W, H) => { if (PV && PV.frame) return PV.frame; const r = (w / h) / (W / H); return { mode: r < 0.9 || r > 1.11 ? 'fit' : 'fill' }; };
// How footage fills a tall Short: a big picture over a blurred copy (recommended), or cropped to fill
// Where the captions sit (share of the height, measured to their middle)
export function capYOf(c) {
  const o = (c.narr && c.narr.opts) || {};
  return o.capY || (c.isShort ? 0.75 : o.aspect === '9:16' ? 0.66 : 0.88);
}
function placeCaptions(y) {
  const el = $('fpCap');
  el.style.top = (y * 100) + '%'; el.style.bottom = 'auto'; el.style.transform = 'translateY(-50%)';
}
export function shortFrame(c) {
  const f = c.frame || {};
  return f.mode === 'fill' ? { mode: 'fill', x: f.x == null ? 0.5 : f.x } : { mode: 'fit', zoom: 1.35, y: 0.4, big: true };
}
// Draws the picture that is showing now (with faces blurred), for blurring and transitions
function drawPicture(x, W, H, withBlur) {
  const V = $('fpVideo'), IMG = $('fpImg');
  x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
  if (!V.classList.contains('hidden') && V.videoWidth) {
    const fr = modeFor(V.videoWidth, V.videoHeight, W, H);
    CaseDraw.drawMedia(x, V, W, H, fr, 1, true);
    const sg = PV.plan.segs[PV.i];
    const faces = withBlur && sg && sg.pic && sg.pic.file ? PV.faces.get(sg.pic.file.id) : null;
    if (faces) CaseDraw.blurBoxes(x, CaseDraw.mediaRect(V, W, H, fr, 1, true), CaseDraw.faceBoxesAt(faces, V.currentTime + (PV.vidOffset || 0)));
    return true;
  }
  if (!IMG.classList.contains('hidden') && IMG.naturalWidth) {
    // keep the slow zoom on photos (the same as the export)
    const z = +((IMG.style.transform || '').match(/scale\(([\d.]+)\)/) || [])[1] || 1;
    CaseDraw.drawMedia(x, IMG, W, H, { mode: 'auto' }, z, false);
    return true;
  }
  return false;
}
function snapshotNow() {
  const [W, H] = fxSize();
  snapCanvas.width = W; snapCanvas.height = H;
  if (!drawPicture(snapCanvas.getContext('2d'), W, H, true)) return null;
  return snapCanvas;
}
function drawFx(T) {
  const [W, H] = fxSize();
  const x = $('fpFx').getContext('2d');
  x.clearRect(0, 0, W, H);
  const segs = PV.plan.segs, sg = segs[PV.i];
  if (!sg) return;
  const into = T - sg.t0;
  if ((sg.pic && sg.pic.file && PV.faces.get(sg.pic.file.id)) || PV.frame) drawPicture(x, W, H, true);
  if (PV.cut) {
    const dt = T - PV.cut.T;
    if (dt > (CaseDraw.TRANSITIONS[PV.cut.kind] || {}).d || dt < -0.2) PV.cut = null;
    else CaseDraw.drawTransition(x, W, H, PV.cut.kind, Math.max(0, dt), PV.cut.snap);
  }
  const next = segs[PV.i + 1];
  if (next && next.trans === 'black' && next.t0 - T <= CaseDraw.TRANSITIONS.black.d / 2 && next.t0 > T) CaseDraw.drawTransition(x, W, H, 'black', T - next.t0, null);
  if (sg.card) { const a = sg.card.at || 0; if (into >= a && into < a + (sg.card.dur || 6)) CaseDraw.drawInfoCard(x, W, H, sg.card, into - a); }
  if (PV.hook && T < 4) CaseDraw.drawHook(x, W, H, PV.hook, T, 4);
  // soft fade out at the very end (as in the export)
  const fo = Math.min(1.2, PV.plan.total / 4);
  if (T > PV.plan.total - fo) { x.save(); x.globalAlpha = Math.min(1, (T - (PV.plan.total - fo)) / fo); x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.restore(); }
}

const nowT = () => PV.playing ? PV.base + (performance.now() - PV.wall) / 1000 : PV.base;
const segAt = T => { const s = PV.plan.segs; let i = s.findIndex(x => T < x.t0 + x.dur); return i < 0 ? s.length - 1 : i; };

async function seekTo(T) {
  if (!PV) return;
  T = Math.max(0, Math.min(PV.plan.total - 0.05, T));
  PV.base = T; PV.wall = performance.now();
  PV.cut = null;
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
  PV.i = i; PV.narrStarted = false; PV.ownK = -1; PV.freeze = false; PV.vidEnd = null; PV.ownSl = null; PV.ownT = 0;
  const V = $('fpVideo'), A = $('fpAudio'), N = $('fpNarr'), IMG = $('fpImg'), CARD = $('fpCard');
  const nIdx = PV.plan.segs.slice(0, i + 1).filter(x => x.kind === 'narr').length;
  $('fpMeta').textContent = `${i + 1} of ${PV.plan.segs.length} · ${sg.kind === 'clip' ? 'clip' : sg.kind === 'media' ? 'your photos/videos' : 'narration ' + nIdx}`;
  $('fpTitle').textContent = sg.kind === 'clip' ? `${sg.seg.label || 'Clip'} · ${label(sg.file)}` : sg.kind === 'media' ? 'Your photos and videos' : `Narration ${nIdx}`;
  $('fpNote').textContent = '';
  V.classList.remove('hidden'); IMG.classList.add('hidden'); CARD.classList.add('hidden');
  A.removeAttribute('src'); A.dataset.src = '';
  const gain = sg.kind === 'clip' ? 1 : PV.duck;
  const pic = sg.pic;
  PV.vidFrom = null; PV.audFrom = null;
  if (pic && pic.own) {
    const sl = slots(pic.own, sg.dur);
    let k = sl.findIndex(x => into < x.t + x.d); if (k < 0) k = sl.length - 1;
    PV.ownK = k; PV.ownSl = sl; PV.ownD = sl[k].d; PV.ownT = sl[k].t;
    const it = pic.own[k];
    PV.vidEnd = it.kind === 'video' && it.len ? (it.from || 0) + it.len : null;
    const u = await mediaUrl(it).catch(() => null);
    if (token !== PV.token) return;
    if (it.kind === 'photo') { V.classList.add('hidden'); IMG.src = u || ''; IMG.classList.remove('hidden'); IMG.dataset.kb = k % 2; }
    else { if (V.dataset.src !== u) { V.src = u || ''; V.dataset.src = u || ''; } V.muted = sg.kind === 'clip' || !!it.muted; V.volume = sg.kind === 'media' ? 1 : PV.duck; PV.vidFrom = (it.from || 0) - sl[k].t; }
    if (sg.kind === 'clip' && sg.sound[0]) {
      const md = await previewMedia(sg.sound[0].file);
      if (token !== PV.token) return;
      const su = md.audio || md.video;
      if (su) { A.src = su; A.dataset.src = su; A.volume = 1; PV.audFrom = sg.sound[0].from - (sg.t0 - sg.t0); }
    }
  } else if (pic && pic.file) {
    const md = await previewMedia(pic.file, pic.from, pic.from + (pic.freeze ? 1 : sg.dur));
    if (token !== PV.token) return;
    $('fpNote').textContent = md.note;
    if (md.video) { if (V.dataset.src !== md.video) { V.src = md.video; V.dataset.src = md.video; } }
    PV.freeze = !!pic.freeze;
    V.muted = PV.freeze || !!md.audio;
    V.volume = Math.min(1, gain);
    PV.vidOffset = md.offset || 0;
    // nothing to show: let the clock run on its own instead of waiting for it
    PV.vidFrom = md.video ? pic.from - PV.vidOffset : null;
    if (!md.video) V.classList.add('hidden');
    if (md.audio && !PV.freeze && sg.sound.length) { A.src = md.audio; A.dataset.src = md.audio; A.volume = Math.min(1, gain); PV.audFrom = sg.sound[0].from - (md.offset || 0); }
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
  if (!PV || token !== PV.token) return; // the preview was closed meanwhile
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

// The preview follows the sound you hear: the clock is taken from whichever recording is
// playing, and holds while it is still loading, so captions never run ahead of the speech.
function syncClock() {
  if (PV.preparing) { PV.wall = performance.now(); return; }
  const sg = PV.plan.segs[PV.i];
  if (!sg || !PV.playing) return;
  const A = $('fpAudio'), V = $('fpVideo'), N = $('fpNarr');
  const now = performance.now();
  const into = PV.base + (now - PV.wall) / 1000 - sg.t0;
  let el = null, from = 0;
  if (PV.audFrom != null) { el = A; from = PV.audFrom; }
  else if (PV.vidFrom != null && !PV.freeze && !V.muted && !(PV.vidEnd != null && V.currentTime >= PV.vidEnd - 0.05)) { el = V; from = PV.vidFrom; }
  else if (sg.narr && into >= sg.narr.lead && into < sg.narr.lead + sg.narr.len) { el = N; from = sg.narr.a0 - sg.narr.lead; }
  if (!el) return; // photos only, or a still frame: the plain clock is fine
  if (el.ended) return; // the recording ran out before the scene did: keep going on the plain clock
  if (el.error) { // this recording couldn't be loaded: say so, and carry on without it
    if (!PV.loadNoted) { PV.loadNoted = true; $('fpNote').textContent = `The ${el === V ? 'footage' : el === N ? 'narration' : 'sound'} for this part could not be loaded (${el.error.message || 'error ' + el.error.code}). ${PV.full ? 'Chrome is out of space on this computer: see the message about storage.' : 'Check your internet connection and try again.'}`; }
    return;
  }
  if (el.paused || el.readyState < 3 || el.seeking) {
    if (el === N && !PV.narrStarted) return; // narration starts after a short pause
    PV.wall = now; // hold the clock until the sound is really playing
    if (!PV.waitSince) PV.waitSince = now;
    if (now - PV.waitSince > 10000 && !PV.loadNoted) {
      PV.loadNoted = true;
      // what each player is doing, so the problem can be found
      const st = (name, x) => x.getAttribute('src') ? `${name}: ${String(x.currentSrc || x.src).startsWith('blob:') ? 'your file' : 'cloud copy'}, ready ${x.readyState}/4, network ${x.networkState}${x.error ? ', error ' + x.error.code + ' ' + (x.error.message || '') : ''}${x.paused ? ', paused' : ''}${x.hasAttribute('crossorigin') ? '' : ', plain'}` : '';
      const info = [st('picture', V), st('sound', A)].filter(Boolean).join(' · ');
      console.warn('Preview waiting:', info);
      $('fpNote').textContent = `Still loading this part… (${info})`;
    }
    return;
  }
  PV.waitSince = 0;
  if (PV.loadNoted) { PV.loadNoted = false; }
  const t = sg.t0 + (el.currentTime - from);
  if (isFinite(t) && t >= sg.t0 - 0.5) { PV.base = t; PV.wall = now; }
}

function tick() {
  if (!PV) return;
  syncClock();
  const T = nowT();
  const segs = PV.plan.segs;
  const sg = segs[PV.i];
  if (sg && PV.playing) {
    const into = T - sg.t0;
    if (T >= PV.plan.total) { togglePlay(false); PV.base = PV.plan.total; }
    else if (into >= sg.dur && PV.i < segs.length - 1) {
      const nx = segs[PV.i + 1];
      PV.cut = nx.trans && nx.trans !== 'none' ? { kind: nx.trans, T: nx.t0, snap: nx.trans === 'black' ? null : snapshotNow() } : null;
      loadSeg(PV.i + 1, T - nx.t0);
    }
    else if (sg.pic && sg.pic.own && PV.ownSl && (into >= PV.ownT + PV.ownD || into < PV.ownT) && PV.ownK < PV.ownSl.length - 1) { loadSeg(PV.i, into); }
    else {
      if (sg.narr && !PV.narrStarted && into >= sg.narr.lead) { $('fpNarr').play().catch(() => {}); PV.narrStarted = true; }
      if (sg.narr && into >= sg.narr.lead + sg.narr.len) $('fpNarr').pause();
      // keep the 1-frame-a-second picture in step with the sound
      const V = $('fpVideo'), A = $('fpAudio');
      if (PV.vidEnd != null && V.currentTime >= PV.vidEnd) { if (!V.paused) V.pause(); }
      else if (PV.audFrom != null && PV.vidFrom != null && !PV.freeze && Math.abs((V.currentTime - PV.vidFrom) - (A.currentTime - PV.audFrom)) > 1.5) V.currentTime = PV.vidFrom + (A.currentTime - PV.audFrom);
    }
    // swear words: turn the footage sound off while one is said
    const ranges = PV.mutes && PV.mutes[PV.i] && PV.mutes[PV.i][0];
    if (ranges && ranges.length) {
      const into = T - sg.t0;
      const quiet = ranges.some(r => into >= r.a && into < r.b);
      const el = PV.audFrom != null ? $('fpAudio') : (!$('fpVideo').muted ? $('fpVideo') : null);
      const gain = sg.kind === 'clip' ? 1 : PV.duck;
      if (el) el.volume = quiet ? 0 : Math.min(1, gain);
    }
    const IMG = $('fpImg');
    if (!IMG.classList.contains('hidden') && PV.ownD) {
      const p = Math.min(1, Math.max(0, (T - sg.t0 - (PV.ownT || 0)) / PV.ownD));
      IMG.style.transform = `scale(${IMG.dataset.kb === '1' ? 1.08 - 0.08 * p : 1 + 0.08 * p})`;
    }
  }
  const fill = $('fpFill'); if (fill) fill.style.width = `${Math.min(100, T / PV.plan.total * 100)}%`;
  $('fpTime').textContent = X.fmtH(T);
  drawFx(T);
  const cue = PV.cues.find(q => T >= q.s && T < q.e);
  PV.cue = cue || null;
  if (PV.wm) {
    // same place and timing as in the exported video (worked out on a 1920 x 1080 frame)
    const b = CaseDraw.watermarkBox(1920, 1080, T, PV.wm), wm = $('fpWm');
    wm.style.left = (b.x / 19.2) + '%'; wm.style.top = (b.y / 10.8) + '%'; wm.style.width = (b.size / 19.2) + '%'; wm.style.opacity = b.alpha;
  }
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
  $('fpLines').classList.add('hidden');
  if (!PV) return;
  PV.token++;
  stopAll();
  ['fpVideo', 'fpAudio'].forEach(id => { const el = $(id); el.removeAttribute('src'); el.dataset.src = ''; el.load(); });
  PV.urls.forEach(u => URL.revokeObjectURL(u));
  PV = null;
}

// ---------- fixing captions without leaving the preview ----------
function openFix(f, at) {
  if (!PV || !f) return;
  togglePlay(false);
  PV.fix = { f, at };
  renderFix();
  $('fpLines').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderFix() {
  const { f, at } = PV.fix;
  const box = $('fpLines');
  box.innerHTML = `<div class="fp-lines-head"><strong>Lines around ${X.fmtH(at)} in "${X.esc(label(f))}"</strong>
      <button id="fpFixDone" class="btn primary small" type="button">Done, keep watching</button></div>
    <div class="tl-edit">${linesHtml(f, linesBetween(f, at - 10, at + 10), at)}</div>`;
  box.classList.remove('hidden');
  $('fpFixDone').onclick = closeFix;
  const focus = box.querySelector('.tl-focus');
  if (focus) focus.scrollIntoView({ block: 'nearest' });
}

async function closeFix() {
  $('fpLines').classList.add('hidden');
  PV.fix = null;
  await seekTo(Math.max(0, nowT() - 2)); // replay the last moment to check the fix
  togglePlay(true);
}

async function onFixEdit(e) {
  if (!PV || !PV.fix || !e.target.closest('[data-tl]')) return;
  if (!(await applyLineEdit(e, PV.fix.f))) return;
  // captions (and swear words) follow the edit right away
  const caps = await captionCues(PV.plan, PV.capMode, '16:9', PV.isSwear);
  PV.cues = caps ? caps.cues : [];
  if (PV.isSwear) PV.mutes = await planSwears(X.cur(), PV.plan, PV.isSwear);
  renderFix();
}

// Where in its file the footage at preview time T is (for the line editor)
function fileTimeAt(T, fid) {
  const sg = PV.plan.segs[segAt(T)];
  if (!sg || sg.kind !== 'clip' || !sg.file || (fid && sg.file.id !== fid)) return null;
  return { f: sg.file, at: sg.from + (T - sg.t0) };
}

export function wireFinalPreview() {
  $('fpCap').addEventListener('click', () => {
    if (!PV) return;
    const w = fileTimeAt(nowT(), PV.cue && PV.cue.fid);
    if (w) openFix(w.f, w.at);
  });
  $('fpFix').addEventListener('click', () => {
    if (!PV) return;
    const w = fileTimeAt(nowT());
    if (!w || !w.f.transcript) return alert('No one in the footage is speaking here: this part is your narration or a photo. Pause on a clip to fix its captions.');
    openFix(w.f, w.at);
  });
  $('fpLines').addEventListener('change', onFixEdit);
  $('fpLines').addEventListener('click', e => { if (e.target.closest('[data-tl="split"], [data-tl="del"]')) onFixEdit(e); });
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

// Real length of a narration part on screen (from your recording), or null before it's uploaded
// Which stretches of each video file the video shows: clips and the footage under narration.
// { fileId: [{ a, b, segId, kind }] }. Uses the recorded narration's timing, or an estimate.
export function footageRanges(c) {
  if (!X || !c || !c.story) return {};
  let m = matchParts(c);
  if (!m) m = narrParts(c).map(p => ({ id: p.id, a0: 0, a1: Math.max(1, p.text.split(/\s+/).filter(Boolean).length / WPS), ok: true }));
  let plan;
  try { plan = buildPlan(c, m); } catch (e) { return {}; }
  const out = {};
  for (const sg of plan.segs) {
    if (!sg.pic || !sg.pic.file || sg.pic.file.type !== 'video') continue;
    const a = sg.pic.from, b = sg.pic.freeze ? a + 0.3 : a + sg.dur;
    (out[sg.pic.file.id] = out[sg.pic.file.id] || []).push({ a, b, segId: sg.seg.id, kind: sg.kind });
  }
  return out;
}

export function partLength(c, id) {
  const m = matchParts(c);
  const x = m && m.find(y => y.id === id);
  return x ? LEAD + (x.a1 - x.a0) + TAIL : null;
}
