// Your own photos and videos added to a story scene (shared by the Story and Final video tabs).
// Items: { id, kind: 'photo' | 'video', name, key (uploaded, saved with the case) | caseFile (a case photo) }

let X = null;
const IMG = /\.(jpe?g|png|webp|gif)$/i;
const VID = /\.(mp4|mov|m4v)$/i;
const urlCache = new Map();
const session = new Map(); // item id -> the file itself, for everything added in this session

export function initMedia(helpers) { X = helpers; }

const newId = () => Math.random().toString(36).slice(2, 10);

// Can Chrome show this video? (some .mp4/.mov files use older formats it can't play)
function playable(blob) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto';
    const u = URL.createObjectURL(blob);
    const done = ok => { clearTimeout(timer); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(u); resolve(ok); };
    const timer = setTimeout(() => done(false), 6000);
    v.onloadeddata = () => done(v.videoWidth > 0);
    v.onerror = () => done(false);
    v.src = u;
  });
}

// Saves picked files with the case; returns the new items (and names of files that can't be used)
// onStatus(text) shows progress while a video in an older format is converted.
export async function addFiles(caseId, files, onStatus = () => {}) {
  const items = [], skipped = [];
  for (const file of files) {
    const isImg = IMG.test(file.name) || /^image\//.test(file.type);
    const isVid = VID.test(file.name);
    if (!isImg && !isVid) { skipped.push(file.name); continue; }
    const id = newId();
    const key = `${caseId}:m:${id}`;
    // Read the file fully first: files in synced folders (OneDrive, Google Drive...) can't
    // always be read later, which made some thumbnails show "missing"
    let blob;
    try { blob = new Blob([await file.arrayBuffer()], { type: file.type || (isImg ? 'image/jpeg' : 'video/mp4') }); }
    catch (e) { skipped.push(`${file.name} (could not be read: if it's in a synced folder, make it available offline first)`); continue; }
    if (isVid && !(await playable(blob))) {
      // convert to a standard MP4 that plays everywhere (same picture, done in your browser)
      try {
        onStatus(`Converting "${file.name}" to a format Chrome can play…`);
        const { convertRange } = await import('./convert.js');
        blob = await convertRange(new File([blob], file.name, { type: blob.type }), 0, 36000, { video: true, onProgress: p => onStatus(`Converting "${file.name}" to a format Chrome can play… ${Math.round(p * 100)}%`) });
        if (!(await playable(blob))) throw new Error('still not playable');
      } catch (e) { skipped.push(`${file.name} (this video's format can't be played or converted; try exporting it again as an H.264 MP4)`); continue; }
      finally { onStatus(''); }
    }
    try { await X.putFileSafe(key, blob); }
    catch (e) { skipped.push(`${file.name} (could not be saved: ${e.message})`); continue; }
    session.set(id, blob);
    items.push({ id, kind: isImg ? 'photo' : 'video', name: file.name, key });
  }
  return { items, skipped };
}

export const casePhotoItem = f => ({ id: newId(), kind: 'photo', name: f.path || f.name, caseFile: f.id });

export async function mediaUrl(it) {
  if (urlCache.has(it.id)) return urlCache.get(it.id);
  let u = null;
  if (session.has(it.id)) u = URL.createObjectURL(session.get(it.id));
  else if (it.key) { const b = await X.getFile(it.key); if (b) u = URL.createObjectURL(b); }
  else if (it.caseFile) {
    const f = X.fileById(it.caseFile);
    const local = f ? await X.getLocalFile(f).catch(() => null) : null;
    if (local) u = URL.createObjectURL(local);
    else if (f && f.copyKey) u = (await X.signedUrls([f.copyKey]))[0] || null;
  }
  if (u) urlCache.set(it.id, u);
  return u;
}

export async function mediaBlob(it) {
  if (session.has(it.id)) return session.get(it.id);
  if (it.key) return X.getFile(it.key);
  const f = X.fileById(it.caseFile);
  if (!f) return null;
  const local = await X.getLocalFile(f).catch(() => null);
  if (local) return local;
  if (f.copyKey) { const [u] = await X.signedUrls([f.copyKey]); if (u) { const r = await fetch(u); if (r.ok) return r.blob(); } }
  return null;
}

// The thumbnails + add buttons. `scope` identifies the scene (its story segment id).
const secs = t => t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${Math.round(t)} seconds`;
export const PHOTO_SECS = 5; // a comfortable time for one photo on screen

// When each item is on screen: trimmed videos keep their chosen length, photos (and untrimmed
// videos) share the time that's left. Returns [{ t, d }] in seconds from the scene start.
export function slots(items, dur) {
  const fixed = items.reduce((a, it) => a + (it.kind === 'video' && it.len ? it.len : 0), 0);
  const flex = items.filter(it => !(it.kind === 'video' && it.len)).length;
  const share = flex ? Math.max(1, (dur - fixed) / flex) : 0;
  let t = 0;
  const out = items.map(it => { const d = it.kind === 'video' && it.len ? it.len : share; const r = { t, d }; t += d; return r; });
  // nothing flexible and the trimmed videos are shorter than the scene: the last one holds its last frame
  if (out.length && t < dur) out[out.length - 1].d += dur - t;
  return out.filter(x => x.t < dur).map(x => ({ t: x.t, d: Math.min(x.d, dur - x.t) }));
}

// How many photos/videos a scene needs, and how long each one stays on screen
export function lengthNote(items, dur) {
  if (!dur) return '';
  const rec = Math.max(1, Math.round(dur / PHOTO_SECS));
  if (!items.length) return `This scene is about ${secs(dur)}: ${rec === 1 ? '1 photo is' : `${rec} photos are`} enough (about ${PHOTO_SECS} seconds each), or one video of at least ${secs(dur)}.`;
  const fixed = items.reduce((a, it) => a + (it.kind === 'video' && it.len ? it.len : 0), 0);
  const flex = items.filter(it => !(it.kind === 'video' && it.len));
  const sl = slots(items, dur);
  let note = `This scene is about ${secs(dur)}.`;
  if (sl.length < items.length) return note + ` Your items add up to more than that, so the last ${items.length - sl.length} won't be shown: shorten a video or remove an item.`;
  if (fixed > dur + 0.2) return note + ` Your trimmed videos add up to ${fixed.toFixed(1)} s, so the last one is cut short.`;
  if (!flex.length && fixed < dur - 0.3) return note + ` Your trimmed videos add up to ${fixed.toFixed(1)} s: add a photo or video for the other ${(dur - fixed).toFixed(1)} s, or the last video holds its last frame.`;
  if (flex.length) {
    const each = Math.max(1, (dur - fixed) / flex.length);
    note += fixed ? ` Your trimmed video${items.length - flex.length > 1 ? 's take' : ' takes'} ${fixed.toFixed(1)} s; the rest share ${Math.max(0, dur - fixed).toFixed(1)} s, about ${each.toFixed(1)} s each.` : ` Each of your ${items.length} item${items.length > 1 ? 's' : ''} stays on screen about ${each.toFixed(1)} s.`;
    if (each < 2.5) note += ' That is quick: fewer items would look calmer.';
    else if (!fixed && items.every(x => x.kind === 'photo') && items.length < rec) note += ` ${rec - items.length} more photo${rec - items.length > 1 ? 's' : ''} would make it about ${PHOTO_SECS} seconds each (optional).`;
    else note += ' That is enough.';
  } else note += ' That is enough.';
  return note;
}

const t1 = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
export function stripHtml(items, scope, casePhotos, hint, dur) {
  const esc = X.esc;
  const sl = dur ? slots(items, dur) : [];
  return `<div class="np-media" data-scope="${scope}">
    ${dur ? `<div class="np-length small-text">${esc(lengthNote(items, dur))}</div>` : ''}
    ${items.map((it, k) => `<div class="np-thumb" title="${esc(it.name)}">
      <div class="np-thumb-pic" data-thumb="${it.id}" data-slot="${sl[k] ? sl[k].d : 0}"></div><span class="np-num">${k + 1}</span>
      <div class="np-thumb-cap small-text" data-cap="${it.id}">${sl[k] ? `${sl[k].d.toFixed(1)} s on screen` : (dur ? 'Not shown: the scene is too short' : '')}${it.kind === 'video' && it.len ? ` · uses ${t1(it.from)} to ${t1((it.from || 0) + it.len)}` : ''}${it.kind === 'video' && it.muted ? ' · muted' : ''}</div>
      <div class="np-thumb-btns">
        ${k ? `<button class="btn ghost" type="button" data-media="left" data-item="${it.id}" title="Show earlier">←</button>` : ''}${k < items.length - 1 ? `<button class="btn ghost" type="button" data-media="right" data-item="${it.id}" title="Show later">→</button>` : ''}
        <label class="btn ghost" title="Swap in a different photo or video, keeping this spot">Replace<input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.mp4,.mov,.m4v" data-media-replace="${it.id}" hidden></label>
        ${it.kind === 'video' ? `<button class="btn ghost" type="button" data-media="trim" data-item="${it.id}" title="Choose which part to use and mute the sound">Trim / sound</button>` : ''}
        <button class="btn ghost" type="button" data-media="del" data-item="${it.id}" title="Remove">✕</button>
      </div>
    </div>`).join('')}
    <div class="np-media-add">
      <label class="btn small">+ Add photos or videos<input type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.mp4,.mov,.m4v" data-media-add hidden></label>
      ${casePhotos.length ? `<select data-case-photo><option value="">+ Add a photo from this case…</option>${casePhotos.map(f => `<option value="${f.id}">${esc(f.path || f.name)}</option>`).join('')}</select>` : ''}
      <span class="muted small-text np-status" data-status></span>
      <span class="muted small-text">${hint || ''}</span>
    </div>
  </div>`;
}

export async function fillThumbs(root, allItems) {
  for (const el of root.querySelectorAll('[data-thumb]')) {
    const it = allItems.find(x => x.id === el.dataset.thumb);
    if (!it || el.dataset.filled) continue;
    el.dataset.filled = '1';
    let u = null;
    // a file still on its way to the cloud can take a moment: try a few times
    for (let k = 0; k < 4 && !u; k++) {
      u = await mediaUrl(it).catch(() => null);
      if (!u && k < 3) { el.textContent = 'Loading…'; await new Promise(r => setTimeout(r, 2500)); }
    }
    if (!u) { el.innerHTML = '<span class="np-missing">Not found on this computer or in the cloud. Remove it (✕) and add it again.</span>'; continue; }
    el.innerHTML = it.kind === 'video' ? `<video src="${u}#t=0.5" muted preload="metadata"></video><span class="np-vid">▶</span>` : `<img src="${u}" alt="">`;
    // a video shorter than its turn on screen freezes on its last frame: say so
    const v = el.querySelector('video'), slot = +el.dataset.slot;
    if (v && slot && !it.len) v.addEventListener('loadedmetadata', () => {
      const cap = root.querySelector(`[data-cap="${it.id}"]`);
      const left = v.duration - (it.from || 0);
      if (cap && v.duration && left < slot - 0.3) { cap.textContent = `Video is ${left.toFixed(1)} s but shows ${slot.toFixed(1)} s: the last frame holds`; cap.classList.add('np-warn'); }
      else if (cap && v.duration) cap.textContent = `${slot.toFixed(1)} s on screen (video is ${v.duration.toFixed(1)} s)${it.muted ? ' · muted' : ''}`;
    }, { once: true });
  }
}

// Photos/videos used to be set on the Final video tab; they now belong to the scene itself
export function migrate(c) {
  const m = c && c.narr && c.narr.media;
  if (!m) return false;
  for (const s of (c.story && c.story.segments) || []) if (m[s.id] && m[s.id].length && !(s.media && s.media.length)) s.media = m[s.id];
  delete c.narr.media;
  return true;
}

// ---------- choosing the part of a video to use, and muting it ----------
const $ = id => document.getElementById(id);
const parseT = v => { const m = String(v || '').trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); return m ? (+m[1] || 0) * 60 + +m[2] : null; };

// Opens the trim window for a video item. sceneDur and otherSecs are for the guidance line.
export async function openTrim(it, sceneDur, onSave) {
  const v = $('trimVideo');
  const u = await mediaUrl(it);
  if (!u) return alert('This video could not be found.');
  v.src = u;
  $('trimName').textContent = it.name;
  $('trimMute').checked = !!it.muted;
  let start = it.from || 0, end = it.len ? (it.from || 0) + it.len : null;
  const show = () => {
    $('trimStart').value = t1(start);
    $('trimEnd').value = end == null ? '' : t1(end);
    $('trimLen').textContent = end == null ? `Using the video from ${t1(start)} for as long as the scene needs` : `Uses ${(end - start).toFixed(1)} s`;
    $('trimNote').textContent = sceneDur ? `This scene is about ${sceneDur.toFixed(1)} s long.` : '';
  };
  show();
  v.onloadedmetadata = () => { $('trimTotal').textContent = `Video length: ${t1(v.duration)}`; v.currentTime = start; };
  let stopAt = null;
  v.ontimeupdate = () => { if (stopAt != null && v.currentTime >= stopAt) { v.pause(); stopAt = null; } };
  $('trimSetStart').onclick = () => { start = v.currentTime; if (end != null && end <= start + 0.2) end = null; show(); };
  $('trimSetEnd').onclick = () => { if (v.currentTime <= start + 0.2) return alert('The end has to be after the start.'); end = v.currentTime; show(); };
  $('trimStart').onchange = () => { const t = parseT($('trimStart').value); if (t != null && (!v.duration || t < v.duration)) { start = t; if (end != null && end <= start + 0.2) end = null; v.currentTime = start; } show(); };
  $('trimEnd').onchange = () => { const t = parseT($('trimEnd').value); if ($('trimEnd').value.trim() === '') end = null; else if (t != null && t > start + 0.2) end = Math.min(t, v.duration || t); show(); };
  $('trimPlay').onclick = () => { v.currentTime = start; stopAt = end; v.muted = $('trimMute').checked; v.play().catch(() => {}); };
  $('trimWhole').onclick = () => { start = 0; end = null; show(); };
  $('trimSave').onclick = async () => {
    it.from = start;
    it.len = end == null ? null : Math.round((end - start) * 10) / 10;
    it.muted = $('trimMute').checked;
    $('trimDialog').close();
    await onSave();
  };
  $('trimClose').onclick = () => $('trimDialog').close();
  $('trimDialog').onclose = () => { v.pause(); v.removeAttribute('src'); v.load(); };
  $('trimDialog').showModal();
}
