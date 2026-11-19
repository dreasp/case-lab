// Shorts: 30 to 60 second vertical videos cut from the case footage that is already analyzed.
// Picking the moments is free: it uses the analysis the app already has (each moment's importance,
// kind and key quote, and how much is said), no AI and nothing uploaded again.
//
// Saved on the case as c.shorts = [{ id, title, why, hook, intro, clips: [{ id, type: 'clip', file,
// start, end, label }], frame: { mode: 'big' | 'fill' }, narr }]. A Short is built and exported in
// the Final video tab like the long video (see shortView in footage.js).

import { wholeSentences } from './story.js';
import { addFiles, casePhotoItem, stripHtml, fillThumbs, openTrim } from './media.js';
import { linesBetween, linesHtml, applyLineEdit } from './lines.js';

const $ = id => document.getElementById(id);
let X = null;
export function initShorts(helpers) { X = helpers; wire(); }

const MIN = 30, MAX = 60;
const KIND = { reveal: 3, emotional: 2.5, action: 2, dialogue: 1.5, context: 0 };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const shorts = c => (c.shorts = c.shorts || []);
const mediaLen = list => (list || []).reduce((d, it) => d + (it.kind === 'video' ? (it.len || 5) : 3.5), 0);
const spoken = t => ((t || '').trim() ? t.trim().split(/\s+/).length / 2.6 + 0.8 : 0);
const lengthOf = sh => sh.clips.reduce((n, k) => n + Math.max(0, k.end - k.start), 0) + spoken(sh.intro) + spoken(sh.outro)
  + mediaLen(sh.startMedia) + mediaLen(sh.endMedia);
const editLines = new Set();

// How much is said in a stretch of a file (words a second), from the transcript
function talk(f, a, b) {
  const u = (f.transcript && f.transcript.utterances) || [];
  let words = 0;
  for (const x of u) if (x.e > a && x.s < b) words += (x.text || '').split(/\s+/).length * Math.min(1, (Math.min(b, x.e) - Math.max(a, x.s)) / Math.max(0.1, x.e - x.s));
  return words / Math.max(1, b - a);
}

const sensitive = (f, a, b) => ((f.analysis && f.analysis.sensitive) || []).some(s => s.start < b && s.end > a);

// Ranks every analyzed moment and turns the best ones into 30 to 60 second Shorts
async function findMoments(c, count) {
  const cands = [];
  for (const f of c.files || []) {
    if (f.type !== 'video' || !f.analysis || f.status !== 'done') continue;
    const ms = [...(f.analysis.moments || [])].filter(m => m.end > m.start).sort((a, b) => a.start - b.start);
    for (const m of ms) {
      if (sensitive(f, m.start, m.end)) continue; // graphic or private: not for Shorts
      const score = (m.importance || 1) * 2 + (KIND[m.kind] || 1) + (m.quote ? 1 : 0) + Math.min(2, talk(f, m.start, m.end));
      cands.push({ f, m, ms, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const picked = [];
  const perFile = new Map();
  const used = [];
  // first round: at most 2 per file, so the Shorts cover different recordings; then fill up
  for (const limit of [2, Infinity]) for (const cd of cands) {
    if (picked.length >= count) break;
    const { f, m, ms } = cd;
    if ((perFile.get(f.id) || 0) >= limit || picked.some(p => p.from === cd)) continue;
    // grow the moment to at least 30 seconds: join the moments right after it, then add a little around it
    let a = m.start, b = m.end;
    for (const n of ms) if (n.start > m.start && n.start <= b + 6 && b - a < MIN && !sensitive(f, n.start, n.end)) b = Math.max(b, Math.min(n.end, a + MAX));
    if (b - a < MIN) { const need = MIN - (b - a); a = Math.max(0, a - need * 0.3); b = Math.min(f.duration || b + need, b + need * 0.7 + 2); }
    if (b - a > MAX) b = a + MAX;
    // start and end on whole sentences (stays within 62 seconds)
    const w = await wholeSentences(f, a, b).catch(() => ({ start: a, end: b }));
    if (w.end - w.start <= MAX + 2) { a = w.start; b = w.end; }
    if (b - a < MIN - 5 || sensitive(f, a, b)) continue;
    if (used.some(u => u.f === f.id && u.a < b && u.b > a)) continue; // overlaps a Short already picked
    used.push({ f: f.id, a, b });
    perFile.set(f.id, (perFile.get(f.id) || 0) + 1);
    const quote = String(m.quote || '').trim();
    picked.push({
      from: cd,
      id: uid(),
      title: m.title || 'Short',
      why: `${m.kind ? m.kind[0].toUpperCase() + m.kind.slice(1) : 'Key'} moment, importance ${m.importance || '?'}/5${quote ? ', with a strong line' : ''}.`,
      hook: quote && quote.length <= 90 ? `"${quote}"` : m.title || '',
      intro: '',
      introDraft: m.description || '',
      clips: [{ id: uid(), type: 'clip', file: f.id, start: Math.round(a * 10) / 10, end: Math.round(b * 10) / 10, label: m.title || '' }],
      frame: { mode: 'big' },
      narr: {},
    });
  }
  return picked.map(({ from, ...sh }) => sh);
}

// ---------- the list ----------
export function renderShorts() {
  const c = X.cur();
  if (!c) return;
  const list = shorts(c);
  const casePhotos = c.files.filter(f => f.type === 'photo');
  $('shortsList').innerHTML = list.map((sh, i) => {
    const len = lengthOf(sh);
    const ok = len >= MIN && len <= MAX;
    return `<li class="short-card" data-sh="${sh.id}">
      <div class="short-head">
        <span class="mono muted">Short ${i + 1}</span>
        <input data-sf="title" value="${X.esc(sh.title || '')}" aria-label="Title">
        <span class="short-len ${ok ? 'ok' : 'bad'}" title="Shorts should be 30 to 60 seconds">${X.fmtH(len)}${ok ? '' : len < MIN ? ' · too short' : ' · too long'}</span>
      </div>
      ${sh.why ? `<div class="short-why muted small-text">${X.esc(sh.why)}</div>` : ''}
      <div class="short-fields">
        <label class="small-text">On-screen hook (first 4 seconds, top of the screen)<input data-sf="hook" value="${X.esc(sh.hook || '')}" placeholder="A short line that makes people stay"></label>
        <label class="small-text">Your intro to record (plays first, over the footage with its sound off)<textarea data-sf="intro" rows="3" placeholder="${X.esc(sh.introDraft ? 'Idea: ' + sh.introDraft : 'Leave empty for footage only')}">${X.esc(sh.intro || '')}</textarea>
        </label>
        <label class="small-text">Your ending to record (plays after the clip, over the footage that follows with its sound off)<textarea data-sf="outro" rows="3" placeholder="What happened next, in 2 or 3 sentences">${X.esc(sh.outro || '')}</textarea></label>
      </div>
      ${(sh.intro || '').trim() || (sh.outro || '').trim() ? `<div class="short-rec small-text muted">Record the intro and the ending in one go (one audio file, with a short pause between them), then upload it in "Preview and export": the app finds where each part is. <button class="btn ghost small" data-sa="copy" type="button">Copy both to record</button></div>` : ''}
      <details class="seg-vis short-media" ${(sh.startMedia || []).length ? 'open' : ''}><summary>Photos or videos at the start${(sh.startMedia || []).length ? ` (${sh.startMedia.length})` : ''}</summary>
        ${stripHtml(sh.startMedia || [], sh.id + '|startMedia', casePhotos, 'Shown first, before your intro. Photos 3.5 seconds each; videos play with their sound.', 0)}
      </details>
      ${sh.clips.map((k, j) => {
        const f = X.fileById(k.file);
        return `<div class="short-clip" data-k="${j}">
          <div class="sc-file muted">${X.esc(f ? f.path || f.name : 'missing file')}</div>
          Start <button class="btn ghost small" data-sa="nudge" data-edge="start" data-d="-5" type="button">−5s</button><button class="btn ghost small" data-sa="nudge" data-edge="start" data-d="-1" type="button">−1s</button>
          <input data-sk="start" value="${X.fmtH(k.start)}"><button class="btn ghost small" data-sa="nudge" data-edge="start" data-d="1" type="button">+1s</button><button class="btn ghost small" data-sa="nudge" data-edge="start" data-d="5" type="button">+5s</button>
          &nbsp; End <button class="btn ghost small" data-sa="nudge" data-edge="end" data-d="-5" type="button">−5s</button><button class="btn ghost small" data-sa="nudge" data-edge="end" data-d="-1" type="button">−1s</button>
          <input data-sk="end" value="${X.fmtH(k.end)}"><button class="btn ghost small" data-sa="nudge" data-edge="end" data-d="1" type="button">+1s</button><button class="btn ghost small" data-sa="nudge" data-edge="end" data-d="5" type="button">+5s</button>
          <button class="btn ghost small" data-sa="sentence" type="button">Finish the sentence</button>
          <button class="btn ghost small" data-sa="faces" type="button">${X.blurredIn(f, k.start, k.end) ? 'Blurred faces (' + X.blurredIn(f, k.start, k.end) + ')' : 'Blur faces'}</button>
          ${f && f.transcript ? `<button class="btn ghost small" data-sa="lines" type="button">${editLines.has(k.id) ? 'Done editing lines' : 'Edit lines (who said what)'}</button>` : ''}
          ${sh.clips.length > 1 ? '<button class="btn ghost small" data-sa="delclip" type="button" title="Remove this clip">✕</button>' : ''}
          ${f && editLines.has(k.id) ? `<div class="tl-box short-lines" data-lines-for="${f.id}">${linesHtml(f, linesBetween(f, k.start, k.end))}</div>` : ''}
        </div>`;
      }).join('')}
      <details class="seg-vis short-media" ${(sh.endMedia || []).length ? 'open' : ''}><summary>Photos or videos at the end${(sh.endMedia || []).length ? ` (${sh.endMedia.length})` : ''}</summary>
        ${stripHtml(sh.endMedia || [], sh.id + '|endMedia', casePhotos, 'Shown after the clip. Photos 3.5 seconds each; videos play with their sound.', 0)}
      </details>
      <div class="short-actions">
        <button class="btn primary" data-sa="open" type="button">Preview and export</button>
        <button class="btn ghost" data-sa="delete" type="button">Delete</button>
      </div>
    </li>`;
  }).join('');
  $('shortsNote').textContent = list.length ? `${list.length} Short${list.length === 1 ? '' : 's'}.` : '';
  $('shortsIntros').classList.toggle('hidden', !list.length);
  fillThumbs($('shortsList'), list.flatMap(sh => [...(sh.startMedia || []), ...(sh.endMedia || [])]));
}

// ---------- intros to record ----------
function clipText(f, a, b) {
  const names = X.speakerMap(f);
  return linesBetween(f, a, b).map(({ u }) => `${names[u.sp] || 'Speaker ' + u.sp}: ${u.text}`).join('\n');
}
async function writeIntros() {
  const c = X.cur();
  const list = shorts(c);
  const todo = list.filter(sh => !(sh.intro || '').trim() || !(sh.outro || '').trim());
  const which = todo.length ? todo : list;
  if (!todo.length && !confirm('Every Short already has an intro and an ending. Write new ones for all of them? (Your current ones are replaced.)')) return;
  const b = $('shortsIntros'); b.disabled = true; b.textContent = 'Writing the narration…';
  try {
    const body = {
      title: c.title, context: X.contextText(c),
      shorts: which.map(sh => ({ id: sh.id, title: sh.title, description: sh.introDraft || sh.why || '', transcript: sh.clips.map(k => { const f = X.fileById(k.file); return f ? clipText(f, k.start, k.end) : ''; }).join('\n') })),
    };
    const r = await X.api('case/short-intros', body);
    let n = 0;
    for (const sh of which) {
      const x = r.intros && r.intros[sh.id];
      if (!x) continue;
      // fills what's empty (or everything, when rewriting all)
      const all = !todo.length;
      if (x.intro && (all || !(sh.intro || '').trim())) sh.intro = x.intro;
      if (x.outro && (all || !(sh.outro || '').trim())) sh.outro = x.outro;
      sh.edited = true; n++;
    }
    await X.save();
    renderShorts();
    if (X.refreshUsage) X.refreshUsage();
    if (!n) alert('Nothing came back. Try again in a moment.');
  } catch (e) { alert('Writing the narration failed: ' + e.message); }
  finally { b.disabled = false; b.textContent = 'Write narration scripts'; }
}

const parseTime = v => { const p = String(v).trim().split(':').map(Number); return p.some(isNaN) ? null : p.reduce((a, b) => a * 60 + b, 0); };

// the Short and the list (startMedia / endMedia) a photo/video strip belongs to
function stripOf(el) {
  const box = el.closest('[data-scope]');
  if (!box) return null;
  const [id, field] = box.dataset.scope.split('|');
  const sh = shorts(X.cur()).find(x => x.id === id);
  if (!sh) return null;
  sh[field] = sh[field] || [];
  return { sh, items: sh[field], box };
}

function wire() {
  $('shortsIntros').addEventListener('click', writeIntros);
  $('shortsList').addEventListener('change', async e => {
    if (e.target.closest('[data-tl]')) {
      const f = X.fileById(e.target.closest('[data-lines-for]').dataset.linesFor);
      if (f && await applyLineEdit(e, f)) renderShorts();
      return;
    }
    if (!e.target.matches('[data-media-add], [data-case-photo], [data-media-replace]')) return;
    const st = stripOf(e.target);
    if (!st) return;
    const c = X.cur();
    const statusEl = st.box.querySelector('[data-status]');
    const onStatus = t => { if (statusEl) statusEl.textContent = t; };
    if (e.target.matches('[data-media-replace]')) {
      const files = [...e.target.files]; e.target.value = '';
      const k = st.items.findIndex(x => x.id === e.target.dataset.mediaReplace);
      if (!files.length || k < 0) return;
      onStatus('Adding…');
      const { items, skipped } = await addFiles(c.id, files, onStatus);
      if (items[0]) st.items[k] = items[0];
      if (skipped.length) alert(`This could not be used: ${skipped.join(', ')}`);
    } else if (e.target.matches('[data-media-add]')) {
      const files = [...e.target.files]; e.target.value = '';
      onStatus('Adding…');
      const { items, skipped } = await addFiles(c.id, files, onStatus);
      st.items.push(...items);
      if (skipped.length) alert(`These were skipped (photos: JPG, PNG, WEBP; videos: MP4, MOV): ${skipped.join(', ')}`);
    } else {
      const f = X.fileById(e.target.value); e.target.value = '';
      if (f) st.items.push(casePhotoItem(f));
    }
    st.sh.edited = true;
    await X.save();
    renderShorts();
  }, true);
  $('shortsList').addEventListener('click', async e => {
    if (e.target.closest('[data-tl="split"], [data-tl="del"]')) {
      const f = X.fileById(e.target.closest('[data-lines-for]').dataset.linesFor);
      if (f && await applyLineEdit(e, f)) renderShorts();
      return;
    }
    const mb = e.target.closest('[data-media]');
    if (!mb) return;
    e.stopPropagation();
    const st = stripOf(mb);
    if (!st) return;
    const k = st.items.findIndex(x => x.id === mb.dataset.item);
    if (k < 0) return;
    if (mb.dataset.media === 'trim') return openTrim(st.items[k], 0, async () => { await X.save(); renderShorts(); });
    if (mb.dataset.media === 'del') st.items.splice(k, 1);
    else if (mb.dataset.media === 'left' && k > 0) [st.items[k - 1], st.items[k]] = [st.items[k], st.items[k - 1]];
    else if (mb.dataset.media === 'right' && k < st.items.length - 1) [st.items[k + 1], st.items[k]] = [st.items[k], st.items[k + 1]];
    st.sh.edited = true;
    await X.save();
    renderShorts();
  }, true);
  $('shortsFind').addEventListener('click', async () => {
    const c = X.cur();
    if (!c) return;
    const kept = shorts(c).filter(sh => sh.edited);
    if (shorts(c).length > kept.length && !confirm(`Replace the suggested Shorts you haven't changed yet? (${kept.length} you edited stay.)`)) return;
    $('shortsFind').disabled = true; $('shortsNote').textContent = 'Looking through the moments…';
    try {
      const found = await findMoments(c, +$('shortsCount').value);
      const fresh = found.filter(n => !kept.some(k => k.clips.some(a => n.clips.some(b => a.file === b.file && a.start < b.end && a.end > b.start))));
      c.shorts = kept.concat(fresh);
      await X.save();
      renderShorts();
      if (!found.length) alert('No moments were found. Analyze the case videos first (Files tab).');
    } finally { $('shortsFind').disabled = false; }
  });
  const list = $('shortsList');
  const at = e => {
    const li = e.target.closest('[data-sh]');
    const sh = li && shorts(X.cur()).find(x => x.id === li.dataset.sh);
    const row = e.target.closest('[data-k]');
    return { sh, k: sh && row ? sh.clips[+row.dataset.k] : null };
  };
  list.addEventListener('input', e => {
    const { sh } = at(e);
    const f = e.target.dataset.sf;
    if (!sh || !f) return;
    sh[f] = e.target.value; sh.edited = true;
    clearTimeout(list._t); list._t = setTimeout(() => X.save(), 600);
    if (f === 'intro' || f === 'outro') { const b = e.target.closest('.short-card').querySelector('.short-len'); const len = lengthOf(sh); b.textContent = X.fmtH(len); }
  });
  list.addEventListener('change', async e => {
    const { sh, k } = at(e);
    const key = e.target.dataset.sk;
    if (!sh || !k || !key) return;
    const t = parseTime(e.target.value);
    if (t == null) return renderShorts();
    k[key] = t;
    if (k.end <= k.start + 1) k.end = k.start + 1;
    sh.edited = true;
    await X.save(); renderShorts();
  });
  list.addEventListener('click', async e => {
    const b = e.target.closest('[data-sa]');
    if (!b) return;
    const c = X.cur();
    const { sh, k } = at(e);
    if (!sh) return;
    const act = b.dataset.sa;
    if (act === 'open') return X.openShort(sh);
    if (act === 'copy') {
      const text = [sh.intro, sh.outro].map(x => (x || '').trim()).filter(Boolean).join('\n\n');
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy both to record'; }, 1500); } catch (e) { alert(text); }
      return;
    }
    if (act === 'delete') {
      if (!confirm(`Delete "${sh.title}"?`)) return;
      c.shorts = shorts(c).filter(x => x !== sh);
    } else if (act === 'nudge' && k) {
      const f = X.fileById(k.file);
      const d = +b.dataset.d;
      if (b.dataset.edge === 'start') k.start = Math.max(0, Math.min(k.end - 1, k.start + d));
      else k.end = Math.max(k.start + 1, Math.min((f && f.duration) || Infinity, k.end + d));
    } else if (act === 'sentence' && k) {
      const f = X.fileById(k.file);
      if (!f) return;
      const n = await wholeSentences(f, k.start, k.end);
      if (n.start === k.start && n.end === k.end) return alert('This clip already starts and ends on a whole sentence.');
      k.start = n.start; k.end = n.end;
    } else if (act === 'faces' && k) {
      const f = X.fileById(k.file);
      if (f) X.openFaces(f, k.start, k.end);
      return;
    } else if (act === 'lines' && k) {
      if (editLines.has(k.id)) editLines.delete(k.id); else editLines.add(k.id);
      return renderShorts();
    } else if (act === 'delclip' && k) {
      sh.clips = sh.clips.filter(x => x !== k);
    } else return;
    sh.edited = true;
    await X.save();
    renderShorts();
  });
}
