// Story builder (footage step 2): AI rough cut in story order with narration drafts,
// edited as a simple list (drag, trim, add, delete), previewed in order, script exported.

import { addFiles, casePhotoItem, stripHtml, fillThumbs, migrate, openTrim } from './media.js';
import { partLength } from './finish.js';
import { linesBetween, linesHtml, applyLineEdit } from './lines.js';
import { getWords } from './words.js';
import { evenVolume } from './even-volume.js';
import { openFaces } from './faces.js';

let X = null;               // helpers from footage.js
const $ = id => document.getElementById(id);
const WPS = 2.6;            // narration read speed, words per second (about 156 a minute)

const parseT = v => {
  if (typeof v === 'number') return v;
  const m = String(v || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3];
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
};
const newId = () => Math.random().toString(36).slice(2, 10);
const narrSecs = t => Math.max(2, String(t || '').split(/\s+/).filter(Boolean).length / WPS);
const segSecs = s => s.type === 'clip' ? Math.max(0, s.end - s.start) : narrSecs(s.text);
const label = f => f ? (f.path || f.name) : 'missing file';

// ---------- whole sentences ----------
// Moves a clip's start back to where the sentence begins and its end to where it finishes, using
// the word timing of the transcript (free). Never shortens a clip.
const SENT_END = /[.?!…]["'”’)\]]*$/;
const PAUSE = 1.2;      // a pause this long counts as the end of a sentence
const MAX_END = 25, MAX_START = 20;
async function wholeSentences(f, start, end) {
  const words = await getWords(X.cur(), f).catch(() => null);
  const dur = (f && f.duration) || Infinity;
  const r = v => Math.round(v * 100) / 100;
  if (!words || !words.length) {
    // no word timing: use the transcript lines instead
    const utt = (f && f.transcript && f.transcript.utterances) || [];
    const ue = utt.find(u => u.s < end - 0.05 && u.e > end + 0.05);
    const us = utt.find(u => u.s < start - 0.05 && u.e > start + 0.05);
    return {
      start: us && start - us.s <= MAX_START ? r(Math.max(0, us.s - 0.3)) : start,
      end: ue && ue.e - end <= MAX_END ? r(Math.min(dur, ue.e + 0.35)) : end,
    };
  }
  const W = words.map(([s, e, t]) => ({ s, e, t: String(t || '') }));
  let newEnd = end;
  let i = -1;
  for (let k = 0; k < W.length && W[k].s < end - 0.05; k++) i = k;
  if (i >= 0) {
    const ended = (k) => SENT_END.test(W[k].t) || !W[k + 1] || W[k + 1].s - W[k].e > PAUSE;
    if (!(W[i].e <= end + 0.05 && ended(i))) {
      let j = i;
      while (!ended(j) && W[j + 1] && W[j + 1].e - end <= MAX_END) j++;
      if (ended(j)) newEnd = Math.min(dur, W[j].e + 0.35, W[j + 1] ? W[j + 1].s - 0.05 : Infinity);
    }
  }
  let newStart = start;
  i = W.findIndex(w => w.e > start + 0.05);
  if (i >= 0) {
    const begins = k => k === 0 || SENT_END.test(W[k - 1].t) || W[k].s - W[k - 1].e > PAUSE;
    if (!(W[i].s >= start - 0.05 && begins(i))) {
      let j = i;
      while (!begins(j) && start - W[j - 1].s <= MAX_START) j--;
      if (begins(j)) newStart = Math.max(0, W[j].s - 0.3, j > 0 ? W[j - 1].e + 0.05 : 0);
    }
  }
  return { start: r(Math.min(start, newStart)), end: r(Math.max(end, newEnd)) };
}

async function fixAllSentences() {
  const c = X.cur();
  const segs = story(c).segments.filter(s => s.type === 'clip');
  if (!segs.length) return alert('There are no clips yet.');
  const btn = $('storySentences');
  btn.disabled = true; btn.textContent = 'Checking clips…';
  let changed = 0, added = 0;
  try {
    for (const s of segs) {
      const f = X.fileById(s.file);
      if (!f || !f.transcript) continue;
      const n = await wholeSentences(f, s.start, s.end);
      if (n.start !== s.start || n.end !== s.end) { changed++; added += (s.start - n.start) + (n.end - s.end); s.start = n.start; s.end = n.end; }
    }
  } finally { btn.disabled = false; btn.textContent = 'Fix cut-off sentences'; }
  if (!changed) return alert('Every clip already starts and ends on a whole sentence.');
  await X.save();
  renderStory();
  alert(`Fixed ${changed} clip${changed === 1 ? '' : 's'} so nobody is cut off mid-sentence. This added ${added < 60 ? Math.max(1, Math.round(added)) + ' seconds' : X.fmtH(added)} in total.\n\nYou can still adjust any clip by hand with the Start and End buttons.`);
}

export function initStory(helpers) {
  X = helpers;
  $('storyBuild').addEventListener('click', build);
  $('storyPlay').addEventListener('click', () => preview(0));
  $('storyScript').addEventListener('click', downloadScript);
  $('storyCopy').addEventListener('click', copyNarration);
  $('storySentences').addEventListener('click', fixAllSentences);
  $('storyTrans').addEventListener('change', async () => { const c = X.cur(); if (!c) return; story(c).trans = $('storyTrans').value; await X.save(); renderStory(); });
  $('storyTarget').addEventListener('change', async () => { const c = X.cur(); if (!c) return; story(c).targetMin = +$('storyTarget').value || 30; await X.save(); });
  $('storyStyle').addEventListener('change', async () => { const c = X.cur(); if (!c) return; story(c).style = $('storyStyle').value; await X.save(); });
  $('storyAddNarr').addEventListener('click', () => addSeg({ type: 'narration', text: '' }));
  $('storyAddClip').addEventListener('change', e => {
    const [fid, a, b] = e.target.value.split('|');
    e.target.value = '';
    if (!fid) return;
    const f = X.fileById(fid);
    if (f) addSeg(snap(f, { type: 'clip', file: fid, start: +a, end: +b, label: 'Added clip', why: '' }));
  });
  wireList();
  wirePreview();
}

function story(c) {
  if (!c.story) c.story = { targetMin: 30, style: '', segments: [] };
  return c.story;
}

const usableFiles = c => c.files.filter(f => f.analysis && !f.skipResearch && (f.type === 'video' || f.type === 'audio'));

// ---------- build ----------
async function build() {
  const c = X.cur();
  if (!c) return;
  const files = usableFiles(c);
  if (!files.length) return alert('Analyze the videos and audio first (Files tab).');
  if (!c.master) return alert('Build the case research first (Research tab). The story is built from it.');
  const st = story(c);
  if (st.segments.length && !confirm('Build a new story? This replaces the current one, including your edits.')) return;
  st.targetMin = +$('storyTarget').value || 30;
  st.style = $('storyStyle').value;
  const btn = $('storyBuild');
  btn.disabled = true; btn.textContent = 'Building…';
  $('storyInfo').innerHTML = '<div class="story-note muted">Putting the rough cut together. This takes about a minute.</div>';
  try {
    const sensitiveAt = (f, m) => ((f.analysis.sensitive || []).some(s => s.start < m.end && s.end > m.start));
    const r = await X.api('case/story', {
      title: c.title, context: X.contextText(c), style: st.style, targetMin: st.targetMin,
      psych: c.psych && c.psych.on ? { secs: c.psych.secs || 30, notes: c.psych.notes || '' } : null,
      research: { overview: c.master.overview, story_beats: (c.master.story_beats || []).map(b => ({ title: b.title, description: b.description })), key_quotes: (c.master.key_quotes || []).map(q => ({ speaker: q.speaker, quote: q.quote })) },
      files: files.map(f => ({
        id: f.id, name: label(f), type: f.type, duration: f.duration, clock: f.analysis.clock_start, camera: f.analysis.camera,
        speakers: X.speakerMap(f), summary: f.analysis.summary,
        moments: (f.analysis.moments || []).map(m => ({ start: m.start, end: m.end, importance: m.importance, title: m.title, description: m.description, quote: m.quote, sensitive: sensitiveAt(f, m) })),
      })),
    });
    const res = r.result || {};
    st.segments = (res.segments || []).map(s => s.type === 'clip' ? snap(X.fileById(s.file), { ...s, id: newId() }) : { ...s, id: newId() });
    st.title_ideas = res.title_ideas || [];
    st.notes = res.notes || [];
    st.builtAt = Date.now();
    await X.save();
    X.refreshUsage();
  } catch (e) {
    alert('Could not build the story: ' + e.message);
  } finally {
    btn.disabled = false;
    renderStory();
  }
}

// Moves clip edges to the start/end of the transcript line they fall in, so nobody is cut off mid-sentence
function snap(f, seg) {
  const utt = (f && f.transcript && f.transcript.utterances) || [];
  const dur = (f && f.duration) || seg.end;
  const inA = utt.find(u => u.s < seg.start && seg.start < u.e && seg.start - u.s <= 10);
  if (inA) seg.start = Math.max(0, inA.s - 0.3);
  const inB = utt.find(u => u.s < seg.end && seg.end < u.e && u.e - seg.end <= 12);
  if (inB) seg.end = Math.min(dur, inB.e + 0.5);
  seg.start = Math.round(seg.start * 10) / 10;
  seg.end = Math.round(seg.end * 10) / 10;
  return seg;
}

// ---------- list ----------
export function renderStory() {
  const c = X.cur();
  if (!c) return;
  const st = story(c);
  $('storyTarget').value = st.targetMin || 30;
  $('storyStyle').value = st.style || '';
  $('storyTrans').value = st.trans || 'none';
  $('storyBuild').textContent = st.segments.length ? 'Rebuild story' : 'Build story';
  ['storyPlay', 'storyScript', 'storyCopy'].forEach(id => { $(id).disabled = !st.segments.length; });
  $('storyAdd').classList.toggle('hidden', !st.segments.length);
  const info = [];
  if (!st.segments.length) info.push(`<div class="story-note muted">${c.master ? 'Click "Build story" and the AI puts together a rough cut: footage clips in story order, with your narration parts drafted in between. Then reorder, trim, rewrite or delete anything here.' : 'First build the case research (Research tab). The story is built from it.'}</div>`);
  if ((st.title_ideas || []).length) info.push(`<div class="story-note"><strong>Title ideas</strong><ul>${st.title_ideas.map(t => `<li>${X.esc(t)}</li>`).join('')}</ul></div>`);
  if ((st.notes || []).length) info.push(`<div class="story-note"><strong>Check before recording</strong><ul>${st.notes.map(t => `<li>${X.esc(t)}</li>`).join('')}</ul></div>`);
  $('storyInfo').innerHTML = info.join('');
  let n = 0, k = 0;
  if (migrate(c)) X.save();
  $('storyList').innerHTML = st.segments.map((s, i) => s.type === 'clip' ? clipCard(s, i, ++k) : narrCard(s, i, ++n)).join('');
  fillThumbs($('storyList'), st.segments.flatMap(s => s.media || []));
  renderTotals();
  fillAddClip(c);
}

const openVis = new Set(); // scenes whose photo/video section is open
function visuals(s, hint) {
  const c = X.cur();
  const items = s.media || [];
  const photos = c.files.filter(f => f.type === 'photo');
  const dur = (s.type === 'narration' && partLength(c, s.id)) || segSecs(s);
  return `<details class="seg-vis" data-vis="${s.id}" ${items.length || openVis.has(s.id) ? 'open' : ''}>
    <summary>Photos or videos on screen${items.length ? ` (${items.length})` : ''}</summary>
    ${stripHtml(items, s.id, photos, hint, dur)}
  </details>`;
}

// The transition into a part (chosen per part, or the default for the whole video)
const TRANS = { none: 'None (quick soft cut)', black: 'Fade through black', cross: 'Crossfade', slide: 'Slide', swirl: 'Swirl' };
function transPick(s, i) {
  if (!i) return '';
  const def = story(X.cur()).trans || 'none';
  const cur = s.trans || '';
  return `<div class="seg-trans">Transition into this part: <select data-field="trans">
      <option value="" ${!cur ? 'selected' : ''}>Default (${TRANS[def]})</option>
      ${Object.entries(TRANS).map(([k, v]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${v}</option>`).join('')}
    </select></div>`;
}

// Date and place card shown on screen while you narrate
function infoCard(s) {
  const k = s.card || {};
  const on = !!(k.date || k.place);
  return `<details class="seg-card" ${on || openCards.has(s.id) ? 'open' : ''} data-cardbox="${s.id}">
    <summary>Date and place on screen${on ? ': ' + X.esc([k.date, k.place].filter(Boolean).join(' · ')) : ''}</summary>
    <div class="card-fields">
      <label class="small-text">Date<input data-card="date" value="${X.esc(k.date || '')}" placeholder="December 16, 2024"></label>
      <label class="small-text">Place<input data-card="place" value="${X.esc(k.place || '')}" placeholder="Goshen Township, Ohio, USA"></label>
      <label class="small-text">Animation<select data-card="anim"><option value="roll" ${k.anim !== 'type' ? 'selected' : ''}>Rolls up onto the screen</option><option value="type" ${k.anim === 'type' ? 'selected' : ''}>Typed out letter by letter</option></select></label>
      <label class="small-text">Shown for<select data-card="dur">${[4, 6, 8, 10, 15].map(v => `<option value="${v}" ${(k.dur || 6) === v ? 'selected' : ''}>${v} seconds</option>`).join('')}</select></label>
      <label class="small-text">Appears<select data-card="at">${[0, 1, 2, 3, 5].map(v => `<option value="${v}" ${(k.at || 0) === v ? 'selected' : ''}>${v ? v + ' s after the part starts' : 'when the part starts'}</option>`).join('')}</select></label>
    </div>
    <div class="muted small-text">Shown in the bottom left of the screen. Leave both empty to show nothing. You'll see it in the Final video preview.</div>
  </details>`;
}
const openCards = new Set();

function faceBtn(f) {
  if (!f || f.type !== 'video') return '';
  const n = f.faces ? Object.keys(f.faces.blur || {}).length : 0;
  return `<button class="btn ghost small" data-act="faces" type="button" title="Find faces in this clip and choose which ones to blur">${n ? `Blurred faces (${n})` : 'Blur faces'}</button>`;
}

function narrCard(s, i, n) {
  return `<li class="seg narr" data-i="${i}">
    <div class="seg-handle" title="Drag to move">⠿</div>
    <div>
      ${transPick(s, i)}
      <div class="seg-num">Narration ${n} · <span class="mono" data-est>${X.fmtH(narrSecs(s.text))}</span></div>
      <textarea rows="${Math.min(8, Math.max(2, Math.ceil((s.text || '').length / 110)))}" data-field="text" placeholder="Write what you will say here">${X.esc(s.text || '')}</textarea>
      ${visuals(s, 'Shown one after another while you speak; photos slowly zoom. Without any, the footage leading up to the next clip is shown.')}
      ${infoCard(s)}
    </div>
    <div class="seg-side">
      <button class="btn ghost" data-act="play" type="button" title="Preview from here">▶</button>
      <button class="btn ghost" data-act="up" type="button" title="Move up">↑</button>
      <button class="btn ghost" data-act="down" type="button" title="Move down">↓</button>
      <button class="btn ghost" data-act="del" type="button" title="Delete">✕</button>
    </div>
  </li>`;
}

// ---------- fixing who said what (edits the file's transcript, so captions everywhere use it) ----------
const editLines = new Set(); // clip scenes with the line editor open
const uttIn = (f, s) => linesBetween(f, s.start, s.end);
const lineEditor = (f, s) => linesHtml(f, uttIn(f, s));

async function onLineEdit(e) {
  const el = e.target.closest('[data-tl]');
  if (!el) return false;
  const s = story(X.cur()).segments[+el.closest('.seg').dataset.i];
  const f = X.fileById(s.file);
  if (f && await applyLineEdit(e, f)) renderStory();
  return true;
}

function clipLines(f, s) {
  const names = f ? X.speakerMap(f) : {};
  const utt = ((f && f.transcript && f.transcript.utterances) || []).filter(u => u.e > s.start && u.s < s.end);
  if (!utt.length) return '<span class="muted">No speech in this clip.</span>';
  return utt.slice(0, 12).map(u => `<div><b>${X.esc(names[u.sp] || 'Speaker ' + u.sp)}:</b> ${X.esc(u.text)}</div>`).join('') + (utt.length > 12 ? `<div class="muted">… ${utt.length - 12} more lines</div>` : '');
}

function clipCard(s, i, k) {
  const f = X.fileById(s.file);
  return `<li class="seg clip" data-i="${i}">
    <div class="seg-handle" title="Drag to move">⠿</div>
    <div>
      ${transPick(s, i)}
      <div class="seg-num">Clip ${k} · <span class="mono">${X.fmtH(s.end - s.start)}</span></div>
      <div class="seg-head"><strong>${X.esc(s.label || 'Clip')}</strong><span class="seg-file">${X.esc(label(f))}</span></div>
      ${s.why ? `<div class="seg-why">${X.esc(s.why)}</div>` : ''}
      <div class="seg-trim">
        Start <button class="btn ghost" data-act="nudge" data-edge="start" data-d="-5" type="button">−5s</button><button class="btn ghost" data-act="nudge" data-edge="start" data-d="-1" type="button">−1s</button>
        <input data-field="start" value="${X.fmtH(s.start)}"><button class="btn ghost" data-act="nudge" data-edge="start" data-d="1" type="button">+1s</button><button class="btn ghost" data-act="nudge" data-edge="start" data-d="5" type="button">+5s</button>
        &nbsp; End <button class="btn ghost" data-act="nudge" data-edge="end" data-d="-5" type="button">−5s</button><button class="btn ghost" data-act="nudge" data-edge="end" data-d="-1" type="button">−1s</button>
        <input data-field="end" value="${X.fmtH(s.end)}"><button class="btn ghost" data-act="nudge" data-edge="end" data-d="1" type="button">+1s</button><button class="btn ghost" data-act="nudge" data-edge="end" data-d="5" type="button">+5s</button>
        ${f && f.transcript ? '&nbsp; <button class="btn ghost" data-act="sentence" type="button" title="Moves the start and end so the clip begins and ends on whole sentences">Finish the sentence</button>' : ''}
      </div>
      ${editLines.has(s.id) ? `<div class="tl-edit">${lineEditor(f, s)}</div>` : `<div class="seg-lines">${clipLines(f, s)}</div>`}
      ${f && f.transcript ? `<button class="btn ghost small tl-toggle" data-act="lines" type="button">${editLines.has(s.id) ? 'Done editing lines' : 'Edit lines (who said what)'}</button>` : ''} ${faceBtn(f)}
      ${visuals(s, f && f.type === 'audio' ? 'Shown one after another while the recording plays; photos slowly zoom. Without any, a title card is shown.' : 'These replace the footage picture during this clip (its sound stays), one after another.')}
    </div>
    <div class="seg-side">
      <button class="btn ghost" data-act="play" type="button" title="Preview from here">▶</button>
      <button class="btn ghost" data-act="view" type="button" title="Open the full file at this point">Open</button>
      <button class="btn ghost" data-act="up" type="button" title="Move up">↑</button>
      <button class="btn ghost" data-act="down" type="button" title="Move down">↓</button>
      <button class="btn ghost" data-act="del" type="button" title="Delete">✕</button>
    </div>
  </li>`;
}

function renderTotals() {
  const c = X.cur();
  const segs = story(c).segments;
  if (!segs.length) { $('storyTotals').textContent = ''; return; }
  const clip = segs.filter(s => s.type === 'clip').reduce((a, s) => a + segSecs(s), 0);
  const narr = segs.filter(s => s.type === 'narration').reduce((a, s) => a + segSecs(s), 0);
  const tot = clip + narr;
  $('storyTotals').textContent = `about ${X.fmtH(tot)} · footage ${Math.round(clip / (tot || 1) * 100)}% · ${segs.filter(s => s.type === 'clip').length} clips · ${segs.filter(s => s.type === 'narration').length} narration parts`;
}

function fillAddClip(c) {
  const used = new Set(story(c).segments.filter(s => s.type === 'clip').map(s => `${s.file}|${Math.round(s.start)}`));
  const opts = [];
  for (const f of usableFiles(c)) {
    const ms = [...(f.analysis.moments || [])].sort((a, b) => (b.importance || 0) - (a.importance || 0) || a.start - b.start);
    if (!ms.length) continue;
    opts.push(`<optgroup label="${X.esc(label(f))}">${ms.map(m => `<option value="${f.id}|${m.start}|${Math.max(m.end, m.start + 5)}">${used.has(`${f.id}|${Math.round(m.start)}`) ? '✓ ' : ''}${X.fmtH(m.start)} · ${'★'.repeat(Math.max(1, Math.min(5, m.importance || 1)))} ${X.esc(m.title || '')}</option>`).join('')}</optgroup>`);
  }
  $('storyAddClip').innerHTML = '<option value="">+ Add a clip from a key moment…</option>' + opts.join('');
}

async function addSeg(seg) {
  const c = X.cur();
  story(c).segments.push({ ...seg, id: newId() });
  await X.save();
  renderStory();
  const last = $('storyList').lastElementChild;
  if (last) { last.scrollIntoView({ behavior: 'smooth', block: 'center' }); const ta = last.querySelector('textarea'); if (ta) ta.focus(); }
}

let saveTimer = null;
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => X.save(), 600); };

function wireList() {
  const list = $('storyList');
  list.addEventListener('toggle', e => {
    const d = e.target.closest && e.target.closest('[data-vis]');
    if (d) { if (d.open) openVis.add(d.dataset.vis); else openVis.delete(d.dataset.vis); }
    const cb = e.target.closest && e.target.closest('[data-cardbox]');
    if (cb) { if (cb.open) openCards.add(cb.dataset.cardbox); else openCards.delete(cb.dataset.cardbox); }
  }, true);
  list.addEventListener('click', async e => {
    if (e.target.closest('[data-tl="split"], [data-tl="del"]')) { await onLineEdit(e); return; }
    const mb = e.target.closest('[data-media]');
    if (mb) {
      const s = story(X.cur()).segments[+mb.closest('.seg').dataset.i];
      const items = s.media || [];
      const k = items.findIndex(x => x.id === mb.dataset.item);
      if (k < 0) return;
      if (mb.dataset.media === 'trim') {
        const c = X.cur();
        const dur = (s.type === 'narration' && partLength(c, s.id)) || segSecs(s);
        openTrim(items[k], dur, async () => { await X.save(); renderStory(); });
        return;
      }
      if (mb.dataset.media === 'del') items.splice(k, 1);
      else if (mb.dataset.media === 'left' && k > 0) [items[k - 1], items[k]] = [items[k], items[k - 1]];
      else if (mb.dataset.media === 'right' && k < items.length - 1) [items[k + 1], items[k]] = [items[k], items[k + 1]];
      s.media = items;
      openVis.add(s.id);
      await X.save();
      renderStory();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const segs = story(X.cur()).segments;
    const i = +b.closest('.seg').dataset.i;
    const s = segs[i];
    const act = b.dataset.act;
    if (act === 'play') return preview(i);
    if (act === 'faces') { const f = X.fileById(s.file); if (f) openFaces(f, s.start, s.end); return; }
    if (act === 'lines') { if (editLines.has(s.id)) editLines.delete(s.id); else editLines.add(s.id); renderStory(); return; }
    if (act === 'view') { const f = X.fileById(s.file); if (f) X.openViewer(f, s.start); return; }
    if (act === 'up' && i > 0) [segs[i - 1], segs[i]] = [segs[i], segs[i - 1]];
    else if (act === 'down' && i < segs.length - 1) [segs[i + 1], segs[i]] = [segs[i], segs[i + 1]];
    else if (act === 'del') { if (s.type === 'narration' && (s.text || '').trim() && !confirm('Delete this narration part?')) return; segs.splice(i, 1); }
    else if (act === 'sentence') {
      const f = X.fileById(s.file);
      if (!f) return;
      const n = await wholeSentences(f, s.start, s.end);
      if (n.start === s.start && n.end === s.end) return alert('This clip already starts and ends on a whole sentence. Use the Start and End buttons to adjust it by hand.');
      s.start = n.start; s.end = n.end;
    }
    else if (act === 'nudge') {
      const f = X.fileById(s.file);
      const d = +b.dataset.d;
      if (b.dataset.edge === 'start') s.start = Math.max(0, Math.min(s.end - 1, s.start + d));
      else s.end = Math.max(s.start + 1, Math.min((f && f.duration) || Infinity, s.end + d));
    } else return;
    await X.save();
    renderStory();
  });
  list.addEventListener('input', e => {
    if (e.target.dataset.card) {
      const s = story(X.cur()).segments[+e.target.closest('.seg').dataset.i];
      const k = e.target.dataset.card;
      s.card = { anim: 'roll', dur: 6, at: 0, ...(s.card || {}) };
      s.card[k] = ['dur', 'at'].includes(k) ? +e.target.value : e.target.value;
      saveSoon();
      return;
    }
    if (e.target.dataset.field !== 'text') return;
    const li = e.target.closest('.seg');
    story(X.cur()).segments[+li.dataset.i].text = e.target.value;
    li.querySelector('[data-est]').textContent = X.fmtH(narrSecs(e.target.value));
    renderTotals();
    saveSoon();
  });
  list.addEventListener('change', async e => {
    if (e.target.closest('[data-tl]')) { await onLineEdit(e); return; }
    if (e.target.dataset.field === 'trans') {
      const s = story(X.cur()).segments[+e.target.closest('.seg').dataset.i];
      if (e.target.value) s.trans = e.target.value; else delete s.trans;
      await X.save();
      return;
    }
    if (e.target.dataset.card) return; // saved while typing
    if (e.target.matches('[data-media-add], [data-case-photo], [data-media-replace]')) {
      const c = X.cur();
      const s = story(c).segments[+e.target.closest('.seg').dataset.i];
      s.media = s.media || [];
      openVis.add(s.id);
      const statusEl = e.target.closest('.np-media').querySelector('[data-status]');
      const onStatus = t => { if (statusEl) statusEl.textContent = t; };
      if (e.target.matches('[data-media-replace]')) {
        const files = [...e.target.files]; e.target.value = '';
        const k = s.media.findIndex(x => x.id === e.target.dataset.mediaReplace);
        if (!files.length || k < 0) return;
        onStatus('Adding…');
        const { items, skipped } = await addFiles(c.id, files, onStatus);
        if (items[0]) s.media[k] = items[0]; // same spot in the order
        if (skipped.length) alert(`This could not be used: ${skipped.join(', ')}`);
      } else if (e.target.matches('[data-media-add]')) {
        const files = [...e.target.files]; e.target.value = '';
        onStatus('Adding…');
        const { items, skipped } = await addFiles(c.id, files, onStatus);
        s.media.push(...items);
        if (skipped.length) alert(`These were skipped (photos: JPG, PNG, WEBP; videos: MP4, MOV): ${skipped.join(', ')}`);
      } else {
        const f = X.fileById(e.target.value); e.target.value = '';
        if (f) s.media.push(casePhotoItem(f));
      }
      await X.save();
      renderStory();
      return;
    }
    const fld = e.target.dataset.field;
    if (fld !== 'start' && fld !== 'end') return;
    const s = story(X.cur()).segments[+e.target.closest('.seg').dataset.i];
    const f = X.fileById(s.file);
    const t = parseT(e.target.value);
    if (t == null) { e.target.value = X.fmtH(s[fld]); return; }
    if (fld === 'start') s.start = Math.max(0, Math.min(t, s.end - 1));
    else s.end = Math.max(s.start + 1, Math.min(t, (f && f.duration) || t));
    await X.save();
    renderStory();
  });
  // drag by the handle
  let from = null;
  list.addEventListener('mousedown', e => { const h = e.target.closest('.seg-handle'); if (h) h.parentElement.draggable = true; });
  list.addEventListener('dragstart', e => { const li = e.target.closest('.seg'); if (!li) return; from = +li.dataset.i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  list.addEventListener('dragover', e => {
    e.preventDefault();
    list.querySelectorAll('.drop-before').forEach(x => x.classList.remove('drop-before'));
    const li = e.target.closest('.seg');
    if (li) li.classList.add('drop-before');
  });
  list.addEventListener('dragend', () => {
    list.querySelectorAll('.seg').forEach(x => { x.draggable = false; x.classList.remove('dragging', 'drop-before'); });
    from = null;
  });
  list.addEventListener('drop', async e => {
    e.preventDefault();
    const li = e.target.closest('.seg');
    if (from == null || !li) return;
    const segs = story(X.cur()).segments;
    let to = +li.dataset.i;
    const [moved] = segs.splice(from, 1);
    if (from < to) to--;
    segs.splice(to, 0, moved);
    from = null;
    await X.save();
    renderStory();
  });
}

// ---------- preview ----------
let P = null; // preview state

async function mediaFor(f) {
  if (P.media.has(f.id)) return P.media.get(f.id);
  let m = null;
  if (f.type === 'video' && X.NATIVE_VIDEO.test(f.name)) {
    try { const file = await X.getLocalFile(f); const u = URL.createObjectURL(file); P.urls.push(u); m = { video: u, audio: null, note: 'Playing your original file.' }; } catch (e) { /* use the copies below */ }
  }
  if (!m && f.type === 'audio') {
    try { const file = await X.getLocalFile(f); const u = URL.createObjectURL(file); P.urls.push(u); m = { video: null, audio: u, note: 'Playing your original recording.' }; } catch (e) { /* below */ }
  }
  if (!m) {
    const [v, a] = await X.signedUrls([f.type === 'video' ? f.proxyKey : null, f.audioKey]);
    m = { video: f.type === 'video' ? v : null, audio: a || null, note: f.type === 'video' ? 'Showing the analysis copy (1 frame per second) with the real sound. The final video uses your original footage.' : 'Playing the recording.' };
  }
  P.media.set(f.id, m);
  return m;
}

// Adjusting the clip that is playing in the preview
async function onPreviewFix(e) {
  const b = e.target.closest('[data-fx]');
  if (!b || !P || P.kind !== 'clip') return;
  const s = story(X.cur()).segments[P.i];
  const f = s && X.fileById(s.file);
  if (!f) return;
  const fx = b.dataset.fx, d = +b.dataset.d || 0;
  let from = s.start;
  const before = [s.start, s.end];
  if (fx === 'start') { s.start = Math.max(0, Math.min(s.end - 1, s.start + d)); from = s.start; }
  else if (fx === 'end') { s.end = Math.max(s.start + 1, Math.min(f.duration || Infinity, s.end + d)); from = Math.max(s.start, s.end - 6); }
  else if (fx === 'ending') from = Math.max(s.start, s.end - 6);
  else if (fx === 'sentence') {
    const n = await wholeSentences(f, s.start, s.end);
    s.start = n.start; s.end = n.end;
    if (n.end !== before[1] && n.start === before[0]) from = Math.max(s.start, s.end - 6);
  }
  const moved = s.start !== before[0] || s.end !== before[1];
  $('spFixNote').textContent = fx === 'sentence' && !moved ? 'Already on whole sentences.' : moved ? `Now ${X.fmtH(s.start)} to ${X.fmtH(s.end)} · saved` : '';
  if (moved) { await X.save(); renderStory(); }
  playAt(P.i, from);
}

function wirePreview() {
  evenVolume($('spAudio')); evenVolume($('spVideo'));
  $('spFix').addEventListener('click', onPreviewFix);
  $('spClose').addEventListener('click', () => $('storyDialog').close());
  $('storyDialog').addEventListener('close', stopPreview);
  $('spNext').addEventListener('click', () => P && playAt(P.i + 1));
  $('spPrev').addEventListener('click', () => P && playAt(Math.max(0, P.i - 1)));
  $('spPause').addEventListener('click', () => {
    if (!P) return;
    P.paused = !P.paused;
    $('spPause').textContent = P.paused ? 'Play' : 'Pause';
    const v = $('spVideo'), a = $('spAudio');
    if (P.paused) { v.pause(); a.pause(); speechSynthesis.pause(); } else {
      if (P.kind === 'clip') { if (P.hasAudio) a.play().catch(() => {}); v.play().catch(() => {}); }
      speechSynthesis.resume();
    }
  });
}

async function preview(i) {
  const segs = story(X.cur()).segments;
  if (!segs.length) return;
  P = { i: 0, token: 0, media: new Map(), urls: [], paused: false };
  $('spPause').textContent = 'Pause';
  $('storyDialog').showModal();
  playAt(i);
}

function stopPreview() {
  if (!P) return;
  P.token++;
  const v = $('spVideo'), a = $('spAudio');
  v.pause(); a.pause(); v.removeAttribute('src'); a.removeAttribute('src'); v.load(); a.load();
  try { speechSynthesis.cancel(); } catch (e) { /* not supported */ }
  P.urls.forEach(u => URL.revokeObjectURL(u));
  clearInterval(P.timer);
  P = null;
}

const waitEvent = (el, ev) => new Promise(r => el.addEventListener(ev, r, { once: true }));
async function seek(el, t) {
  if (el.readyState < 1) await waitEvent(el, 'loadedmetadata');
  el.currentTime = t;
  await Promise.race([waitEvent(el, 'seeked'), new Promise(r => setTimeout(r, 4000))]);
}

async function playAt(i, from = null) {
  if (!P) return;
  const segs = story(X.cur()).segments;
  clearInterval(P.timer);
  const token = ++P.token;
  const v = $('spVideo'), a = $('spAudio'), narr = $('spNarr');
  v.pause(); a.pause();
  try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  if (i >= segs.length) { $('spMeta').textContent = 'End of the story'; narr.textContent = 'End of the story.'; narr.classList.remove('hidden'); return; }
  P.i = i;
  P.paused = false; $('spPause').textContent = 'Pause';
  const s = segs[i];
  const total = segSecs(s);
  const done = segs.slice(0, i).reduce((x, y) => x + segSecs(y), 0);
  const all = segs.reduce((x, y) => x + segSecs(y), 0);
  const bar = t => { $('spFill').style.width = `${Math.min(100, (done + t) / (all || 1) * 100)}%`; };
  P.kind = s.type;
  $('spFix').classList.toggle('hidden', s.type !== 'clip');
  if (P.fixFor !== s.id) { $('spFixNote').textContent = ''; P.fixFor = s.id; }
  if (s.type === 'narration') {
    $('spMeta').textContent = `${i + 1} of ${segs.length} · narration · ${X.fmtH(done)}`;
    $('spTitle').textContent = 'Your narration';
    $('spNote').textContent = 'Narration is shown as text for as long as it takes to read aloud.';
    narr.textContent = s.text || '(empty narration part)';
    narr.classList.remove('hidden');
    let t = 0;
    if ($('spVoice').checked && 'speechSynthesis' in window && (s.text || '').trim()) {
      const u = new SpeechSynthesisUtterance(s.text);
      u.rate = 1.05;
      u.onend = () => { if (P && P.token === token) playAt(i + 1); };
      speechSynthesis.speak(u);
      P.timer = setInterval(() => { if (!P.paused) bar(t += 0.25); }, 250);
    } else {
      P.timer = setInterval(() => {
        if (!P || P.token !== token || P.paused) return;
        bar(t += 0.25);
        if (t >= total) playAt(i + 1);
      }, 250);
    }
    return;
  }
  const f = X.fileById(s.file);
  $('spMeta').textContent = `${i + 1} of ${segs.length} · clip · ${X.fmtH(done)}`;
  $('spTitle').textContent = `${s.label || 'Clip'} · ${label(f)} ${X.fmtH(s.start)} to ${X.fmtH(s.end)}`;
  if (!f) return playAt(i + 1);
  const m = await mediaFor(f);
  if (!P || P.token !== token) return;
  $('spNote').textContent = m.note;
  narr.classList.toggle('hidden', !!m.video);
  if (!m.video) narr.textContent = `${label(f)}\n(audio only)`;
  P.hasAudio = !!m.audio;
  if (m.video && v.dataset.src !== m.video) { v.src = m.video; v.dataset.src = m.video; }
  if (m.audio && a.dataset.src !== m.audio) { a.src = m.audio; a.dataset.src = m.audio; }
  v.muted = !!m.audio;
  try {
    const at = from != null ? from : s.start;
    await Promise.all([m.video ? seek(v, at) : null, m.audio ? seek(a, at) : null]);
  } catch (e) { /* play from wherever it is */ }
  if (!P || P.token !== token) return;
  const clock = m.audio ? a : v;
  if (m.audio) a.play().catch(() => {});
  if (m.video) v.play().catch(() => {});
  P.timer = setInterval(() => {
    if (!P || P.token !== token) return;
    const t = clock.currentTime;
    bar(Math.max(0, t - s.start));
    // keep the 1-frame-a-second picture in step with the sound
    if (m.video && m.audio && Math.abs(v.currentTime - t) > 1.5) v.currentTime = t;
    if (t >= s.end || clock.ended) playAt(i + 1);
  }, 200);
}

// ---------- script ----------
function downloadScript() {
  const c = X.cur();
  const st = story(c);
  if (!st.segments.length) return;
  const txt = s => X.esc(s || '');
  let n = 0, k = 0, at = 0;
  const rows = st.segments.map(s => {
    const when = X.fmtH(at);
    at += segSecs(s);
    if (s.type === 'narration') return `<p style="margin:14pt 0 4pt"><b style="color:#8b1e1e">Narration ${++n}</b> <span style="color:#888">(${when}, about ${X.fmtH(narrSecs(s.text))})</span></p><p>${txt(s.text).replace(/\n/g, '<br>')}</p>`;
    const f = X.fileById(s.file);
    return `<p style="margin:10pt 0 2pt;color:#444"><b>Clip ${++k}: ${txt(s.label)}</b> <span style="color:#888">(${when})</span><br><i>${txt(label(f))}, ${X.fmtH(s.start)} to ${X.fmtH(s.end)} (${X.fmtH(s.end - s.start)})</i>${s.why ? `<br>${txt(s.why)}` : ''}</p>`;
  }).join('');
  const html = `<html><head><meta charset="utf-8"><title>${txt(c.title)} script</title>
    <style>body{font-family:Calibri,Arial,sans-serif;font-size:12pt;line-height:1.45}h1{font-size:20pt}h2{font-size:14pt;color:#8b1e1e}</style></head><body>
    <h1>${txt(c.title)}: script</h1>
    <p><i>About ${X.fmtH(at)} in total. Narration parts are numbered in the order they are heard.</i></p>
    ${(st.title_ideas || []).length ? `<h2>Title ideas</h2><ul>${st.title_ideas.map(t => `<li>${txt(t)}</li>`).join('')}</ul>` : ''}
    ${(st.notes || []).length ? `<h2>Check before recording</h2><ul>${st.notes.map(t => `<li>${txt(t)}</li>`).join('')}</ul>` : ''}
    <h2>Rough cut</h2>${rows}</body></html>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿', html], { type: 'application/msword' }));
  a.download = `${c.title.replace(/[^\w\s-]/g, '').trim() || 'case'} script.doc`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

async function copyNarration() {
  const parts = story(X.cur()).segments.filter(s => s.type === 'narration' && (s.text || '').trim()).map(s => s.text.trim());
  if (!parts.length) return alert('There is no narration yet.');
  try {
    await navigator.clipboard.writeText(parts.join('\n\n'));
    alert(`Copied ${parts.length} narration parts, in order, with a blank line between them. Paste them into ElevenLabs as one script.`);
  } catch (e) {
    alert('Your browser blocked copying. Use "Download script" instead.');
  }
}
