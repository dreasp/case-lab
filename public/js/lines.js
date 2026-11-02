// Fixing who said what and the words of transcript lines. Used on the Story tab (per clip) and in
// the final preview (the lines around a caption). Edits go into the file's transcript, so every
// caption, clip and the file viewer use them.

import { getWords, splitTime } from './words.js';

let X = null;
export function initLines(helpers) { X = helpers; }

const utts = f => (f && f.transcript && f.transcript.utterances) || [];

// Lines of a file overlapping a stretch of time (seconds in the file), with their index
export const linesBetween = (f, a, b) => utts(f).map((u, i) => ({ u, i })).filter(x => x.u.e > a && x.u.s < b);

export function linesHtml(f, rows, focusAt = null) {
  const names = X.speakerMap(f);
  const letters = [...new Set([...utts(f).map(u => u.sp), ...Object.keys(f.speakerNames || {})])];
  const opts = sp => letters.map(l => `<option value="${X.esc(l)}" ${l === sp ? 'selected' : ''}>${X.esc(names[l] || 'Speaker ' + l)}</option>`).join('') + '<option value="__new">+ Someone else…</option>';
  if (!rows.length) return '<span class="muted">No speech here.</span>';
  return `<div class="tl-help muted small-text">Fix who is speaking and what they say. To give part of a line to someone else: click in the text where they start talking, click "Split here", then pick the speaker for the new line. Changes apply to this file everywhere (captions, transcript).</div>` +
    rows.map(({ u, i }) => `<div class="tl-line ${focusAt != null && u.s <= focusAt && u.e >= focusAt ? 'tl-focus' : ''}" data-u="${i}">
      <span class="mono small-text muted">${X.fmtH(u.s)}</span>
      <select data-tl="sp">${opts(u.sp)}</select>
      <textarea data-tl="text" rows="${Math.min(5, Math.max(1, Math.ceil(u.text.length / 90)))}">${X.esc(u.text)}</textarea>
      <div class="tl-btns"><button class="btn ghost small" data-tl="split" type="button" title="Split this line where the text cursor is">Split here</button><button class="btn ghost small" data-tl="del" type="button" title="Delete this line">✕</button></div>
    </div>`).join('');
}

// Handles a change or click inside the line editor. Returns true when the transcript changed.
export async function applyLineEdit(e, f) {
  const el = e.target.closest('[data-tl]');
  const utt = utts(f);
  const row = el && el.closest('.tl-line');
  if (!el || !row || !utt.length) return false;
  const i = +row.dataset.u, u = utt[i];
  if (!u) return false;
  const act = el.dataset.tl;
  if (e.type === 'change' && act === 'sp') {
    if (el.value === '__new') {
      const name = (prompt('Who is speaking? (for example "911 Operator" or "Witness 3")') || '').trim();
      if (!name) { el.value = u.sp; return false; }
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
    if (!a || !b) { alert('First click in the text exactly where the other person starts talking, then click "Split here".'); return false; }
    const wa = a.split(/\s+/).length, wb = b.split(/\s+/).length;
    // exact time the other person starts talking (from the word timing), or an estimate
    const exact = splitTime(u, a, b, await getWords(X.cur(), f), utt.slice(Math.max(0, i - 3), i), utt.slice(i + 1, i + 4));
    const t = exact != null && exact > u.s && exact < u.e ? exact : u.s + (u.e - u.s) * wa / (wa + wb);
    utt.splice(i + 1, 0, { ...u, s: Math.round(t * 100) / 100, text: b });
    u.e = Math.round(t * 100) / 100; u.text = a;
  } else if (e.type === 'click' && act === 'del') {
    if (!confirm('Delete this line from the transcript?')) return false;
    utt.splice(i, 1);
  } else return false;
  f.transcriptEdited = true;
  await X.save();
  return true;
}
