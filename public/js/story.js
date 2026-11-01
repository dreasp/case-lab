// Story builder (footage step 2): AI rough cut in story order with narration drafts,
// edited as a simple list (drag, trim, add, delete), previewed in order, script exported.

import { addFiles, casePhotoItem, stripHtml, fillThumbs, migrate } from './media.js';
import { partLength } from './finish.js';

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

export function initStory(helpers) {
  X = helpers;
  $('storyBuild').addEventListener('click', build);
  $('storyPlay').addEventListener('click', () => preview(0));
  $('storyScript').addEventListener('click', downloadScript);
  $('storyCopy').addEventListener('click', copyNarration);
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

function narrCard(s, i, n) {
  return `<li class="seg narr" data-i="${i}">
    <div class="seg-handle" title="Drag to move">⠿</div>
    <div>
      <div class="seg-num">Narration ${n} · <span class="mono" data-est>${X.fmtH(narrSecs(s.text))}</span></div>
      <textarea rows="${Math.min(8, Math.max(2, Math.ceil((s.text || '').length / 110)))}" data-field="text" placeholder="Write what you will say here">${X.esc(s.text || '')}</textarea>
      ${visuals(s, 'Shown one after another while you speak; photos slowly zoom. Without any, the footage leading up to the next clip is shown.')}
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
const uttIn = (f, s) => ((f && f.transcript && f.transcript.utterances) || []).map((u, i) => ({ u, i })).filter(x => x.u.e > s.start && x.u.s < s.end);

function lineEditor(f, s) {
  const names = X.speakerMap(f);
  const letters = [...new Set([...((f.transcript && f.transcript.utterances) || []).map(u => u.sp), ...Object.keys(f.speakerNames || {})])];
  const opts = sp => letters.map(l => `<option value="${X.esc(l)}" ${l === sp ? 'selected' : ''}>${X.esc(names[l] || 'Speaker ' + l)}</option>`).join('') + '<option value="__new">+ Someone else…</option>';
  const rows = uttIn(f, s);
  if (!rows.length) return '<span class="muted">No speech in this clip.</span>';
  return `<div class="tl-help muted small-text">Fix who is speaking and what they say. To give part of a line to someone else: click in the text where they start talking, click "Split here", then pick the speaker for the new line. Changes apply to this file everywhere (captions, transcript).</div>` +
    rows.map(({ u, i }) => `<div class="tl-line" data-u="${i}">
      <span class="mono small-text muted">${X.fmtH(u.s)}</span>
      <select data-tl="sp">${opts(u.sp)}</select>
      <textarea data-tl="text" rows="${Math.min(5, Math.max(1, Math.ceil(u.text.length / 90)))}">${X.esc(u.text)}</textarea>
      <div class="tl-btns"><button class="btn ghost small" data-tl="split" type="button" title="Split this line where the text cursor is">Split here</button><button class="btn ghost small" data-tl="del" type="button" title="Delete this line">✕</button></div>
    </div>`).join('');
}

async function onLineEdit(e) {
  const el = e.target.closest('[data-tl]');
  if (!el) return false;
  const li = el.closest('.seg');
  const s = story(X.cur()).segments[+li.dataset.i];
  const f = X.fileById(s.file);
  const utt = f && f.transcript && f.transcript.utterances;
  const row = el.closest('.tl-line');
  if (!utt || !row) return true;
  const i = +row.dataset.u, u = utt[i];
  const act = el.dataset.tl;
  if (e.type === 'change' && act === 'sp') {
    if (el.value === '__new') {
      const name = (prompt('Who is speaking? (for example "911 Operator" or "Witness 3")') || '').trim();
      if (!name) { el.value = u.sp; return true; }
      const names = X.speakerMap(f);
      let letter = Object.keys(names).find(k => names[k].toLowerCase() === name.toLowerCase());
      if (!letter) { let k = 1; while (names['N' + k] || utt.some(x => x.sp === 'N' + k)) k++; letter = 'N' + k; f.speakerNames = { ...(f.speakerNames || {}), [letter]: name }; }
      u.sp = letter;
    } else u.sp = el.value;
  } else if (e.type === 'change' && act === 'text') {
    u.text = el.value.trim();
    if (!u.text) utt.splice(i, 1);
  } else if (e.type === 'click' && act === 'split') {
    const ta = row.querySelector('textarea');
    const pos = ta.selectionStart;
    const a = ta.value.slice(0, pos).trim(), b = ta.value.slice(pos).trim();
    if (!a || !b) { alert('First click in the text exactly where the other person starts talking, then click "Split here".'); return true; }
    const wa = a.split(/\s+/).length, wb = b.split(/\s+/).length;
    const t = u.s + (u.e - u.s) * wa / (wa + wb);
    utt.splice(i + 1, 0, { ...u, s: Math.round(t * 100) / 100, text: b });
    u.e = Math.round(t * 100) / 100; u.text = a;
  } else if (e.type === 'click' && act === 'del') {
    if (!confirm('Delete this line from the transcript?')) return true;
    utt.splice(i, 1);
  } else return true;
  f.transcriptEdited = true;
  await X.save();
  renderStory();
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
      <div class="seg-num">Clip ${k} · <span class="mono">${X.fmtH(s.end - s.start)}</span></div>
      <div class="seg-head"><strong>${X.esc(s.label || 'Clip')}</strong><span class="seg-file">${X.esc(label(f))}</span></div>
      ${s.why ? `<div class="seg-why">${X.esc(s.why)}</div>` : ''}
      <div class="seg-trim">
        Start <button class="btn ghost" data-act="nudge" data-edge="start" data-d="-5" type="button">−5s</button><button class="btn ghost" data-act="nudge" data-edge="start" data-d="-1" type="button">−1s</button>
        <input data-field="start" value="${X.fmtH(s.start)}"><button class="btn ghost" data-act="nudge" data-edge="start" data-d="1" type="button">+1s</button><button class="btn ghost" data-act="nudge" data-edge="start" data-d="5" type="button">+5s</button>
        &nbsp; End <button class="btn ghost" data-act="nudge" data-edge="end" data-d="-5" type="button">−5s</button><button class="btn ghost" data-act="nudge" data-edge="end" data-d="-1" type="button">−1s</button>
        <input data-field="end" value="${X.fmtH(s.end)}"><button class="btn ghost" data-act="nudge" data-edge="end" data-d="1" type="button">+1s</button><button class="btn ghost" data-act="nudge" data-edge="end" data-d="5" type="button">+5s</button>
      </div>
      ${editLines.has(s.id) ? `<div class="tl-edit">${lineEditor(f, s)}</div>` : `<div class="seg-lines">${clipLines(f, s)}</div>`}
      ${f && f.transcript ? `<button class="btn ghost small tl-toggle" data-act="lines" type="button">${editLines.has(s.id) ? 'Done editing lines' : 'Edit lines (who said what)'}</button>` : ''}
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
  }, true);
  list.addEventListener('click', async e => {
    if (e.target.closest('[data-tl="split"], [data-tl="del"]')) { await onLineEdit(e); return; }
    const mb = e.target.closest('[data-media]');
    if (mb) {
      const s = story(X.cur()).segments[+mb.closest('.seg').dataset.i];
      const items = s.media || [];
      const k = items.findIndex(x => x.id === mb.dataset.item);
      if (k < 0) return;
      if (mb.dataset.media === 'del') items.splice(k, 1); else if (k > 0) [items[k - 1], items[k]] = [items[k], items[k - 1]];
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
    if (act === 'lines') { if (editLines.has(s.id)) editLines.delete(s.id); else editLines.add(s.id); renderStory(); return; }
    if (act === 'view') { const f = X.fileById(s.file); if (f) X.openViewer(f, s.start); return; }
    if (act === 'up' && i > 0) [segs[i - 1], segs[i]] = [segs[i], segs[i - 1]];
    else if (act === 'down' && i < segs.length - 1) [segs[i + 1], segs[i]] = [segs[i], segs[i + 1]];
    else if (act === 'del') { if (s.type === 'narration' && (s.text || '').trim() && !confirm('Delete this narration part?')) return; segs.splice(i, 1); }
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
    if (e.target.dataset.field !== 'text') return;
    const li = e.target.closest('.seg');
    story(X.cur()).segments[+li.dataset.i].text = e.target.value;
    li.querySelector('[data-est]').textContent = X.fmtH(narrSecs(e.target.value));
    renderTotals();
    saveSoon();
  });
  list.addEventListener('change', async e => {
    if (e.target.closest('[data-tl]')) { await onLineEdit(e); return; }
    if (e.target.matches('[data-media-add], [data-case-photo]')) {
      const c = X.cur();
      const s = story(c).segments[+e.target.closest('.seg').dataset.i];
      s.media = s.media || [];
      openVis.add(s.id);
      if (e.target.matches('[data-media-add]')) {
        const files = [...e.target.files]; e.target.value = '';
        const { items, skipped } = await addFiles(c.id, files);
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

function wirePreview() {
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

async function playAt(i) {
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
    await Promise.all([m.video ? seek(v, s.start) : null, m.audio ? seek(a, s.start) : null]);
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
