// B-roll builder: your own photos and videos.
// You upload and name them, Gemini (or you) places each one at a sentence, and you can trim
// which part plays. A placed file covers the narration from its start for as long as you set,
// even across several sentences; the stock shots underneath fill whatever it doesn't cover.
//
// project.own    = [{ id, key, type: 'video'|'photo', name, dur, w, h }]
// project.placed = [{ id, own, sid, off, from, len, frames }]   (starts at sentence sid's start + off)

const $ = id => document.getElementById(id);
let X = null;
const ACCEPT = 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm';
const MIN_LEN = 0.5;   // a piece shorter than this is merged into its neighbour

export const ownOf = (p, id) => (p.own || []).find(o => o.id === id);
const senOf = (p, sid) => (p.sentences || []).find(s => s.id === sid);
export const placeStart = (p, pl) => { const s = senOf(p, pl.sid); return s ? s.start + (pl.off || 0) : 0; };

// The same choice object for a file every time, so the player keeps it loaded
const choices = new Map();
function choiceFor(o) {
  const c = choices.get(o.key);
  if (c && c.name === o.name && c.type === o.type) return c;
  const n = { custom: o.key, key: o.key, type: o.type, name: o.name, source: 'Your file', auto: false };
  choices.set(o.key, n);
  return n;
}

// Placements in time order, without overlaps, clipped to the narration
export function placedRanges(p) {
  const dur = p.duration || 0;
  const list = (p.placed || []).map(pl => ({ pl, o: ownOf(p, pl.own), at: placeStart(p, pl) }))
    .filter(x => x.o).sort((a, b) => a.at - b.at);
  const out = [];
  let prevEnd = 0;
  for (const x of list) {
    const at = Math.max(x.at, prevEnd);
    const end = Math.min(dur, at + Math.max(0, x.pl.len || 0));
    if (end - at < 0.3) continue;
    out.push({ ...x, at, end });
    prevEnd = end;
  }
  return out;
}

// What actually plays: the stock shots with your files cut in on top
export function timeline(p) {
  const shots = p.shots || [];
  const cover = placedRanges(p);
  const segs = [];
  shots.forEach((shot, bi) => {
    let pieces = [[shot.start, shot.end]];
    for (const c of cover) {
      if (c.end <= shot.start || c.at >= shot.end) continue;
      pieces = pieces.flatMap(([a, b]) => {
        const r = [];
        if (c.at > a) r.push([a, Math.min(b, c.at)]);
        if (c.end < b) r.push([Math.max(a, c.end), b]);
        return r.filter(([x, y]) => y - x > 0.001);
      });
    }
    for (const [a, b] of pieces) {
      const whole = a === shot.start && b === shot.end;
      const video = shot.choice && shot.choice.type === 'video';
      segs.push({
        id: whole ? shot.id : `${shot.id}~${Math.round(a * 100)}`,
        start: a, end: b, choice: shot.choice, sid: shot.sid, part: shot.part, base: bi,
        edit: whole || !video ? shot.edit : { ...(shot.edit || {}), start: ((shot.edit && shot.edit.start) || 0) + (a - shot.start) },
      });
    }
  });
  for (const c of cover) {
    segs.push({
      id: 'pl' + c.pl.id, start: c.at, end: c.end, choice: choiceFor(c.o), place: c.pl.id, sid: c.pl.sid,
      edit: { start: c.o.type === 'video' ? (c.pl.from || 0) : 0, frames: c.pl.frames || {}, hold: true },
    });
  }
  segs.sort((a, b) => a.start - b.start);
  // tiny leftovers (a stock shot squeezed to a few frames) join the piece before them
  const out = [];
  for (const s of segs) {
    if (s.end - s.start < MIN_LEN && out.length) { out[out.length - 1] = { ...out[out.length - 1], end: s.end }; continue; }
    if (out.length && out[out.length - 1].end - out[out.length - 1].start < MIN_LEN) { s.start = out.pop().start; }
    out.push(s);
  }
  return out;
}

// Room for a placement starting at `at`: until the next placement or the end of the narration
export function roomAt(p, at, ignoreId) {
  let lim = p.duration || 0;
  for (const r of placedRanges(p)) if (r.pl.id !== ignoreId && r.at > at - 0.01 && r.at < lim) lim = r.at;
  return Math.max(0, lim - at);
}
const sentenceAt = (p, t) => p.sentences.find(s => t >= s.start - 0.01 && t < s.end) || p.sentences[p.sentences.length - 1];

// Put a file at time t (moved past any file already there); returns the placement or null
export function placeAt(p, o, t, sidHint) {
  for (const r of placedRanges(p)) if (t >= r.at - 0.01 && t < r.end) t = r.end;
  const sen = (sidHint && senOf(p, sidHint) && t < senOf(p, sidHint).end ? senOf(p, sidHint) : null) || sentenceAt(p, t);
  if (!sen) return null;
  const room = roomAt(p, t);
  if (room < 1) return null;
  const want = Math.max(3, sen.end - t);
  const len = Math.min(room, o.type === 'video' && o.dur ? Math.min(o.dur, want) : want);
  const pl = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), own: o.id, sid: sen.id, off: Math.max(0, t - sen.start), from: 0, len };
  (p.placed = p.placed || []).push(pl);
  return pl;
}

// Move a placement to the start of the previous / next sentence
export function movePlaced(p, plId, dir) {
  const pl = (p.placed || []).find(x => x.id === plId);
  if (!pl) return false;
  const at = placeStart(p, pl);
  const i = p.sentences.findIndex(s => s.id === pl.sid);
  let target;
  if (dir < 0) target = (pl.off || 0) > 0.05 ? p.sentences[i] : p.sentences[i - 1];
  else target = p.sentences[i + 1];
  if (!target) return false;
  let t = target.start;
  for (const r of placedRanges(p)) if (r.pl.id !== plId && t >= r.at - 0.01 && t < r.end) t = dir < 0 ? null : r.end;
  if (t == null || t === at) return false;
  const sen = sentenceAt(p, t);
  pl.sid = sen.id; pl.off = Math.max(0, t - sen.start);
  pl.len = Math.min(pl.len, Math.max(MIN_LEN, roomAt(p, t, plId)));
  return true;
}

// ---------- the "Your photos and videos" panel ----------
export function initOwn(helpers) {
  X = helpers;
  $('ownAdd').accept = ACCEPT;
  $('ownAdd').addEventListener('change', e => { const files = [...e.target.files]; e.target.value = ''; addFiles(files); });
  const box = $('ownBox');
  box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('over'); });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', e => { e.preventDefault(); box.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  $('ownPlace').addEventListener('click', () => placeFiles(true));
  $('ownList').addEventListener('input', e => {
    const id = e.target.dataset.ownName;
    if (!id) return;
    const o = ownOf(X.project(), id);
    if (o) { o.name = e.target.value; clearTimeout(box._t); box._t = setTimeout(() => { X.save(); X.changed(false); }, 700); }
  });
  $('ownList').addEventListener('click', async e => {
    const b = e.target.closest('button[data-own]');
    if (!b) return;
    const p = X.project();
    const o = ownOf(p, b.dataset.id);
    if (!o) return;
    if (b.dataset.own === 'here') {
      const seg = X.selectedSeg();
      if (!seg) return alert('Click a shot in the list below first, then click this button.');
      if (!placeAt(p, o, seg.start, seg.sid)) return alert('There is no room there: another of your files already covers that spot. Pick a different shot.');
    } else if (b.dataset.own === 'show') {
      const r = placedRanges(p).find(x => x.o.id === o.id);
      if (r) X.goTo(r.at);
      return;
    } else if (b.dataset.own === 'del') {
      const n = (p.placed || []).filter(x => x.own === o.id).length;
      if (!confirm(`Delete "${o.name}"${n ? ' and take it out of the script' : ''}?`)) return;
      p.placed = (p.placed || []).filter(x => x.own !== o.id);
      p.own = p.own.filter(x => x.id !== o.id);
      const usedElsewhere = (p.shots || []).some(s => s.choice && s.choice.custom === o.key);
      if (!usedElsewhere) X.deleteFile(o.key).catch(() => {});
    }
    await X.save();
    X.changed(true);
  });
}

async function addFiles(files) {
  const p = X.project();
  if (!p || !files.length) return;
  const status = $('ownStatus');
  p.own = p.own || [];
  let added = 0;
  for (const [k, f] of files.entries()) {
    const video = f.type.startsWith('video') || /\.(mp4|mov|m4v|webm)$/i.test(f.name);
    const photo = f.type.startsWith('image');
    if (!video && !photo) continue;
    status.textContent = `Adding ${k + 1} of ${files.length}…`;
    let info = { ok: true };
    if (video) {
      info = await X.probeVideo(f);
      if (!info.ok) { alert(`Chrome can't play "${f.name}" (probably HEVC or ProRes). Convert it to MP4 (H.264) and add it again.`); continue; }
    } else info = await imageSize(f);
    const key = `${p.id}:u:${X.fileId(f)}`;
    if (p.own.some(o => o.key === key)) continue;
    if (!(await X.getFile(key))) {
      status.textContent = `Saving ${f.name}…`;
      try {
        const where = await X.putFileSafe(key, f);
        if (where === 'cloud') status.textContent = `${f.name} is saved in the cloud (Chrome had no room to keep a copy on this computer).`;
      } catch (e) { alert(`"${f.name}" could not be saved: ${e.message}`); continue; }
    }
    p.own.push({
      id: Date.now().toString(36) + k, key, type: video ? 'video' : 'photo',
      name: f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim(),
      dur: video ? info.d || 0 : 0, w: info.w || 0, h: info.h || 0,
    });
    added++;
  }
  status.textContent = added ? `Added ${added}. Give each one a clear name. "Find footage automatically" places them for you (or click "Place them in the script").` : '';
  await X.save();
  X.changed(false);
}

function imageSize(f) {
  return new Promise(res => {
    const u = URL.createObjectURL(f), img = new Image();
    img.onload = () => { res({ ok: true, w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(u); };
    img.onerror = () => { res({ ok: true }); URL.revokeObjectURL(u); };
    img.src = u;
  });
}

export const unplacedOwn = p => (p.own || []).filter(o => !(p.placed || []).some(x => x.own === o.id));

// Puts the files that aren't in the script yet where they fit. interactive: from the button (asks and
// alerts); otherwise it runs quietly at the start of "Find footage automatically" and returns a note.
export async function placeFiles(interactive) {
  const p = X.project();
  const todo = unplacedOwn(p);
  if (!todo.length) { if (interactive) alert((p.own || []).length ? 'All your files are already in the script. To move one, use the arrows on it in the shot list.' : 'Add some photos or videos first.'); return ''; }
  const unnamed = todo.filter(o => !o.name.trim() || /^(img|dsc|vid|pxl|screenshot|whatsapp)\b|^\d+$/i.test(o.name.trim()));
  if (interactive && unnamed.length && !confirm(`${unnamed.length} file(s) still have camera-style names (like "${unnamed[0].name}"). The app places files by their names, so clear names work much better.\n\nPlace them anyway?`)) return '';
  const btn = $('ownPlace'), status = $('ownStatus');
  btn.disabled = true; status.textContent = 'Gemini is reading the script…';
  try {
    const r = await X.api('place', {
      title: p.title,
      sentences: p.sentences.map(s => ({ id: s.id, start: s.start, text: s.text })),
      items: todo.map(o => ({ id: o.id, name: o.name, type: o.type, dur: o.dur })),
    });
    const placed = [], missed = [];
    const order = todo.map(o => ({ o, r: r.placements[o.id] })).filter(x => x.r)
      .map(x => ({ ...x, sen: senOf(p, x.r.sentence) })).filter(x => x.sen).sort((a, b) => a.sen.start - b.sen.start);
    for (const x of order) (placeAt(p, x.o, x.sen.start, x.sen.id) ? placed : missed).push(x.o.name);
    for (const o of todo) if (!order.some(x => x.o === o)) missed.push(o.name);
    await X.save();
    X.changed(true);
    if (X.refreshUsage) X.refreshUsage();
    const note = `Placed ${placed.length} of your ${todo.length} file(s).` + (missed.length ? ` Not placed (no room or no match): ${missed.join(', ')}. Click a shot and use "Put at selected shot".` : ' Check them in the shot list (marked "Your file").');
    status.textContent = note;
    return note;
  } catch (e) {
    status.textContent = 'Placing failed: ' + e.message;
    if (!interactive) return 'Your files were not placed: ' + e.message;
    return '';
  } finally { btn.disabled = false; }
}

const fmt1 = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };

export async function renderOwn() {
  const p = X.project();
  if (!p) return;
  const own = p.own || [];
  const ranges = placedRanges(p);
  $('ownCount').textContent = own.length ? `(${own.length}, ${own.filter(o => ranges.some(r => r.o.id === o.id)).length} in the script)` : '';
  $('ownPlace').disabled = !own.length;
  $('ownList').innerHTML = own.map(o => {
    const r = ranges.find(x => x.o.id === o.id);
    return `<li class="own-item">
      <div class="own-thumb" data-own-thumb="${o.id}"></div>
      <div class="own-body">
        <input data-own-name="${o.id}" value="${X.esc(o.name)}" placeholder="What does it show? (e.g. Danielle Smith school photo)" aria-label="Name">
        <div class="small-text muted">${o.type === 'video' ? `video · ${fmt1(o.dur)}` : 'photo'} · ${r ? `<span class="own-in">in the script at ${fmt1(r.at)}</span>` : 'not in the script yet'}</div>
      </div>
      <div class="own-btns">
        ${r ? `<button class="btn ghost small" type="button" data-own="show" data-id="${o.id}">Show</button>` : ''}
        <button class="btn ghost small" type="button" data-own="here" data-id="${o.id}" title="Put it at the shot selected in the list below">Put at selected shot</button>
        <button class="btn ghost small" type="button" data-own="del" data-id="${o.id}" title="Delete">✕</button>
      </div>
    </li>`;
  }).join('');
  for (const el of $('ownList').querySelectorAll('[data-own-thumb]')) {
    const o = ownOf(p, el.dataset.ownThumb);
    let u = null;
    for (let k = 0; k < 6 && !u && o; k++) {
      u = await X.urlFor(o.key).catch(() => null);
      if (!u && k < 5) { el.textContent = 'Loading…'; await new Promise(r => setTimeout(r, 4000)); }
    }
    if (!u) { el.textContent = 'Still uploading or not found'; continue; }
    el.innerHTML = o.type === 'video' ? `<video src="${u}#t=0.5" muted preload="metadata"></video>` : `<img src="${u}" alt="">`;
  }
}
